import { copyFile, cp, mkdir, readdir, rm, stat, symlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { PluginContext, SlotRegistry } from "@opentui/core"
import type { ReactNode } from "react"
import type { Extension, ExtensionSpec } from "laziergit"
import type { InternalRuntime } from "laziergit/internal"

import { ActivationScope } from "./activation-scope"
import { CommandHost } from "./command-host"
import { createExtensionContext, type ContextHosts } from "./context"
import { Diagnostics, normalizeError } from "./diagnostics"
import {
  defaultExtensionDirectories,
  discoverExtensions,
  type ExtensionCandidate,
  type ExtensionDirectories,
} from "./discovery"
import { EventHost } from "./event-host"
import { GitPlaceholder } from "./git-placeholder"
import { PaneHost, type PaneSlots } from "./pane-host"
import { MenuHost, StatuslineHost } from "./registry-hosts"
import { defaultTheme } from "./theme"

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

function candidateKey(candidate: ExtensionCandidate): string {
  return `${candidate.scope}:${candidate.rootPath}`
}

interface ImportCopy {
  readonly entryPath: string
  readonly rootPath: string
}

function reloadCopyPath(path: string, generation: number): string {
  return join(dirname(path), `.laziergit-cache-${process.pid}-${generation}-${Date.now()}-${basename(path)}`)
}

async function linkDirectoryEntries(source: string, target: string, omitted: ReadonlySet<string>): Promise<void> {
  let entries
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  await mkdir(target, { recursive: true })
  await Promise.all(
    entries
      .filter((entry) => !omitted.has(entry.name))
      .map((entry) => symlink(join(source, entry.name), join(target, entry.name))),
  )
}

async function createNodeModulesOverlay(copyRoot: string, sourceRoot?: string): Promise<void> {
  const overlay = join(copyRoot, "node_modules")
  const sourceNodeModules = sourceRoot ? join(sourceRoot, "node_modules") : undefined
  if (sourceNodeModules) {
    await linkDirectoryEntries(sourceNodeModules, overlay, new Set(["@opentui", "react"]))
    await linkDirectoryEntries(join(sourceNodeModules, "@opentui"), join(overlay, "@opentui"), new Set(["react"]))
  }

  const hostReact = dirname(fileURLToPath(import.meta.resolve("react")))
  const hostOpenTuiReact = dirname(fileURLToPath(import.meta.resolve("@opentui/react")))
  await mkdir(join(overlay, "@opentui"), { recursive: true })
  await Promise.all([
    symlink(hostReact, join(overlay, "react"), "dir"),
    symlink(hostOpenTuiReact, join(overlay, "@opentui", "react"), "dir"),
  ])
}

async function createImportCopy(candidate: ExtensionCandidate, generation: number): Promise<ImportCopy> {
  if (candidate.rootPath === candidate.entryPath) {
    const copyRoot = reloadCopyPath(candidate.entryPath, generation)
    try {
      await mkdir(copyRoot)
      const entryPath = join(copyRoot, basename(candidate.entryPath))
      await copyFile(candidate.entryPath, entryPath)
      await createNodeModulesOverlay(copyRoot)
      return { entryPath, rootPath: copyRoot }
    } catch (error) {
      await rm(copyRoot, { recursive: true, force: true })
      throw error
    }
  }

  const entryRelativePath = relative(candidate.rootPath, candidate.entryPath)
  if (isAbsolute(entryRelativePath) || entryRelativePath.startsWith("..")) {
    throw new TypeError(`Directory extension entry must be inside ${candidate.rootPath}`)
  }

  const copyRoot = reloadCopyPath(candidate.rootPath, generation)
  try {
    await cp(candidate.rootPath, copyRoot, {
      recursive: true,
      filter: (source) => {
        const name = basename(source)
        return name !== "node_modules" && !name.startsWith(".laziergit-cache-")
      },
    })
    await createNodeModulesOverlay(copyRoot, candidate.rootPath)
    return { entryPath: join(copyRoot, entryRelativePath), rootPath: copyRoot }
  } catch (error) {
    await rm(copyRoot, { recursive: true, force: true })
    throw error
  }
}

function isExtension(value: unknown): value is Extension {
  if (!value || typeof value !== "object" || !("spec" in value)) return false
  const spec = value.spec as Partial<
    ExtensionSpec<string, import("laziergit").ConfigSchema, readonly string[], unknown>
  >
  return typeof spec.name === "string" && typeof spec.activate === "function"
}

async function extensionTreeFingerprint(directories: readonly string[]): Promise<string> {
  const entries: string[] = []

  const visit = async (directory: string): Promise<void> => {
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name === "node_modules" || child.name.startsWith(".laziergit-cache-")) continue
      const path = join(directory, child.name)
      if (child.isDirectory()) {
        await visit(path)
        continue
      }
      const metadata = await stat(path)
      entries.push(`${path}:${metadata.size}:${metadata.mtimeMs}`)
    }
  }

  for (const directory of directories) await visit(directory)
  return entries.join("\n")
}

