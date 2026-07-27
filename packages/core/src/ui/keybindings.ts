import type { Binding, BindingExpander, Keymap, KeymapEvent, ReactiveMatcher } from "@opentui/keymap"
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerEscapeClearsPendingSequence,
  registerNeovimDisambiguation,
} from "@opentui/keymap/addons"

import { keyStroke, type CommandEntry } from "../extension/command-host"
import { normalizeError, type Diagnostics } from "../extension/diagnostics"

/**
 * Priority bands, one per {@link LayerScope} kind. Stated explicitly because the keymap
 * otherwise breaks ties by registration recency, which across Extensions is arbitrary.
 * Capture sits above every Pane layer and below a popup.
 */
const layerPriority: Record<LayerScope["kind"], number> = {
  global: 0,
  pane: 100,
  capture: 500,
}
export const modalLayerPriority = 1000

export interface KeymapInstallOptions {
  readonly diagnostics: Diagnostics
}

const modModifierPattern = /(^|[+,\s])mod(?=\s*\+)/i
const modModifierReplacePattern = /(^|[+,\s])mod(?=\s*\+)/gi

/**
 * `mod+` resolution, in place of the keymap's own addon, which maps `mod` to `super` on macOS
 * even in a terminal that can never report it. laziergit's contract is narrower: cmd only
 * where the keyboard protocol proves it works, ctrl everywhere else.
 */
function registerModBindings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  const expand: BindingExpander = ({ input, displays }) => {
    if (!modModifierPattern.test(input)) return undefined

    const metadata = keymap.getHostMetadata()
    const reportable = metadata.primaryModifier === "super" && metadata.modifiers.super === "supported"
    const modifier = reportable ? "super" : "ctrl"
    return [
      {
        key: input.replace(modModifierReplacePattern, (_match, prefix: string) => `${prefix}${modifier}`),
        displays: displays ?? [input],
      },
    ]
  }

  return keymap.appendBindingExpander(expand)
}

/**
 * Installs the addon set laziergit's {@link KeySpec} grammar promises. `<leader>` is
 * registered separately because the config can change it without a reload. The warning and
 * error channels are routed to diagnostics first: with no listener the keymap writes to the
 * console, corrupting the terminal it is drawing on.
 */
export function installKeymap<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  options: KeymapInstallOptions,
): () => void {
  const report = (message: string): void => {
    try {
      options.diagnostics.report({ phase: "keymap", message })
    } catch {
      // Diagnostics are observers and cannot poison key dispatch.
    }
  }

  const disposers = [
    keymap.on("warning", (event) => report(`${event.code}: ${event.message}`)),
    keymap.on("error", (event) => report(`${event.code}: ${event.message}`)),
    registerDefaultKeys(keymap),
    registerEnabledFields(keymap),
    registerModBindings(keymap),
    registerNeovimDisambiguation(keymap),
    registerEscapeClearsPendingSequence(keymap),
  ]

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Keymap teardown is best-effort; one failed disposer cannot block the rest.
      }
    }
  }
}

/**
 * The audience of one keymap layer. A `"capture"` layer names a Pane because capture is a
 * property of a Pane, so a capturing global layer is not a state this type can describe.
 */
type LayerScope = { readonly kind: "global" } | { readonly kind: "pane" | "capture"; readonly paneId: string }

/**
 * One key that would fire if it were pressed right now, and what it would do. Derived from the
 * same state the layer matchers read, so the hint bar cannot claim a key the keymap would
 * route elsewhere.
 */
export interface LiveBinding {
  readonly id: string
  /** As its author spelled it — the first of the Command's keys no higher band has claimed. */
  readonly key: string
  readonly title: string
  /** The short bar label, or undefined for a Command that stays off the bar. */
  readonly hint: string | undefined
}

const noBindings: readonly LiveBinding[] = Object.freeze([])

function scopeOf(entry: CommandEntry): LayerScope {
  if (entry.pane === undefined) return { kind: "global" }
  return { kind: entry.capture ? "capture" : "pane", paneId: entry.pane }
}

