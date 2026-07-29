import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { CliRenderEvents } from "@opentui/core"
import type { CliRenderer, KeyEvent, PluginContext, Renderable, TerminalColors, ThemeMode } from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { registerLeader } from "@opentui/keymap/addons"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createReactSlotRegistry } from "@opentui/react"
import { assertExtensionDefinition } from "@laziergit/runtime-bridge"
import type { HostRuntime } from "laziergit/host"
import type { CommandSpec, ConfigSchema, Disposable, EventMap, Extension, GitState } from "laziergit"

import {
  defaultConfigFiles,
  emptyConfig,
  loadConfig,
  readConfigDocuments,
  resolveThemeConfiguration,
  resolveExtensionConfig,
  type ConfigDocument,
  type ConfigFiles,
  type CoreConfig,
  type LoadedConfig,
} from "../config/config"
import { writeThemeSelection } from "../config/theme-config-writer"
import { buildConfigSchema, buildThemeDocumentSchema } from "../config/schema"
import { LayoutHost } from "../ui/layout"
import { installKeymap, KeybindingHost } from "../ui/keybindings"
import { ListQueryHost } from "../ui/list-query-host"
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
import { defaultTheme, findThemePreset, themePresets, ThemeStore } from "./theme"
import { publishTypeEnvironment } from "./type-environment"
import {
  buildThemeCatalog,
  createSystemTheme,
  defaultThemeDirectories,
  loadThemeCatalog,
  retainLastValidThemes,
  themeFilesFingerprint,
  type ThemeAppearance,
  type ThemeCatalog,
  type ThemeDirectories,
  type ThemeSelection,
} from "../theme"

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
  /** Declarative Theme resources, independently watched from executable Extensions. */
  readonly themeDirectories?: ThemeDirectories
  /** Disable filesystem Theme resources for constrained embedders; bundled themes still work. */
  readonly themeResources?: boolean
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

/** How many Panes the number row can jump to. A tenth is still reachable with `tab`. */
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

interface ThemePickerEntry {
  readonly label: string
  readonly hint: string
  readonly selection: ThemeSelection
}

