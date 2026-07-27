import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { CliRenderEvents } from "@opentui/core"
import type { CliRenderer, KeyEvent, PluginContext, Renderable } from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { registerLeader } from "@opentui/keymap/addons"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createReactSlotRegistry } from "@opentui/react"
import { assertExtensionDefinition } from "@laziergit/runtime-bridge"
import type { HostRuntime } from "laziergit/host"
import type { CommandSpec, Disposable, EventMap, Extension, GitState } from "laziergit"

import {
  defaultConfigFiles,
  emptyConfig,
  loadConfig,
  readConfigDocuments,
  resolveExtensionConfig,
  type ConfigDocument,
  type ConfigFiles,
  type CoreConfig,
  type LoadedConfig,
} from "../config/config"
import { buildConfigSchema } from "../config/schema"
import { LayoutHost } from "../ui/layout"
import { installKeymap, KeybindingHost } from "../ui/keybindings"
import { MenuHost } from "../ui/menu-host"
import { NotificationHost } from "../ui/notification-host"
import { PopupHost, type CheatSheetEntry, type CheatSheetSection } from "../ui/popup-host"
import { SlotOwners, type UiSlotRegistry, type UiSlots } from "../ui/slots"
import { StatuslineHost } from "../ui/statusline-host"
import { ActivationScope } from "./activation-scope"
import { CommandHost, type CommandEntry } from "./command-host"
import { createExtensionContext, type ClipboardWriterSpec, type ContextHosts, type ExtensionApiLookup } from "./context"
import { Diagnostics, normalizeError, type DiagnosticPhase } from "./diagnostics"
import {
  discoverExtensions,
  extensionScopePrecedence,
  extensionScopeRank,
  extensionTreeFingerprint,
  userWritableExtensionScopes,
  type ExtensionCandidate,
  type ExtensionDirectories,
  type ExtensionDiscoveryFailure,
  type ExtensionDiscoveryResult,
  type ExtensionSourceScope,
} from "./discovery"
import { EventHost } from "./event-host"
import { GitService } from "../git/service"
import { gitStateSlices } from "../git/state"
import type { GitPublication } from "../git/store"
import { ImportCopyCache, type ImportCopyLease } from "./import-copy-cache"
import { createNotifier } from "./notifier"
import { PaneHost } from "./pane-host"
import { ThemeStore } from "./theme"
import { publishTypeEnvironment } from "./type-environment"

export type ExtensionLoadState = "loading" | "active" | "failed" | "shadowed"

export interface ExtensionStatus {
  readonly key: string
  readonly path: string
  readonly scope: ExtensionSourceScope
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
  readonly renderer: CliRenderer
  /**
   * Where Extensions are read from, one directory per scope. Required: the bundled directory
   * lives wherever laziergit was installed, which only the caller can know.
   */
  readonly directories: ExtensionDirectories
  readonly configFiles?: ConfigFiles
  readonly watch?: boolean
  /** How long to wait for edits to settle before acting on them. */
  readonly debounceMs?: number
  /** How often to look for changes. Separate from the settle delay, which it dwarfs. */
  readonly pollMs?: number
  /** Invoked by the `app.quit` Command; the process owner decides what quitting means. */
  readonly onQuit?: () => void
  /** Overrides the platform clipboard cascade; useful to embedders with their own writer. */
  readonly clipboardWriters?: readonly ClipboardWriterSpec[]
}

/** Core's own Commands. "app" is a reserved Extension name, so these ids can never collide. */
const coreOwner = "app"

/**
 * How many Panes the number row can jump to. Nine because that is how many single digits
 * there are above the letters; a tenth Pane is reachable with `tab` like every other.
 */
const maxJumpKeys = 9

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

function documentFingerprint(documents: readonly ConfigDocument[]): string {
  return documents.map((document) => `${document.path}\0${document.text ?? ""}`).join("\0\0")
}

