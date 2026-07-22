import { mkdir } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { PluginContext, SlotRegistry } from "@opentui/core"
import { assertExtensionDefinition } from "@laziergit/runtime-bridge"
import type { ReactNode } from "react"
import type { CommandSpec, Disposable, EventMap, Extension, Theme } from "laziergit"

import { ActivationScope } from "./activation-scope"
import { CommandHost } from "./command-host"
import { createExtensionContext, type ContextHosts, type ExtensionApiLookup } from "./context"
import { Diagnostics, normalizeError, type DiagnosticPhase } from "./diagnostics"
import {
  defaultExtensionDirectories,
  discoverExtensions,
  extensionTreeFingerprint,
  type ExtensionCandidate,
  type ExtensionDirectories,
  type ExtensionDiscoveryFailure,
  type ExtensionDiscoveryResult,
  type ExtensionSourceScope,
} from "./discovery"
import { EventHost } from "./event-host"
import { GitPlaceholder } from "./git-placeholder"
import { ImportCopyCache, type ImportCopyLease } from "./import-copy-cache"
import { createNotifier } from "./notifier"
import { PaneHost, type PaneSlots } from "./pane-host"
import { MenuHost, StatuslineHost } from "./registry-hosts"
import { ThemeStore } from "./theme"

export type ExtensionLoadState = "loading" | "active" | "failed" | "shadowed"

export interface ExtensionStatus {
  readonly key: string
  readonly path: string
  readonly scope: "global" | "repo"
  readonly name?: string
  readonly state: ExtensionLoadState
  readonly message?: string
}

interface ImportedExtension {
  readonly candidate: ExtensionCandidate
  readonly extension: Extension
  readonly lease: ImportCopyLease
}

interface Activation {
  readonly imported: ImportedExtension
  readonly scope: ActivationScope
  readonly api: unknown
}

export interface ExtensionKernelOptions {
  readonly repoRoot: string
  readonly registry: SlotRegistry<ReactNode, PaneSlots, PluginContext>
  readonly directories?: ExtensionDirectories
  readonly watch?: boolean
  readonly debounceMs?: number
}

interface InternalRuntime {
  readonly git: GitPlaceholder
  readonly events: {
    subscribe<K extends keyof EventMap & string>(
      extension: string,
      event: K,
      handler: (payload: EventMap[K]) => void | Promise<void>,
    ): Disposable
  }
  readonly commands: {
    registerComponent(extension: string, paneId: string, spec: Omit<CommandSpec, "pane">): Disposable
  }
  readonly theme: {
    getSnapshot(): Theme
    subscribe(listener: () => void): () => void
  }
}

function candidateKey(candidate: ExtensionCandidate): string {
  return `${candidate.scope}:${candidate.rootPath}`
}

function failureKey(failure: ExtensionDiscoveryFailure): string {
  return `${failure.scope}:${failure.rootPath}`
}

function discoveryFailure(directory: string, scope: ExtensionSourceScope, error: unknown): ExtensionDiscoveryResult {
  return {
    candidates: [],
    failures: [
      {
        path: directory,
        rootPath: directory,
        scope,
        error: normalizeError(error),
      },
    ],
  }
}

export class ExtensionKernel {
  readonly diagnostics = new Diagnostics()
  readonly theme = new ThemeStore()
  readonly panes: PaneHost
  readonly events: EventHost
  readonly commands: CommandHost
  readonly git = new GitPlaceholder()
  readonly #menus = new MenuHost()
  readonly #statusline = new StatuslineHost()
  readonly #repoRoot: string
  readonly #directories: ExtensionDirectories
  readonly #watchEnabled: boolean
  readonly #debounceMs: number
  readonly #listeners = new Set<() => void>()
  readonly #activations = new Map<string, Activation>()
  readonly #notifier = createNotifier()
  readonly #importCopies: ImportCopyCache
  readonly runtime: InternalRuntime
  #activationOrder: string[] = []
  #snapshot: readonly ExtensionStatus[] = []
  #reloadGeneration = 0
  #reloadTimer: ReturnType<typeof setTimeout> | undefined
  #watchTimer: ReturnType<typeof setInterval> | undefined
  #watchFingerprint = ""
  #watchScan: Promise<void> | undefined
  #reloadTail: Promise<void> = Promise.resolve()
  #stopPromise: Promise<void> | undefined
  #stopped = false