export class ExtensionKernel {
  readonly diagnostics = new Diagnostics()
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
  readonly #importCopies = new Set<string>()
  readonly runtime: InternalRuntime
  #activationOrder: string[] = []
  #snapshot: readonly ExtensionStatus[] = []
  #reloadGeneration = 0
  #reloadTimer: ReturnType<typeof setTimeout> | undefined
  #watchTimer: ReturnType<typeof setInterval> | undefined
  #watchFingerprint = ""
  #watchScanRunning = false
  #reloadQueue = Promise.resolve()
  #stopped = false

  constructor(options: ExtensionKernelOptions) {
    this.#repoRoot = options.repoRoot
    this.#directories = options.directories ?? defaultExtensionDirectories(options.repoRoot)
    this.#watchEnabled = options.watch ?? true
    this.#debounceMs = options.debounceMs ?? 80
    this.panes = new PaneHost(options.registry)
    this.events = new EventHost(this.diagnostics)
    this.commands = new CommandHost(this.diagnostics, (id) => this.panes.focus(id))
    this.runtime = {
      git: this.git,
      events: {
        subscribe: (extension, event, handler) => this.events.subscribe(extension, event, handler),
      },
      commands: {
        registerComponent: (extension, paneId, spec) => this.commands.registerComponent(extension, paneId, spec),
      },
      theme: defaultTheme,
    }
    this.panes.setRuntime(this.runtime)
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
    await this.reload()
    if (this.#watchEnabled) await this.#startWatcher()
  }

  reload(): Promise<void> {
    this.#reloadQueue = this.#reloadQueue.then(() => this.#reloadNow())
    return this.#reloadQueue
  }

  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer)
    if (this.#watchTimer) clearInterval(this.#watchTimer)
    await this.#reloadQueue
    await this.#deactivateAll("quit")
    await this.#cleanupImportCopies()
    this.panes.finishReload(this.#activationOrder)
  }

  getExtensionApi(name: string): unknown {
    return this.#activations.get(name)?.api
  }

  async #reloadNow(): Promise<void> {
    if (this.#stopped) return
    const previousNames = [...this.#activationOrder]
    this.panes.prepareReload(previousNames)
    await this.#deactivateAll("reload")
    await this.#cleanupImportCopies()
    this.#publish(this.#snapshot.map((status) => ({ ...status, state: "loading" as const, message: undefined })))

    const imported = await this.#importAll()
    const selected = this.#selectByName(imported)
    await this.#activateAll(selected)
    this.panes.finishReload(previousNames)
  }

  async #importAll(): Promise<readonly ImportedExtension[]> {
    this.#reloadGeneration += 1
    let candidates: readonly ExtensionCandidate[] = []
    try {
      const [global, repo] = await Promise.all([
        discoverExtensions(this.#directories.global, "global"),
        discoverExtensions(this.#directories.repo, "repo"),
      ])
      candidates = [...global, ...repo]
    } catch (error) {
      const normalized = normalizeError(error)
      this.diagnostics.report({ phase: "discover", message: normalized.message, error: normalized })
    }

    const statuses: ExtensionStatus[] = []
    const imported: ImportedExtension[] = []
    for (const candidate of candidates) {
      const key = candidateKey(candidate)
      let importCopy: ImportCopy | undefined
      try {
        // OpenTUI's runtime-module rewrite loader canonicalizes source paths.
        // A unique sibling copy keeps Bun's module cache honest while preserving
        // relative imports, import.meta.url assets, and local dependency resolution.
        importCopy = await createImportCopy(candidate, this.#reloadGeneration)
        const url = pathToFileURL(importCopy.entryPath)
        const module = (await import(url.href)) as { default?: unknown }
        if (!isExtension(module.default)) {
          throw new TypeError("Default export must be defineExtension({...})")
        }
        imported.push({ candidate, extension: module.default })
        this.#importCopies.add(importCopy.rootPath)
        statuses.push({
          key,
          path: candidate.entryPath,
          scope: candidate.scope,
          name: module.default.spec.name,
          state: "loading",
        })
      } catch (error) {
        if (importCopy) await rm(importCopy.rootPath, { recursive: true, force: true })
        const normalized = normalizeError(error)
        statuses.push({
          key,
          path: candidate.entryPath,
          scope: candidate.scope,
          state: "failed",
          message: normalized.message,
        })
        this.diagnostics.report({
          phase: "import",
          message: `${candidate.entryPath}: ${normalized.message}`,
          error: normalized,
        })
      }
    }
    this.#publish(statuses)
    return imported
  }

  #selectByName(imported: readonly ImportedExtension[]): ReadonlyMap<string, ImportedExtension> {
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
      } else {
        this.#updateStatus(item.candidate, "shadowed", `Shadowed by repo extension "${name}"`)
      }
    }
    return selected
  }

  async #activateAll(selected: ReadonlyMap<string, ImportedExtension>): Promise<void> {
    const order: string[] = []
    const state = new Map<string, "visiting" | "visited">()
    const blocked = new Map<string, string>()

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
      getExtensionApi: (name) => this.getExtensionApi(name),
    }