export class ExtensionKernel {
  readonly diagnostics = new Diagnostics()
  readonly theme = new ThemeStore()
  readonly registry: UiSlotRegistry
  readonly panes: PaneHost
  readonly layout = new LayoutHost()
  readonly popups = new PopupHost()
  readonly notifications = new NotificationHost()
  readonly listQuery = new ListQueryHost()
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
  readonly #themeDirectories: ThemeDirectories
  readonly #themeResourcesEnabled: boolean
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
  readonly #disposeThemeBackground: () => void
  /** Live `useKeyCapture` claims, most recent last — React unmounts in no particular order. */
  readonly #captureClaims: { readonly paneId: string }[] = []
  /** The `1`–`9` Commands, in the order they number the Layout. */
  readonly #jumpKeys: Disposable[] = []
  /** What the live jump Commands were built from; re-registration is skipped while it holds. */
  #jumpSignature = ""
  #config: LoadedConfig = emptyConfig
  #themeCatalog: ThemeCatalog = buildThemeCatalog(themePresets, [])
  #appearance: ThemeAppearance
  #systemTheme = defaultTheme
  #paletteRefresh: Promise<void> | undefined
  #paletteGeneration = 0
  #modalFocus: { readonly renderable: Renderable | null } | undefined
  #leader: string | undefined
  #disposeLeader: (() => void) | undefined
  #snapshot: readonly ExtensionStatus[] = []
  #reloadGeneration = 0
  #reloadTimer: ReturnType<typeof setTimeout> | undefined
  #watchTimer: ReturnType<typeof setInterval> | undefined
  #watchTree = ""
  #watchConfig = ""
  #watchThemes = ""
  #activatedTree = ""
  #activatedThemes = ""
  #activatedSections = ""
  #watchScan: Promise<void> | undefined
  #reloadTail: Promise<void> = Promise.resolve()
  #stopPromise: Promise<void> | undefined
  #stopped = false
  #schemaContributions: readonly {
    readonly name: string
    readonly description?: string
    readonly config?: ConfigSchema
  }[] = []

  constructor(options: ExtensionKernelOptions) {
    this.#repoRoot = options.repoRoot
    this.#directories = options.directories
    this.#themeDirectories = options.themeDirectories ?? defaultThemeDirectories(options.repoRoot)
    this.#themeResourcesEnabled = options.themeResources ?? true
    this.#searchPath = extensionScopePrecedence.map((scope) => this.#directories[scope])
    this.#configFiles = options.configFiles ?? defaultConfigFiles(options.repoRoot)
    this.#watchEnabled = options.watch ?? true
    this.#debounceMs = options.debounceMs ?? 80
    this.#pollMs = options.pollMs ?? 250
    this.#renderer = options.renderer
    this.#appearance = options.renderer.themeMode ?? "dark"
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
    // Not a field initializer: those run before the constructor body, so `options.repoRoot`
    // would not be on `this` yet. Construction does no I/O — `prime()` opens the repository.
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
      listQuery: {
        register: (paneId, id, input, initial) => this.listQuery.register(paneId, id, input, initial),
      },
      theme: this.theme,
    }

    this.#disposeThemeBackground = this.theme.subscribe(() => this.#syncRendererBackground())
    this.#syncRendererBackground()
    this.panes.subscribe(() => this.layout.setPanes(this.panes.getSnapshot()))
    this.layout.subscribe(() => this.#syncJumpKeys())
    this.git.store.onPublish((publication) => this.#emitGitEvents(publication))
    this.layout.setFocusListener((paneId, previous) => {
      this.keybindings.setFocusedPane(paneId)
      this.listQuery.setFocusedPane(paneId)
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
    // The bundled directory is absent on purpose: it ships inside the installation.
    const userDirectories = userWritableExtensionScopes.map((scope) => this.#directories[scope])
    const writableDirectories = this.#themeResourcesEnabled
      ? [...userDirectories, ...Object.values(this.#themeDirectories)]
      : userDirectories
    await Promise.all(writableDirectories.map((directory) => mkdir(directory, { recursive: true })))
    if (this.#stopped) return

    // Before the first fingerprint, so the files this writes are part of the tree the reload
    // starts from rather than an edit the next poll picks up.
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
    // Regaining focus is when the screen is most likely to be stale, and the worst moment to
    // wait out a poll interval.
    this.#renderer.on(CliRenderEvents.FOCUS, this.#refreshOnFocus)
    this.#renderer.on(CliRenderEvents.THEME_MODE, this.#onThemeMode)
    this.#renderer.on(CliRenderEvents.PALETTE, this.#onPalette)
    if (this.#usesSystemTheme()) void this.#refreshSystemPalette()
    if (this.#watchEnabled) this.#startWatcher()
  }

  readonly #refreshOnFocus = (): void => {
    void this.git.refresh()
  }

  readonly #onThemeMode = (mode: ThemeMode): void => {
    if (this.#stopped || mode === this.#appearance) return
    this.#appearance = mode
    this.#systemTheme = mode === "light" ? (findThemePreset("daybreak")?.tokens ?? defaultTheme) : defaultTheme
    this.#refreshConfiguredTheme()
    this.#renderer.clearPaletteCache()
    if (this.#usesSystemTheme()) void this.#refreshSystemPalette()
  }

  readonly #onPalette = (colors: TerminalColors): void => {
    if (this.#stopped) return
    this.#systemTheme = createSystemTheme(colors, this.#appearance, this.#systemTheme)
    if (this.#usesSystemTheme()) this.#refreshConfiguredTheme()
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

  async openThemePicker(): Promise<void> {
    const automaticPairs = [
      ["Laziergit", "nocturne", "daybreak"],
      ["Catppuccin", "catppuccin-mocha", "catppuccin-latte"],
      ["Gruvbox", "gruvbox-dark", "gruvbox-light"],
      ["Solarized", "solarized-dark", "solarized-light"],
    ] as const
    const entries: ThemePickerEntry[] = [
      {
        label: "system",
        hint: "terminal palette · automatic",
        selection: "system",
      },
      ...automaticPairs
        .filter(([, dark, light]) => this.#themeCatalog.has(dark) && this.#themeCatalog.has(light))
        .map(([label, dark, light]) => ({
          label: `Automatic · ${label}`,
          hint: `${dark} / ${light}`,
          selection: { dark, light },
        })),
      ...this.#themeCatalog.list().map((entry) => ({
        label: entry.name,
        hint: `${entry.appearance ?? "any"} · ${entry.description}`,
        selection: entry.name,
      })),
    ]
    const previous = this.theme.getSnapshot()
    const overrides = this.#config.core.themeConfiguration.overrides
    const preview = (selection: ThemeSelection): void => {
      this.theme.replace(resolveThemeConfiguration({ selection, overrides }, this.#themeOptions()))
    }

    const index = await this.popups.choose(coreOwner, {
      title: "Theme",
      placeholder: "Filter themes",
      choices: entries,
      onHighlight: (highlighted) => {
        const entry = highlighted === undefined ? undefined : entries[highlighted]
        if (entry) preview(entry.selection)
        else this.theme.replace(previous)
      },
    }).promise
    const picked = index === undefined ? undefined : entries[index]
    if (!picked) {
      this.theme.replace(previous)
      return
    }

    // `choose` clears its temporary preview when it settles. Keep the selected palette visible
    // while the user decides which layered config owns it.
    preview(picked.selection)
    const scope = await this.popups.choose(coreOwner, {
      title: "Save theme",
      choices: [
        { label: "All repositories", hint: this.#configFiles.global },
        { label: "This repository", hint: this.#configFiles.repo },
      ],
    }).promise
    if (scope === undefined) {
      this.theme.replace(previous)
      return
    }

    const path = scope === 0 ? this.#configFiles.global : this.#configFiles.repo
    try {
      await writeThemeSelection(path, picked.selection)
      await this.#applyChanges()
      this.#notifier({
        extension: coreOwner,
        level: "success",
        message: `Theme saved to ${scope === 0 ? "global" : "repository"} config`,
      })
    } catch (error) {
      this.theme.replace(previous)
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "config", message: `${path}: ${normalized.message}`, error: normalized })
      this.#notifier({ extension: coreOwner, level: "error", message: `Could not save theme: ${normalized.message}` })
    }
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
   * One event per changed {@link GitState} slice, then `git.refreshed` for the cycle itself.
   * `Object.is` suffices because the store keeps unchanged slices referentially stable.
   */
  #emitGitEvents({ previous, current }: GitPublication): void {
    // The mapped type makes a new GitState slice a compile error until it has an event.
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

    // Never `mod+` (ADR-0004): a terminal that can report cmd is also free to keep it, and
    // Warp keeps cmd+p for its own palette.
    register({ id: "app.palette", title: "Command palette", keys: ["ctrl+p", ":"], run: () => this.openPalette() })
    register({ id: "app.theme", title: "Choose theme", run: () => this.openThemePicker() })
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
   * Rebuilds the `1`–`9` Commands so each digit names the Pane it currently jumps to. Core
   * owns these rather than each Extension claiming a digit, so a Pane's number is its position
   * in the user's Layout and a third-party Pane is reachable the moment it is placed.
   *
   * Keyed on a signature of the titles rather than rebuilt on every publish: the Layout also
   * republishes on focus changes, and that would rebuild every keymap layer per keypress.
   * `hidden` keeps them out of the palette; the cheat sheet still lists them (§5.8).
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
   * A capture collapses the sheet to one section — the capturing Pane's `capture: true`
   * Commands — because every other key is typing letters into a textarea. An empty section is
   * still drawn: a Pane that captures with no exit Command has trapped the user.
   *
   * Otherwise: the focused Pane's keys, its capture Commands, then the globals.
   */
  #cheatSheetSections(): readonly CheatSheetSection[] {
    const entries = this.commands.getSnapshot()
    const focused = this.layout.focusedPaneId
    const capturing = this.keybindings.capturingPaneId
    if (capturing !== null) {
      return [{ title: `${capturing} (capturing keys)`, entries: this.#captureEntries(entries, capturing) }]
    }

    const sections: CheatSheetSection[] = []
    // Only a live Pane: a Command bound into one nothing registered cannot be pressed.
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

  #themeOptions() {
    return {
      catalog: this.#themeCatalog,
      appearance: this.#appearance,
      systemTheme: this.#systemTheme,
    } as const
  }

  #usesSystemTheme(): boolean {
    const selection = this.#config.core.themeConfiguration.selection
    return typeof selection === "string" ? selection === "system" : selection[this.#appearance] === "system"
  }

  #refreshConfiguredTheme(): void {
    this.theme.replace(resolveThemeConfiguration(this.#config.core.themeConfiguration, this.#themeOptions()))
  }

  #syncRendererBackground(): void {
    try {
      this.#renderer.setBackgroundColor(this.theme.getSnapshot().background)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({
        phase: "render",
        message: `Applying renderer background: ${normalized.message}`,
        error: normalized,
      })
    }
  }

  #refreshSystemPalette(): Promise<void> {
    const generation = ++this.#paletteGeneration
    const refresh = this.#renderer
      .getPalette({ size: 16, timeout: 300 })
      .then((colors) => {
        if (this.#stopped || generation !== this.#paletteGeneration) return
        this.#systemTheme = createSystemTheme(colors, this.#appearance, this.#systemTheme)
        if (this.#usesSystemTheme()) this.#refreshConfiguredTheme()
      })
      .catch((error: unknown) => {
        if (this.#stopped || generation !== this.#paletteGeneration) return
        const normalized = normalizeError(error)
        this.#diagnose({ phase: "config", message: `system theme: ${normalized.message}`, error: normalized })
      })
      .finally(() => {
        if (this.#paletteRefresh === refresh) this.#paletteRefresh = undefined
      })
    this.#paletteRefresh = refresh
    return refresh
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

  async #loadThemes(): Promise<void> {
    let fingerprint = ""
    try {
      fingerprint = await themeFilesFingerprint(this.#themeDirectories)
      const loaded = await loadThemeCatalog({
        presets: themePresets,
        directories: this.#themeDirectories,
      })
      this.#themeCatalog = retainLastValidThemes(this.#themeCatalog, loaded)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#diagnose({ phase: "config", message: `Loading themes: ${normalized.message}`, error: normalized })
      this.#themeCatalog = buildThemeCatalog(themePresets, [])
    }

    this.#watchThemes = fingerprint
    this.#activatedThemes = fingerprint
    for (const diagnostic of this.#themeCatalog.diagnostics) {
      this.#diagnose({
        phase: "config",
        message: `${diagnostic.path}${diagnostic.property ? ` (${diagnostic.property})` : ""}: ${diagnostic.message}`,
      })
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

    const loaded = loadConfig(documents, this.#themeOptions())
    this.#config = loaded
    this.#watchConfig = documentFingerprint(documents)
    this.#activatedSections = sectionFingerprint(loaded)
    this.#applyCoreConfig(loaded.core)
    if (this.#usesSystemTheme()) void this.#refreshSystemPalette()
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
      if (this.#themeResourcesEnabled) await this.#loadThemes()
      await this.#loadConfig()
      // `ctx.git.state` is documented as always present, so the store loads before any
      // Extension activates. Idempotent, so a reload publishes no spurious change.
      await this.git.prime()
      if (this.#stopped) return
      // Fingerprinted before reading a single Extension, so an edit landing mid-reload differs
      // from what was loaded and the next poll picks it up.
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
      // whichever Extension the `needs` graph activated first.
      this.layout.settleInitialFocus()
    } finally {
      this.panes.finishReload(previousOwners)
    }
  }

  async #publishSchema(selected: ReadonlyMap<string, ImportedExtension>): Promise<void> {
    this.#schemaContributions = [...selected.values()].map((item) => ({
      name: item.extension.spec.name,
      description: item.extension.spec.description,
      config: item.extension.spec.config,
    }))
    await this.#publishSchemas()
  }

  async #publishSchemas(): Promise<void> {
    const publications = [
      {
        path: `${dirname(this.#configFiles.global)}/config.schema.json`,
        value: buildConfigSchema(this.#schemaContributions, this.#themeCatalog),
      },
      ...(this.#themeResourcesEnabled
        ? [
            {
              path: `${dirname(this.#configFiles.global)}/theme.schema.json`,
              value: buildThemeDocumentSchema(this.#themeCatalog),
            },
          ]
        : []),
    ]
    await Promise.all(
      publications.map(async ({ path, value }) => {
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
        } catch (error) {
          const normalized = normalizeError(error)
          this.#diagnose({ phase: "config", message: `${path}: ${normalized.message}`, error: normalized })
        }
      }),
    )
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
      // Scopes cannot tie — a same-scope collision was rejected above — so ranking decides.
      const winner =
        extensionScopeRank(item.candidate.scope) > extensionScopeRank(current.candidate.scope) ? item : current
      selected.set(name, winner)
      shadowed.set(name, [...(shadowed.get(name) ?? []), winner === item ? current : item])
    }

    // Only once every scope is walked: with three scopes the first copy to beat a shadowed one
    // need not be the last, and the message names which copy is actually running.
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

      // The other direction from scope closure: menus opened by someone else that are showing
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
      const [tree, documents, themes] = await Promise.all([
        this.#treeFingerprint(),
        readConfigDocuments(this.#configFiles),
        this.#themeResourcesEnabled ? themeFilesFingerprint(this.#themeDirectories) : Promise.resolve(""),
      ])
      const config = documentFingerprint(documents)
      if (this.#stopped || (tree === this.#watchTree && config === this.#watchConfig && themes === this.#watchThemes))
        return

      this.#watchTree = tree
      this.#watchConfig = config
      this.#watchThemes = themes
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
      const [tree, documents, themes] = await Promise.all([
        this.#treeFingerprint(),
        readConfigDocuments(this.#configFiles),
        this.#themeResourcesEnabled ? themeFilesFingerprint(this.#themeDirectories) : Promise.resolve(""),
      ])
      const themesChanged = themes !== this.#activatedThemes
      if (themesChanged) await this.#loadThemes()
      const loaded = loadConfig(documents, this.#themeOptions())
      this.#watchTree = tree
      this.#watchConfig = documentFingerprint(documents)
      this.#watchThemes = themes
      if (tree !== this.#activatedTree || sectionFingerprint(loaded) !== this.#activatedSections) {
        await this.reload()
        return
      }

      this.#config = loaded
      this.#applyCoreConfig(loaded.core)
      if (this.#usesSystemTheme()) void this.#refreshSystemPalette()
      if (themesChanged) await this.#publishSchemas()
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
    await this.#attemptShutdown("terminal palette query", async () => {
      await this.#paletteRefresh
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
      this.#renderer.off(CliRenderEvents.THEME_MODE, this.#onThemeMode)
      this.#renderer.off(CliRenderEvents.PALETTE, this.#onPalette)
      this.#disposeThemeBackground()
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