function describeScope(scope: LayerScope): string {
  if (scope.kind === "global") return "global"
  return scope.kind === "capture" ? `"${scope.paneId}" capture` : `"${scope.paneId}"`
}

function scopeKey(scope: LayerScope): string {
  return scope.kind === "global" ? "\0global" : `${scope.paneId}\0${scope.kind}`
}

/**
 * Projects the Command catalog onto keymap layers: one for global Commands and one per Pane,
 * each gated by a reactive matcher rather than by renderer focus, so laziergit's own focus
 * model decides which Pane's keys are live.
 */
export class KeybindingHost<TTarget extends object, TEvent extends KeymapEvent> {
  readonly #keymap: Keymap<TTarget, TEvent>
  readonly #diagnostics: Diagnostics
  readonly #execute: (id: string) => void
  readonly #layers: (() => void)[] = []
  readonly #matcherListeners = new Set<() => void>()
  readonly #liveListeners = new Set<() => void>()
  #live: readonly LiveBinding[] = noBindings
  #entries: readonly CommandEntry[] = []
  #focusedPaneId: string | null = null
  #capturingPane: string | null = null
  #modalOpen = false
  #rebuildScheduled = false
  #stopped = false

  constructor(keymap: Keymap<TTarget, TEvent>, diagnostics: Diagnostics, execute: (id: string) => void) {
    this.#keymap = keymap
    this.#diagnostics = diagnostics
    this.#execute = execute
  }

  /**
   * The keys that would fire right now, in registration order. An external store, so the bound
   * arrow properties are load-bearing.
   */
  getSnapshot = (): readonly LiveBinding[] => this.#live

  subscribe = (listener: () => void): (() => void) => {
    this.#liveListeners.add(listener)
    return () => this.#liveListeners.delete(listener)
  }