    for (const name of order) {
      const item = selected.get(name)
      if (!item) continue
      const reason = blocked.get(name)
      const failedNeed = (item.extension.spec.needs ?? []).find((need) => !this.#activations.has(need))
      if (reason || failedNeed) {
        this.#updateStatus(item.candidate, "failed", reason ?? `Required extension "${failedNeed}" failed`)
        continue
      }

      const scope = new ActivationScope(name, this.diagnostics)
      const context = createExtensionContext(name, item.extension.spec.config, scope, hosts)
      try {
        const api = await item.extension.spec.activate(context as never)
        this.#activations.set(name, { imported: item, scope, api })
        this.#activationOrder.push(name)
        this.#updateStatus(item.candidate, "active")
      } catch (error) {
        const normalized = normalizeError(error)
        await scope.close("deactivated")
        this.#updateStatus(item.candidate, "failed", normalized.message)
        this.diagnostics.report({ extension: name, phase: "activate", message: normalized.message, error: normalized })
      }
    }
  }

  async #deactivateAll(reason: "reload" | "quit"): Promise<void> {
    for (const name of [...this.#activationOrder].reverse()) {
      const activation = this.#activations.get(name)
      if (!activation) continue
      if (activation.imported.extension.spec.deactivate) {
        try {
          await activation.imported.extension.spec.deactivate()
        } catch (error) {
          const normalized = normalizeError(error)
          this.diagnostics.report({
            extension: name,
            phase: "deactivate",
            message: normalized.message,
            error: normalized,
          })
        }
      }
      await activation.scope.close(reason)
      this.#activations.delete(name)
    }
    this.#activationOrder = []
  }

  async #cleanupImportCopies(): Promise<void> {
    await Promise.all([...this.#importCopies].map((path) => rm(path, { recursive: true, force: true })))
    this.#importCopies.clear()
  }

  async #startWatcher(): Promise<void> {
    this.#watchFingerprint = await extensionTreeFingerprint([this.#directories.global, this.#directories.repo])
    this.#watchTimer = setInterval(() => void this.#pollForChanges(), Math.max(25, this.#debounceMs))
  }

  async #pollForChanges(): Promise<void> {
    if (this.#stopped || this.#watchScanRunning) return
    this.#watchScanRunning = true
    try {
      const fingerprint = await extensionTreeFingerprint([this.#directories.global, this.#directories.repo])
      if (fingerprint === this.#watchFingerprint) return
      this.#watchFingerprint = fingerprint
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer)
      this.#reloadTimer = setTimeout(() => {
        this.#reloadTimer = undefined
        void this.reload()
      }, this.#debounceMs)
    } catch (error) {
      const normalized = normalizeError(error)
      this.diagnostics.report({ phase: "watch", message: normalized.message, error: normalized })
    } finally {
      this.#watchScanRunning = false
    }
  }

  #updateStatus(candidate: ExtensionCandidate, state: ExtensionLoadState, message?: string): void {
    const key = candidateKey(candidate)
    this.#publish(this.#snapshot.map((status) => (status.key === key ? { ...status, state, message } : status)))
  }

  #publish(snapshot: readonly ExtensionStatus[]): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