/** Canonical in both section order and key order, so reformatting config reloads nothing. */
function sectionFingerprint(config: LoadedConfig): string {
  const sections = [...config.extensions]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, section]) => [name, JSON.stringify(section, Object.keys(section).sort())] as const)
  return JSON.stringify(sections)
}

function cheatSheetEntries(entries: readonly CommandEntry[]): readonly CheatSheetEntry[] {
  return entries.filter((entry) => entry.keys.length > 0).map((entry) => ({ keys: entry.keys, title: entry.title }))
}

export class ExtensionKernel {
  readonly diagnostics = new Diagnostics()
  readonly theme = new ThemeStore()
  readonly registry: UiSlotRegistry
  readonly panes: PaneHost
  readonly layout = new LayoutHost()
  readonly popups = new PopupHost()
  readonly notifications = new NotificationHost()
  readonly statusline: StatuslineHost
  readonly menus: MenuHost
  readonly events: EventHost
  readonly commands: CommandHost
  readonly keymap: Keymap<Renderable, KeyEvent>
  readonly keybindings: KeybindingHost<Renderable, KeyEvent>
  readonly git: GitService
  readonly runtime: HostRuntime
  readonly #repoRoot: string
  readonly #clipboardWriters: readonly ClipboardWriterSpec[] | undefined
  readonly #directories: ExtensionDirectories
  /** Every Extension directory in precedence order; the search path, in one place. */
  readonly #searchPath: readonly string[]
  readonly #configFiles: ConfigFiles
  readonly #watchEnabled: boolean
  readonly #debounceMs: number
  readonly #pollMs: number
  readonly #renderer: CliRenderer
  readonly #onQuit: (() => void) | undefined
  readonly #listeners = new Set<() => void>()
  /** Keyed by Extension name, in activation order — the order deactivation walks in reverse. */
  readonly #activations = new Map<string, Activation>()
  readonly #notifier = createNotifier(this.notifications.publish)
  readonly #slotOwners = new SlotOwners()
  readonly #disposeSlotErrors: () => void
  readonly #importCopies: ImportCopyCache
  readonly #disposeKeymap: () => void
  /** Live `useKeyCapture` claims, most recent last — React unmounts in no particular order. */
  readonly #captureClaims: { readonly paneId: string }[] = []
  /** The `1`–`9` Commands, in the order they number the Layout. */
  readonly #jumpKeys: Disposable[] = []
  /** What the live jump Commands were built from; re-registration is skipped while it holds. */
  #jumpSignature = ""
  #config: LoadedConfig = emptyConfig
  #modalFocus: { readonly renderable: Renderable | null } | undefined
  #leader: string | undefined
  #disposeLeader: (() => void) | undefined
  #snapshot: readonly ExtensionStatus[] = []
  #reloadGeneration = 0
  #reloadTimer: ReturnType<typeof setTimeout> | undefined
  #watchTimer: ReturnType<typeof setInterval> | undefined
  #watchTree = ""
  #watchConfig = ""
  #activatedTree = ""
  #activatedSections = ""
  #watchScan: Promise<void> | undefined
  #reloadTail: Promise<void> = Promise.resolve()
  #stopPromise: Promise<void> | undefined
  #stopped = false

