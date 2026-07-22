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
 * Priority bands. The keymap breaks ties by registration recency, which across
 * Extensions is arbitrary, so every laziergit layer states its band explicitly.
 */
const globalLayerPriority = 0
const paneLayerPriority = 100
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

  stop(): void {
    this.#stopped = true
    this.#clear()
    this.#matcherListeners.clear()
  }

  #rebuild(): void {
    this.#clear()

    const byScope = new Map<string, CommandEntry[]>()
    for (const entry of this.#entries) {
      if (entry.keys.length === 0) continue
      const scope = entry.pane ?? ""
      const scoped = byScope.get(scope) ?? []
      scoped.push(entry)
      byScope.set(scope, scoped)
    }

    for (const [scope, entries] of byScope) {
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
  #registerScope(scope: string, bindings: readonly Binding<TTarget, TEvent>[]): () => void {
    try {
      return this.#keymap.registerLayer({
        priority: scope === "" ? globalLayerPriority : paneLayerPriority,
        enabled: this.#matcher(scope),
        bindings,
      })
    } catch (error) {
      this.#report(`Dropped the ${scope === "" ? "global" : `"${scope}"`} keybinding layer`, error)
      return () => undefined
    }
  }

  #matcher(scope: string): ReactiveMatcher {
    return {
      get: () => !this.#modalOpen && (scope === "" || this.#focusedPaneId === scope),
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
