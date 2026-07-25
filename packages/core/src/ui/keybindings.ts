import type { Binding, BindingExpander, Keymap, KeymapEvent, ReactiveMatcher } from "@opentui/keymap"
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerEscapeClearsPendingSequence,
  registerNeovimDisambiguation,
} from "@opentui/keymap/addons"

import type { CommandEntry } from "../extension/command-host"
import { normalizeError, type Diagnostics } from "../extension/diagnostics"

/**
 * Priority bands, one per {@link LayerScope} kind. The keymap breaks ties by registration
 * recency, which across Extensions is arbitrary, so every laziergit layer states its band
 * explicitly. Capture sits above every Pane layer and below a popup: a modal still
 * outranks a Pane that captures keys.
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
 * `mod+` resolution, in place of the keymap's own addon. Upstream maps `mod` to the
 * platform's primary modifier whenever that modifier is not known to be *unsupported*,
 * which on macOS means `super` even in a terminal that can never report it — a binding
 * the user could not press. laziergit's {@link KeySpec} contract is the narrower one:
 * cmd only where the keyboard protocol proves it works, ctrl everywhere else.
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
 * Installs the addon set laziergit's {@link KeySpec} grammar promises: the default
 * parser, `enabled` layer gating, platform-aware `mod+`, escape-cancels-sequence, and
 * the ambiguity resolver that makes `g` and `gg` coexist in one Pane. `<leader>` is
 * registered separately because the config can change it without a reload. Warning and
 * error channels are routed to diagnostics first — without listeners the keymap writes
 * to the console, which corrupts the terminal it is drawing on.
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
 * The audience of one keymap layer: whose Commands it carries, and in which mode. A
 * `"capture"` layer carries the `capture: true` Commands that are live only while its Pane
 * is capturing raw input, and it names a Pane because capture is a property of a Pane —
 * a global Command's {@link CommandEntry.capture} is always false, so a capturing global
 * layer is not a state this type can describe.
 */
type LayerScope = { readonly kind: "global" } | { readonly kind: "pane" | "capture"; readonly paneId: string }

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
 * Projects the Command catalog onto keymap layers: one layer for global Commands and
 * one per Pane, each gated by a reactive matcher rather than by renderer focus, so
 * laziergit's own focus model — not whichever Renderable happens to hold the cursor —
 * decides which Pane's keys are live.
 */
export class KeybindingHost<TTarget extends object, TEvent extends KeymapEvent> {
  readonly #keymap: Keymap<TTarget, TEvent>
  readonly #diagnostics: Diagnostics
  readonly #execute: (id: string) => void
  readonly #layers: (() => void)[] = []
  readonly #matcherListeners = new Set<() => void>()
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

  /** Rebuilds layers from the catalog. Bursts of registrations coalesce into one rebuild. */
  sync(entries: readonly CommandEntry[]): void {
    this.#entries = entries
    if (this.#stopped || this.#rebuildScheduled) return
    this.#rebuildScheduled = true
    queueMicrotask(() => {
      this.#rebuildScheduled = false
      if (!this.#stopped) this.#rebuild()
    })
  }

  /**
   * The Pane whose capture is actually in force, if any.
   *
   * A capture only counts while its Pane is focused. Focus cannot leave a capturing Pane by
   * keyboard — that is the point — so this guards the other door: an Extension focusing
   * another Pane while an editor is open would otherwise leave a background Pane holding
   * the keyboard with no key left to get out with.
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
   * While a Pane captures raw keyboard input — an editor inside it owns the keys — the
   * global layer and every Pane layer go inert, and only that Pane's `capture: true`
   * Commands stay live. Deliberately the same mechanism as {@link setModalOpen}, one
   * priority band lower, so a popup opened mid-edit still wins.
   */
  setCapturingPane(paneId: string | null): void {
    if (this.#capturingPane === paneId) return
    this.#capturingPane = paneId
    this.#invalidate()
  }

  stop(): void {
    this.#stopped = true
    this.#clear()
    this.#matcherListeners.clear()
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
    return {
      get: () => {
        if (this.#modalOpen) return false
        const capturing = this.capturingPaneId
        // A capture layer answers only to its own Pane's capture; every other layer is
        // suppressed for as long as any capture is in force.
        if (scope.kind === "capture") return capturing === scope.paneId
        if (capturing !== null) return false
        return scope.kind === "global" || this.#focusedPaneId === scope.paneId
      },
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