  constructor(options: ExtensionKernelOptions) {
    this.#repoRoot = options.repoRoot
    this.#directories = options.directories
    this.#searchPath = extensionScopePrecedence.map((scope) => this.#directories[scope])
    this.#configFiles = options.configFiles ?? defaultConfigFiles(options.repoRoot)
    this.#watchEnabled = options.watch ?? true
    this.#debounceMs = options.debounceMs ?? 80
    this.#pollMs = options.pollMs ?? 250
    this.#renderer = options.renderer
    this.#onQuit = options.onQuit
    this.#clipboardWriters = options.clipboardWriters

    this.registry = createReactSlotRegistry<UiSlots, PluginContext>(options.renderer, {})
    this.#disposeSlotErrors = this.#slotOwners.watch(this.registry, this.diagnostics)
    this.panes = new PaneHost(this.registry, this.#slotOwners)
    this.statusline = new StatuslineHost(this.registry, this.#slotOwners)
    this.menus = new MenuHost(this.diagnostics, this.popups, this.#notifier)
    this.events = new EventHost(this.diagnostics)
    this.commands = new CommandHost(
      this.diagnostics,
      { focus: (paneId) => this.layout.focus(paneId), isLive: (paneId) => this.panes.isLive(paneId) },
      this.#notifier,
    )
    // Constructed here rather than as a field initializer: field initializers run before
    // the constructor body, so `options.repoRoot` is not yet on `this`. Construction does
    // no I/O — the repository is opened by `prime()`, inside the reload transaction.
    this.git = new GitService({
      repoRoot: this.#repoRoot,
      config: emptyConfig.core.git,
      report: (message, error) => {
        const normalized = error === undefined ? undefined : normalizeError(error)
        this.#diagnose({
          phase: "git",
          message: normalized ? `${message}: ${normalized.message}` : message,
          error: normalized,
        })
      },
    })
    this.keymap = createOpenTuiKeymap(options.renderer)
    this.#disposeKeymap = installKeymap(this.keymap, { diagnostics: this.diagnostics })
    this.keybindings = new KeybindingHost(this.keymap, this.diagnostics, (id) => this.#runCommand(id))
    this.#importCopies = new ImportCopyCache({
      directories: this.#searchPath,
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
      activity: this.git.activity,
      events: {
        subscribe: (extension, event, handler) => this.events.subscribe(extension, event, handler),
      },
      commands: {
        registerComponent: (extension, paneId, spec) => this.commands.registerComponent(extension, paneId, spec),
      },
      keys: {
        capture: (paneId) => this.#captureKeys(paneId),
      },
      theme: this.theme,
    }

    this.panes.subscribe(() => this.layout.setPanes(this.panes.getSnapshot()))
    this.layout.subscribe(() => this.#syncJumpKeys())
    this.git.store.onPublish((publication) => this.#emitGitEvents(publication))
    this.layout.setFocusListener((paneId, previous) => {
      this.keybindings.setFocusedPane(paneId)
      if (paneId !== null) this.events.emit("app.pane.focused", { paneId, previous })
    })
    this.commands.subscribe(() => this.keybindings.sync(this.commands.getSnapshot()))
    this.popups.setModalListener((open) => {
      this.keybindings.setModalOpen(open)
      this.#trackModalFocus(open)
    })
    this.#applyCoreConfig(emptyConfig.core)
    this.#registerCoreCommands()
  }

  getSnapshot = (): readonly ExtensionStatus[] => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async start(): Promise<void> {
    // The two directories a user drops Extensions into, made so they are always there to drop
    // into. The bundled directory is deliberately absent: it ships inside the installation, so
    // creating one would only invent an empty directory in someone's install tree.
    const userDirectories = userWritableExtensionScopes.map((scope) => this.#directories[scope])
    await Promise.all(userDirectories.map((directory) => mkdir(directory, { recursive: true })))
    if (this.#stopped) return

    // Before the first fingerprint, so the files this writes are part of the tree the reload
    // starts from rather than an edit the next poll mistakes for the author's.
    await publishTypeEnvironment({
      directories: userDirectories,
      diagnose: ({ path, error }) => this.#diagnose({ phase: "config", message: `${path}: ${error.message}`, error }),
    })
    if (this.#stopped) return

    await this.#importCopies.sweepStale()
    if (this.#stopped) return

    await this.reload()
    if (this.#stopped) return
    // Armed once, here — never in `#reloadNow`, which would rearm on every hot reload.
    this.git.start()
    // Coming back from the terminal you just ran `git` in is the moment the screen is
    // most likely to be stale, and the least tolerable moment to wait out a poll interval.
    this.#renderer.on(CliRenderEvents.FOCUS, this.#refreshOnFocus)
    if (this.#watchEnabled) this.#startWatcher()
  }

  readonly #refreshOnFocus = (): void => {
    void this.git.refresh()
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
    // Synchronous, alongside the other timers: no poll may be scheduled while shutdown drains.
    this.git.stop()

    this.#stopPromise = this.#stopNow()
    return this.#stopPromise
  }

  getExtensionApi(name: string): ExtensionApiLookup {
    const activation = this.#activations.get(name)
    return activation ? { state: "live", api: activation.api } : { state: "missing" }
  }

  /** The palette, as a data list: every visible Command that could run right now. */
  async openPalette(): Promise<void> {
    const entries = this.commands.availableEntries()
    const index = await this.popups.choose(coreOwner, {
      title: "Commands",
      placeholder: "Filter commands",
      choices: entries.map((entry) => ({ label: entry.title, hint: entry.keys.join("  ") })),
    }).promise

    const entry = index === undefined ? undefined : entries[index]
    if (entry) await this.commands.execute(entry.id)
  }

  openCheatSheet(): Promise<void> {
    const focused = this.layout.focusedPaneId
    const title = focused === null ? "Keybindings" : `Keybindings — ${focused}`
    return this.popups.cheatSheet(coreOwner, title, this.#cheatSheetSections()).promise
  }

  /** Core owns the `git.*` and `app.*` namespaces; both names are reserved, so no Extension can spoof them. */
  #emitCoreEvent<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.events.emit(event, payload)
  }

  /**
   * One event per changed {@link GitState} slice, then `git.refreshed` for the cycle
   * itself. The slice list is derived from the store's own shape, so the event vocabulary
   * cannot drift from it, and `Object.is` is enough to detect a change because the store
   * keeps unchanged slices referentially stable.
   */
  #emitGitEvents({ previous, current }: GitPublication): void {
    // The mapped type is what makes the vocabulary structural rather than documented: a
    // new GitState slice is a compile error here until it has an event.
    const emitters: { readonly [K in keyof GitState]: () => void } = {
      head: () => this.#emitCoreEvent("git.head.changed", { current: current.head, previous: previous.head }),
      branches: () =>
        this.#emitCoreEvent("git.branches.changed", { current: current.branches, previous: previous.branches }),
      remotes: () =>
        this.#emitCoreEvent("git.remotes.changed", { current: current.remotes, previous: previous.remotes }),
      tags: () => this.#emitCoreEvent("git.tags.changed", { current: current.tags, previous: previous.tags }),
      status: () => this.#emitCoreEvent("git.status.changed", { current: current.status, previous: previous.status }),
      commits: () =>
        this.#emitCoreEvent("git.commits.changed", { current: current.commits, previous: previous.commits }),
      stash: () => this.#emitCoreEvent("git.stash.changed", { current: current.stash, previous: previous.stash }),
    }

    for (const slice of gitStateSlices) {
      if (Object.is(current[slice], previous[slice])) continue
      emitters[slice]()
    }
    this.#emitCoreEvent("git.refreshed", { state: current })
  }

  #registerCoreCommands(): void {
    const register = (spec: CommandSpec): void => {
      this.commands.register(coreOwner, spec)
    }

    // Terminal-safe by construction, never `mod+` (ADR-0004): a Mac terminal that can report
    // cmd at all is also free to keep it, and Warp keeps cmd+p for its own palette — so the
    // one binding that opens laziergit's would be the one the terminal ate.
    register({ id: "app.palette", title: "Command palette", keys: ["ctrl+p", ":"], run: () => this.openPalette() })
    register({ id: "app.cheatsheet", title: "Keybindings", keys: "?", run: () => this.openCheatSheet() })
    register({ id: "app.focus.next", title: "Focus next pane", keys: "tab", run: () => this.layout.focusStep(1) })
    register({
      id: "app.focus.previous",
      title: "Focus previous pane",
      keys: "shift+tab",
      run: () => this.layout.focusStep(-1),
    })
    register({ id: "app.tab.next", title: "Next tab in pane", keys: "]", run: () => this.layout.cycleTab(1) })
    register({ id: "app.tab.previous", title: "Previous tab in pane", keys: "[", run: () => this.layout.cycleTab(-1) })
    register({ id: "app.reload", title: "Reload extensions", run: () => this.reload() })
    register({ id: "app.quit", title: "Quit", keys: "q", run: () => this.#onQuit?.() })
  }

  /**
   * Rebuilds the `1`–`9` Commands so each digit names the Pane it currently jumps to.
   *
   * Core owns these rather than the Extensions owning a digit each, and that is the whole
   * point: a Pane's number is its *position* in the user's Layout, so a third-party Pane is
   * reachable the moment it is placed instead of having to guess a free digit and collide
   * with whoever guessed the same. It also means the number a Pane answers to follows the
   * Layout the user wrote, which is the only place the question has an answer.
   *
   * Re-registered from a signature rather than on every publish: the Layout republishes on
   * focus changes too, and disposing nine Commands per keypress would rebuild every keymap
   * layer to arrive at the same nine. The signature is the titles, so it moves exactly when
   * the cheat sheet's answer would move — a Pane appearing, going away, or being re-placed.
   * A tab coming to the front is not such a moment: the numbering is over Panes, and a
   * hidden tab has a digit of its own that reveals it.
   *
   * `hidden` keeps them out of the palette, where nine near-identical "Focus …" rows would
   * sit beside the Extensions' own focus Commands saying the same thing. The cheat sheet
   * keeps hidden Commands (§5.8), and it is the surface that has to list them: it is where
   * a user goes to ask which digit is which.
   */
  #syncJumpKeys(): void {
    if (this.#stopped) return

    const titles = this.layout
      .liveTabs()
      .slice(0, maxJumpKeys)
      .map((paneId) => this.#paneTitle(paneId))
    const signature = titles.join("\0")
    if (signature === this.#jumpSignature) return
    this.#jumpSignature = signature

    for (const disposable of this.#jumpKeys.splice(0)) {
      try {
        disposable.dispose()
      } catch (error) {
        this.#diagnose({ phase: "command", message: "Releasing a pane-jump key", error: normalizeError(error) })
      }
    }

    for (const [index, title] of titles.entries()) {
      this.#jumpKeys.push(
        this.commands.register(coreOwner, {
          id: `app.focus.${index + 1}`,
          title: `Focus ${title}`,
          keys: String(index + 1),
          hidden: true,
          run: () => this.layout.focusAt(index),
        }),
      )
    }
  }

  /** A Pane's own title, falling back to its id if it left the registry mid-walk. */
  #paneTitle(paneId: string): string {
    const pane = this.panes.getSnapshot().find((entry) => entry.id === paneId)
    return pane?.title ?? paneId
  }

  /**
   * A stacked claim rather than a setter: two Panes may render editors at once, and React
   * unmounts them in no guaranteed order, so releasing a claim restores whichever is still
   * standing instead of unconditionally clearing the capture.
   */
  #captureKeys(paneId: string): Disposable {
    const claim = { paneId }
    this.#captureClaims.push(claim)
    this.keybindings.setCapturingPane(paneId)

    return {
      dispose: () => {
        const index = this.#captureClaims.indexOf(claim)
        if (index === -1) return
        this.#captureClaims.splice(index, 1)
        this.keybindings.setCapturingPane(this.#captureClaims.at(-1)?.paneId ?? null)
      },
    }
  }

  /**
   * The cheat sheet answers "what can I press", so it shows the layers that are live.
   *
   * While a Pane captures raw input, that is exactly one layer: its `capture: true`
   * Commands. Listing the global and Pane keys beside them would be listing keys that
   * currently type letters into a textarea — so a capture collapses the sheet to the one
   * section that still does anything, named after the Pane holding the keyboard. (Even an
   * empty one: a Pane that captures without an exit Command has trapped the user, and a
   * bare heading says so louder than an absent section.)
   *
   * Otherwise the sheet is the *focused* Pane's, not the app's. Listing every live Pane's
   * keys turned the one question it answers — "what can I press here" — into a catalogue
   * the reader had to search, and most of it was keys that would do nothing until they had
   * tabbed somewhere else. Capture Commands still get a section of their own, listed after
   * the Pane's ordinary keys, because they answer a different question — not "what does this
   * Pane do" but "what gets me back out of the editor it can show". That is worth reading
   * *before* entering it, which is the only time this sheet can be opened anyway.
   *
   * The globals come last, and only last: they are the same everywhere, so they are the
   * fallback rather than the answer — but the Pane-jump keys are global Commands and this is
   * the only place they are written down.
   */
  #cheatSheetSections(): readonly CheatSheetSection[] {
    const entries = this.commands.getSnapshot()
    const focused = this.layout.focusedPaneId
    const capturing = this.keybindings.capturingPaneId
    if (capturing !== null) {
      return [{ title: `${capturing} (capturing keys)`, entries: this.#captureEntries(entries, capturing) }]
    }

    const sections: CheatSheetSection[] = []
    // Only a Pane that exists right now: the sheet answers "what can I press", so a Command
    // bound into a Pane nothing registered has nothing to say here.
    if (focused !== null && this.panes.isLive(focused)) {
      const ordinary = cheatSheetEntries(entries.filter((entry) => entry.pane === focused && !entry.capture))
      if (ordinary.length > 0) sections.push({ title: focused, entries: ordinary })
      const captured = this.#captureEntries(entries, focused)
      if (captured.length > 0) sections.push({ title: `${focused} (capturing keys)`, entries: captured })
    }

    const globals = cheatSheetEntries(entries.filter((entry) => entry.pane === undefined))
    if (globals.length > 0) sections.push({ title: "Global", entries: globals })
    return sections
  }

  #captureEntries(entries: readonly CommandEntry[], pane: string): readonly CheatSheetEntry[] {
    return cheatSheetEntries(entries.filter((entry) => entry.pane === pane && entry.capture))
  }

  /**
   * OpenTUI has one focus slot, and a popup's own input claims it during the commit that
   * mounts the popup — before any effect could look. So the Renderable to hand focus back
   * to is captured here, on the transition into modal, which runs before that commit.
   */
  #trackModalFocus(open: boolean): void {
    if (open) {
      this.#modalFocus ??= { renderable: this.#renderer.currentFocusedRenderable }
      return
    }

    const previous = this.#modalFocus?.renderable
    this.#modalFocus = undefined
    try {
      if (previous && !previous.isDestroyed) previous.focus()
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "render", message: `Restoring focus: ${normalized.message}`, error: normalized })
    }
  }

  #runCommand(id: string): void {
    void this.commands.execute(id).catch((error: unknown) => {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "command", message: `${id}: ${normalized.message}`, error: normalized })
    })
  }

  #applyCoreConfig(core: CoreConfig): void {
    this.theme.replace(core.theme)
    this.layout.setConfig(core.layout)
    this.commands.setKeybindings(core.keybindings)
    this.statusline.setConfig(core.statusline)
    // Before the leader early-return below, which would otherwise skip it.
    this.git.setConfig(core.git)

    if (this.#leader === core.leader) return
    this.#leader = core.leader
    this.#disposeLeader?.()
    try {
      this.#disposeLeader = registerLeader(this.keymap, { trigger: core.leader })
    } catch (error) {
      const normalized = normalizeError(error)
      this.#disposeLeader = undefined
      this.#diagnose({ phase: "config", message: `leader: ${normalized.message}`, error: normalized })
    }
  }

  async #loadConfig(): Promise<LoadedConfig> {
    let documents: readonly ConfigDocument[] = []
    try {
      documents = await readConfigDocuments(this.#configFiles)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "config", message: normalized.message, error: normalized })
    }

    const loaded = loadConfig(documents)
    this.#config = loaded
    this.#watchConfig = documentFingerprint(documents)
    this.#activatedSections = sectionFingerprint(loaded)
    this.#applyCoreConfig(loaded.core)
    for (const problem of loaded.problems) {
      this.#diagnose({
        phase: "config",
        message: problem.path ? `${problem.path}: ${problem.message}` : problem.message,
      })
    }
    return loaded
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

    const previousOwners = [...this.#activations.keys()]
    // Core's own modals list Commands that are about to be torn down and re-registered.
    this.popups.closeForExtension(coreOwner)
    this.panes.prepareReload(previousOwners)
    try {
      await this.#deactivateAll("reload")
      if (this.#stopped) return

      this.#publish(this.#snapshot.map((status) => ({ ...status, state: "loading" as const, message: undefined })))
      await this.#loadConfig()
      // `ctx.git.state` is documented as always present, so the store is loaded before any
      // Extension activates. Idempotent, so a hot reload does not republish and make every
      // reactivated Extension see a change that did not happen.
      await this.git.prime()
      if (this.#stopped) return
      // Fingerprinted before reading a single Extension: an edit that lands mid-reload
      // then differs from what was loaded, and the next poll picks it up.
      this.#activatedTree = await this.#treeFingerprint()
      this.#watchTree = this.#activatedTree
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

      await this.#publishSchema(selected)
      await this.#activateAll(selected)
      // Only now does "the first cell of the Layout" mean what the user wrote, rather than
      // whichever Extension the `needs` graph happened to activate first.
      this.layout.settleInitialFocus()
    } finally {
      this.panes.finishReload(previousOwners)
    }
  }

  async #publishSchema(selected: ReadonlyMap<string, ImportedExtension>): Promise<void> {
    const schema = buildConfigSchema(
      [...selected.values()].map((item) => ({
        name: item.extension.spec.name,
        description: item.extension.spec.description,
        config: item.extension.spec.config,
      })),
    )
    const path = `${dirname(this.#configFiles.global)}/config.schema.json`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "config", message: `${path}: ${normalized.message}`, error: normalized })
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
    const discovered = await Promise.all(
      extensionScopePrecedence.map((scope) => this.#discover(this.#directories[scope], scope)),
    )

    const statuses: ExtensionStatus[] = []
    const imported: ImportedExtension[] = []
    for (const failure of discovered.flatMap((result) => result.failures)) {
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

    for (const candidate of discovered.flatMap((result) => result.candidates)) {
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
    const shadowed = new Map<string, ImportedExtension[]>()

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
      // Scopes cannot tie here — a same-scope collision was already rejected above — so the
      // ranking alone decides, whatever order the two copies were imported in.
      const winner =
        extensionScopeRank(item.candidate.scope) > extensionScopeRank(current.candidate.scope) ? item : current
      selected.set(name, winner)
      shadowed.set(name, [...(shadowed.get(name) ?? []), winner === item ? current : item])
    }

    // Reported only once every scope has been walked, because the answer a shadowed Extension
    // owes its author is which copy is running instead — and with three scopes the first copy
    // to beat it need not be the last (a bundled one loses to global, then both lose to repo).
    for (const [name, winner] of selected) {
      for (const loser of shadowed.get(name) ?? []) {
        this.#updateStatus(loser.candidate, "shadowed", `Shadowed by ${winner.candidate.scope} extension "${name}"`)
        await loser.lease.release()
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

    const hosts: ContextHosts = {
      diagnostics: this.diagnostics,
      events: this.events,
      commands: this.commands,
      panes: this.panes,
      layout: this.layout,
      menus: this.menus,
      popups: this.popups,
      statusline: this.statusline,
      git: this.git,
      notifier: this.#notifier,
      clipboardWriters: this.#clipboardWriters,
      getExtensionApi: (name) => this.getExtensionApi(name),
    }

    const releasePending = async (item: ImportedExtension): Promise<void> => {
      pending.delete(item)
      await item.lease.release()
    }

    try {
      for (const name of order) {
        if (this.#stopped) break
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
          const config = resolveExtensionConfig(name, item.extension.spec.config, this.#config.extensions.get(name))
          for (const problem of config.problems) {
            this.#diagnose({ extension: name, phase: "config", message: `${problem.path}: ${problem.message}` })
          }
          const context = createExtensionContext(name, config.values, scope, hosts)
          const api = await item.extension.spec.activate(context)
          this.#activations.set(name, { imported: item, scope, api })
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
    // Snapshotted before the loop deletes its way through the map it was taken from.
    for (const name of [...this.#activations.keys()].reverse()) {
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

      // Closing the scope already dismissed the popups this Extension opened. This
      // catches the other direction: menus opened by someone else that are showing
      // this Extension's spliced items.
      try {
        this.popups.closeForExtension(name)
      } catch (error) {
        const normalized = normalizeError(error)
        this.#diagnose({ extension: name, phase: "dispose", message: normalized.message, error: normalized })
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
  }

  #treeFingerprint(): Promise<string> {
    return extensionTreeFingerprint(this.#searchPath)
  }

  /** The last reload already recorded what it loaded, so the watcher only starts the clock. */
  #startWatcher(): void {
    this.#watchTimer = setInterval(() => void this.#pollForChanges(), Math.max(25, this.#pollMs))
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
      const [tree, documents] = await Promise.all([this.#treeFingerprint(), readConfigDocuments(this.#configFiles)])
      const config = documentFingerprint(documents)
      if (this.#stopped || (tree === this.#watchTree && config === this.#watchConfig)) return

      this.#watchTree = tree
      this.#watchConfig = config
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer)
      if (this.#stopped) return
      this.#reloadTimer = setTimeout(() => {
        this.#reloadTimer = undefined
        if (!this.#stopped) void this.#applyChanges()
      }, this.#debounceMs)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "watch", message: normalized.message, error: normalized })
    }
  }

  /**
   * Editing the Layout, theme, keybindings, or status line rearranges the live screen;
   * only a changed Extension tree or a changed Extension config section — the two things
   * an activation closes over — costs a reload.
   */
  async #applyChanges(): Promise<void> {
    try {
      const [tree, documents] = await Promise.all([this.#treeFingerprint(), readConfigDocuments(this.#configFiles)])
      const loaded = loadConfig(documents)
      if (tree !== this.#activatedTree || sectionFingerprint(loaded) !== this.#activatedSections) {
        await this.reload()
        return
      }

      this.#config = loaded
      this.#applyCoreConfig(loaded.core)
      for (const problem of loaded.problems) {
        this.#diagnose({
          phase: "config",
          message: problem.path ? `${problem.path}: ${problem.message}` : problem.message,
        })
      }
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "config", message: normalized.message, error: normalized })
    }
  }

  async #stopNow(): Promise<void> {
    const owners = [...this.#activations.keys()]

    await this.#attemptShutdown("watch scan", async () => {
      await this.#watchScan
    })
    await this.#attemptShutdown("reload queue", async () => {
      await this.#reloadTail
    })
    await this.#attemptShutdown("Extension deactivation", async () => {
      await this.#deactivateAll("quit")
    })
    // After deactivation, because an Extension's write outlives the promise it was awaited
    // on; before event delivery, because a settling refresh still emits into the EventHost.
    await this.#attemptShutdown("git", async () => {
      await this.git.drain()
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
    await this.#attemptShutdown("slot error listener cleanup", () => {
      this.#disposeSlotErrors()
      this.#slotOwners.clear()
    })
    await this.#attemptShutdown("modal cleanup", () => {
      this.popups.closeAll()
    })
    await this.#attemptShutdown("notification cleanup", () => {
      this.notifications.stop()
    })
    await this.#attemptShutdown("focus listener cleanup", () => {
      this.#renderer.off(CliRenderEvents.FOCUS, this.#refreshOnFocus)
    })
    await this.#attemptShutdown("keybinding cleanup", () => {
      this.keybindings.stop()
      this.#disposeLeader?.()
      this.#disposeKeymap()
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