  constructor(options: ExtensionKernelOptions) {
    this.#repoRoot = options.repoRoot
    this.#directories = options.directories ?? defaultExtensionDirectories(options.repoRoot)
    this.#watchEnabled = options.watch ?? true
    this.#debounceMs = options.debounceMs ?? 80

    this.panes = new PaneHost(options.registry, this.diagnostics)
    this.events = new EventHost(this.diagnostics)
    this.commands = new CommandHost(this.diagnostics, (id) => this.panes.focus(id), this.#notifier)
    this.#importCopies = new ImportCopyCache({
      directories: [this.#directories.global, this.#directories.repo],
      diagnose: (diagnostic) => {
        this.#diagnose({
          phase: diagnostic.phase,
          message: diagnostic.message,
          error: diagnostic.error,
        })
      },
    })
    this.runtime = {
      git: this.git,
      events: {
        subscribe: (extension, event, handler) => this.events.subscribe(extension, event, handler),
      },
      commands: {
        registerComponent: (extension, paneId, spec) => this.commands.registerComponent(extension, paneId, spec),
      },
      theme: this.theme,
    }

    this.panes.setFocusListener((paneId, previous) => {
      this.events.emit("app.pane.focused", { paneId, previous })
    })
  }

  getSnapshot = (): readonly ExtensionStatus[] => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async start(): Promise<void> {
    await Promise.all([
      mkdir(this.#directories.global, { recursive: true }),
      mkdir(this.#directories.repo, { recursive: true }),
    ])
    if (this.#stopped) return

    await this.#importCopies.sweepStale()
    if (this.#stopped) return

    await this.reload()
    if (this.#watchEnabled && !this.#stopped) await this.#startWatcher()
  }

  reload(): Promise<void> {
    const transaction = this.#reloadTail.then(() => this.#runReload())
    this.#reloadTail = transaction.then(
      () => undefined,
      () => undefined,
    )
    return transaction
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise

    this.#stopped = true
    if (this.#reloadTimer) {
      clearTimeout(this.#reloadTimer)
      this.#reloadTimer = undefined
    }
    if (this.#watchTimer) {
      clearInterval(this.#watchTimer)
      this.#watchTimer = undefined
    }

    this.#stopPromise = this.#stopNow()
    return this.#stopPromise
  }

  getExtensionApi(name: string): ExtensionApiLookup {
    const activation = this.#activations.get(name)
    return activation ? { state: "live", api: activation.api } : { state: "missing" }
  }

  async #runReload(): Promise<void> {
    if (this.#stopped) return
    try {
      await this.#reloadNow()
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "reload", message: normalized.message, error: normalized })
    }
  }

  async #reloadNow(): Promise<void> {
    if (this.#stopped) return

    const previousOwners = [...this.#activationOrder]
    this.panes.prepareReload(previousOwners)
    try {
      await this.#deactivateAll("reload")
      if (this.#stopped) return

      this.#publish(this.#snapshot.map((status) => ({ ...status, state: "loading" as const, message: undefined })))
      const imported = await this.#importAll()
      if (this.#stopped) {
        await Promise.all(imported.map((item) => item.lease.release()))
        return
      }

      const selected = await this.#selectByName(imported)
      if (this.#stopped) {
        await Promise.all([...selected.values()].map((item) => item.lease.release()))
        return
      }

      await this.#activateAll(selected)
    } finally {
      this.panes.finishReload(previousOwners)
    }
  }

  async #discover(directory: string, scope: ExtensionSourceScope): Promise<ExtensionDiscoveryResult> {
    try {
      return await discoverExtensions(directory, scope)
    } catch (error) {
      return discoveryFailure(directory, scope, error)
    }
  }

  async #importAll(): Promise<readonly ImportedExtension[]> {
    this.#reloadGeneration += 1
    const [global, repo] = await Promise.all([
      this.#discover(this.#directories.global, "global"),
      this.#discover(this.#directories.repo, "repo"),
    ])

    const statuses: ExtensionStatus[] = []
    const imported: ImportedExtension[] = []
    for (const failure of [...global.failures, ...repo.failures]) {
      statuses.push({
        key: failureKey(failure),
        path: failure.path,
        scope: failure.scope,
        state: "failed",
        message: failure.error.message,
      })
      this.#diagnose({
        phase: "discover",
        message: `${failure.path}: ${failure.error.message}`,
        error: failure.error,
      })
    }

    for (const candidate of [...global.candidates, ...repo.candidates]) {
      if (this.#stopped) break
      const key = candidateKey(candidate)
      let lease: ImportCopyLease | undefined
      try {
        lease = await this.#importCopies.acquire(candidate, this.#reloadGeneration)
        const module = (await import(pathToFileURL(lease.entryPath).href)) as { default?: unknown }
        assertExtensionDefinition(module.default)
        const extension = module.default as Extension
        imported.push({ candidate, extension, lease })
        statuses.push({
          key,
          path: candidate.entryPath,
          scope: candidate.scope,
          name: extension.spec.name,
          state: "loading",
        })
      } catch (error) {
        if (lease) await lease.release()
        const normalized = normalizeError(error)
        statuses.push({
          key,
          path: candidate.entryPath,
          scope: candidate.scope,
          state: "failed",
          message: normalized.message,
        })
        this.#diagnose({
          phase: "import",
          message: `${candidate.entryPath}: ${normalized.message}`,
          error: normalized,
        })
      }
    }
    this.#publish(statuses)
    return imported
  }

  async #selectByName(imported: readonly ImportedExtension[]): Promise<ReadonlyMap<string, ImportedExtension>> {
    const selected = new Map<string, ImportedExtension>()
    const byScope = new Map<string, ImportedExtension>()

    for (const item of imported) {
      const name = item.extension.spec.name
      const scopeKey = `${item.candidate.scope}:${name}`
      if (byScope.has(scopeKey)) {
        this.#updateStatus(
          item.candidate,
          "failed",
          `Duplicate extension name "${name}" in ${item.candidate.scope} scope`,
        )
        await item.lease.release()
        continue
      }
      byScope.set(scopeKey, item)

      const current = selected.get(name)
      if (!current) {
        selected.set(name, item)
        continue
      }
      if (current.candidate.scope === "global" && item.candidate.scope === "repo") {
        this.#updateStatus(current.candidate, "shadowed", `Shadowed by repo extension "${name}"`)
        selected.set(name, item)
        await current.lease.release()
      } else {
        this.#updateStatus(item.candidate, "shadowed", `Shadowed by repo extension "${name}"`)
        await item.lease.release()
      }
    }
    return selected
  }

  async #activateAll(selected: ReadonlyMap<string, ImportedExtension>): Promise<void> {
    const order: string[] = []
    const state = new Map<string, "visiting" | "visited">()
    const blocked = new Map<string, string>()
    const pending = new Set(selected.values())

    const visit = (name: string, stack: readonly string[]): boolean => {
      if (state.get(name) === "visited") return !blocked.has(name)
      if (state.get(name) === "visiting") {
        const start = stack.indexOf(name)
        const cycle = [...stack.slice(start), name]
        const message = `Dependency cycle: ${cycle.join(" -> ")}`
        for (const member of cycle) blocked.set(member, message)
        return false
      }

      const item = selected.get(name)
      if (!item) return false
      state.set(name, "visiting")
      for (const need of item.extension.spec.needs ?? []) {
        if (!selected.has(need)) {
          blocked.set(name, `Missing required extension "${need}"`)
          continue
        }
        if (!visit(need, [...stack, name]) && !blocked.has(name)) {
          blocked.set(name, `Required extension "${need}" failed`)
        }
      }
      state.set(name, "visited")
      order.push(name)
      return !blocked.has(name)
    }

    for (const name of selected.keys()) visit(name, [])
    this.#activationOrder = []

    const hosts: ContextHosts = {
      repoRoot: this.#repoRoot,
      diagnostics: this.diagnostics,
      events: this.events,
      commands: this.commands,
      panes: this.panes,
      menus: this.#menus,
      statusline: this.#statusline,
      git: this.git,
      notifier: this.#notifier,
      getExtensionApi: (name) => this.getExtensionApi(name),
    }

    const releasePending = async (item: ImportedExtension): Promise<void> => {
      pending.delete(item)
      await item.lease.release()
    }

    try {
      for (const name of order) {
        const item = selected.get(name)
        if (!item) continue
        const reason = blocked.get(name)
        const failedNeed = (item.extension.spec.needs ?? []).find((need) => !this.#activations.has(need))
        if (reason || failedNeed) {
          this.#updateStatus(item.candidate, "failed", reason ?? `Required extension "${failedNeed}" failed`)
          await releasePending(item)
          continue
        }

        let scope: ActivationScope | undefined
        try {
          scope = new ActivationScope(name, this.diagnostics)
          const context = createExtensionContext(name, item.extension.spec.config, scope, hosts)
          const api = await item.extension.spec.activate(context as never)
          this.#activations.set(name, { imported: item, scope, api })
          this.#activationOrder.push(name)
          pending.delete(item)
          this.#updateStatus(item.candidate, "active")
        } catch (error) {
          const normalized = normalizeError(error)
          if (scope) {
            try {
              await scope.close("deactivated")
            } catch (closeError) {
              const closeFailure = normalizeError(closeError)
              this.#diagnose({
                extension: name,
                phase: "dispose",
                message: closeFailure.message,
                error: closeFailure,
              })
            }
          }
          await releasePending(item)
          this.#updateStatus(item.candidate, "failed", normalized.message)
          this.#diagnose({ extension: name, phase: "activate", message: normalized.message, error: normalized })
        }
      }
    } finally {
      await Promise.all([...pending].map((item) => item.lease.release()))
    }
  }

  async #deactivateAll(reason: "reload" | "quit"): Promise<void> {
    for (const name of [...this.#activationOrder].reverse()) {
      const activation = this.#activations.get(name)
      if (!activation) continue

      try {
        await activation.imported.extension.spec.deactivate?.()
      } catch (error) {
        const normalized = normalizeError(error)
        this.#diagnose({
          extension: name,
          phase: "deactivate",
          message: normalized.message,
          error: normalized,
        })
      }

      try {
        await activation.scope.close(reason)
      } catch (error) {
        const normalized = normalizeError(error)
        this.#diagnose({
          extension: name,
          phase: "dispose",
          message: normalized.message,
          error: normalized,
        })
      }

      this.#activations.delete(name)

      try {
        await activation.imported.lease.release()
      } catch (error) {
        const normalized = normalizeError(error)
        this.#diagnose({
          extension: name,
          phase: "cache",
          message: normalized.message,
          error: normalized,
        })
      }
    }
    this.#activationOrder = []
  }

  async #startWatcher(): Promise<void> {
    const fingerprint = await extensionTreeFingerprint([this.#directories.global, this.#directories.repo])
    if (this.#stopped) return

    this.#watchFingerprint = fingerprint
    if (this.#stopped) return
    this.#watchTimer = setInterval(() => void this.#pollForChanges(), Math.max(25, this.#debounceMs))
  }

  #pollForChanges(): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    if (this.#watchScan) return this.#watchScan

    let scan: Promise<void>
    scan = this.#scanForChanges().finally(() => {
      if (this.#watchScan === scan) this.#watchScan = undefined
    })
    this.#watchScan = scan
    return scan
  }

  async #scanForChanges(): Promise<void> {
    try {
      const fingerprint = await extensionTreeFingerprint([this.#directories.global, this.#directories.repo])
      if (this.#stopped || fingerprint === this.#watchFingerprint) return

      this.#watchFingerprint = fingerprint
      if (this.#stopped) return
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer)
      if (this.#stopped) return
      this.#reloadTimer = setTimeout(() => {
        this.#reloadTimer = undefined
        if (!this.#stopped) void this.reload()
      }, this.#debounceMs)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "watch", message: normalized.message, error: normalized })
    }
  }

  async #stopNow(): Promise<void> {
    const owners = [...this.#activationOrder]

    await this.#attemptShutdown("watch scan", async () => {
      await this.#watchScan
    })
    await this.#attemptShutdown("reload queue", async () => {
      await this.#reloadTail
    })
    await this.#attemptShutdown("Extension deactivation", async () => {
      await this.#deactivateAll("quit")
    })
    await this.#attemptShutdown("event delivery", async () => {
      await this.events.drain()
    })
    await this.#attemptShutdown("import-copy cleanup", async () => {
      await this.#importCopies.releaseAll()
    })
    await this.#attemptShutdown("Pane reload cleanup", async () => {
      this.panes.finishReload(owners)
    })
    await this.#attemptShutdown("Pane listener cleanup", async () => {
      this.panes.stop()
    })
  }

  async #attemptShutdown(label: string, operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "shutdown", message: `${label}: ${normalized.message}`, error: normalized })
    }
  }

  #updateStatus(candidate: ExtensionCandidate, state: ExtensionLoadState, message?: string): void {
    const key = candidateKey(candidate)
    this.#publish(this.#snapshot.map((status) => (status.key === key ? { ...status, state, message } : status)))
  }

  #publish(snapshot: readonly ExtensionStatus[]): void {
    this.#snapshot = snapshot
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // Snapshot observers cannot poison activation, reload, or shutdown.
      }
    }
  }

  #diagnose(input: {
    readonly extension?: string
    readonly phase: DiagnosticPhase
    readonly message: string
    readonly error?: Error
  }): void {
    try {
      this.diagnostics.report(input)
    } catch {
      // Diagnostics are observers and cannot poison kernel lifecycle work.
    }
  }
}