  /** Rebuilds layers from the catalog. Bursts of registrations coalesce into one rebuild. */
  sync(entries: readonly CommandEntry[]): void {
    this.#entries = entries
    this.#publishLive()
    if (this.#stopped || this.#rebuildScheduled) return
    this.#rebuildScheduled = true
    queueMicrotask(() => {
      this.#rebuildScheduled = false
      if (!this.#stopped) this.#rebuild()
    })
  }

  /**
   * The Pane whose capture is actually in force. A capture only counts while its Pane is
   * focused, so an Extension focusing another Pane mid-edit cannot leave a background Pane
   * holding the keyboard with no key to get out with.
   */
  get capturingPaneId(): string | null {
    return this.#capturingPane !== null && this.#capturingPane === this.#focusedPaneId ? this.#capturingPane : null
  }

  setFocusedPane(paneId: string | null): void {
    if (this.#focusedPaneId === paneId) return
    this.#focusedPaneId = paneId
    this.#invalidate()
  }

  /** While a modal owns the screen, every Pane and global layer goes inert. */
  setModalOpen(open: boolean): void {
    if (this.#modalOpen === open) return
    this.#modalOpen = open
    this.#invalidate()
  }

  /**
   * While a Pane captures raw keyboard input, every other layer goes inert and only that
   * Pane's `capture: true` Commands stay live. The same mechanism as {@link setModalOpen}, one
   * band lower, so a popup opened mid-edit still wins.
   */
  setCapturingPane(paneId: string | null): void {
    if (this.#capturingPane === paneId) return
    this.#capturingPane = paneId
    this.#invalidate()
  }

  stop(): void {
    this.#stopped = true
    this.#live = noBindings
    this.#clear()
    this.#matcherListeners.clear()
    this.#liveListeners.clear()
  }

  /**
   * Which layers are live, highest band first — the one answer both the layer matchers and the
   * hint bar read, so a bar can never advertise a key the keymap routes elsewhere.
   */
  #liveScopes(): readonly LayerScope[] {
    if (this.#modalOpen) return []
    const capturing = this.capturingPaneId
    if (capturing !== null) return [{ kind: "capture", paneId: capturing }]
    const focused = this.#focusedPaneId
    const global: LayerScope = { kind: "global" }
    return focused === null ? [global] : [{ kind: "pane", paneId: focused }, global]
  }

  /**
   * The live bindings, resolved against those bands in the order the keymap consults them: a
   * stroke the focused Pane claims shadows the global Command claiming it. Within a band the
   * catalog has already resolved conflicts.
   */
  #resolveLive(): readonly LiveBinding[] {
    const scopes = this.#liveScopes()
    if (scopes.length === 0) return noBindings

    const claimed = new Set<string>()
    const live: LiveBinding[] = []
    for (const scope of scopes) {
      for (const entry of this.#entries) {
        if (scopeKey(scopeOf(entry)) !== scopeKey(scope)) continue
        const key = entry.keys.find((candidate) => !claimed.has(keyStroke(candidate)))
        if (key === undefined) continue
        claimed.add(keyStroke(key))
        live.push({ id: entry.id, key, title: entry.title, hint: entry.hint })
      }
    }
    return Object.freeze(live)
  }

  #publishLive(): void {
    this.#live = this.#stopped ? noBindings : this.#resolveLive()
    for (const listener of Array.from(this.#liveListeners)) {
      try {
        listener()
      } catch {
        // A hint-bar observer cannot change which Pane owns the keyboard.
      }
    }
  }

  #rebuild(): void {
    this.#clear()

    const byScope = new Map<string, { readonly scope: LayerScope; readonly entries: CommandEntry[] }>()
    for (const entry of this.#entries) {
      if (entry.keys.length === 0) continue
      const scope = scopeOf(entry)
      const layer = byScope.get(scopeKey(scope)) ?? { scope, entries: [] }
      layer.entries.push(entry)
      byScope.set(scopeKey(scope), layer)
    }

    for (const { scope, entries } of byScope.values()) {
      const bindings = entries.flatMap((entry) =>
        entry.keys.map((key) => ({ key, cmd: () => this.#dispatch(entry.id) })),
      )
      this.#layers.push(this.#registerScope(scope, bindings))
    }
  }

  /**
   * One layer per scope. A malformed key spec is rejected per binding by the keymap and
   * surfaces on its error channel, so the rest of the scope keeps working; this catch is
   * only for a layer the keymap refuses outright.
   */
  #registerScope(scope: LayerScope, bindings: readonly Binding<TTarget, TEvent>[]): () => void {
    try {
      return this.#keymap.registerLayer({
        priority: layerPriority[scope.kind],
        enabled: this.#matcher(scope),
        bindings,
      })
    } catch (error) {
      this.#report(`Dropped the ${describeScope(scope)} keybinding layer`, error)
      return () => undefined
    }
  }

  #matcher(scope: LayerScope): ReactiveMatcher {
    const key = scopeKey(scope)
    return {
      get: () => this.#liveScopes().some((live) => scopeKey(live) === key),
      subscribe: (onChange) => {
        this.#matcherListeners.add(onChange)
        return () => this.#matcherListeners.delete(onChange)
      },
    }
  }

  /**
   * Commands run after dispatch unwinds: a handler may reload its Extension, and
   * unregistering a layer from inside the dispatch that is walking it is not allowed.
   */
  #dispatch(id: string): void {
    queueMicrotask(() => this.#execute(id))
  }

  #invalidate(): void {
    this.#publishLive()
    for (const listener of Array.from(this.#matcherListeners)) {
      try {
        listener()
      } catch {
        // A matcher observer cannot change which Pane owns the keyboard.
      }
    }
  }

  #clear(): void {
    for (const dispose of this.#layers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.#report("Failed to remove a keybinding layer", error)
      }
    }
  }

  #report(message: string, error: unknown): void {
    const normalized = normalizeError(error)
    try {
      this.#diagnostics.report({ phase: "keymap", message: `${message}: ${normalized.message}`, error: normalized })
    } catch {
      // Diagnostics are observers and cannot poison keybinding rebuilds.
    }
  }
}
