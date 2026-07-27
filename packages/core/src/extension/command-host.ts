import type { CommandSpec, Disposable } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"
import { assertScopedId } from "./id"
import { createNotifier, type Notifier } from "./notifier"

/** One Command as the palette, cheat sheet, hint bar, and keybinding layers see it. */
export interface CommandEntry {
  readonly id: string
  readonly owner: string
  readonly title: string
  /** Short hint-bar label, or undefined for a Command that stays off the bar. */
  readonly hint: string | undefined
  /** Pane id this Command is bound inside, or undefined for a global Command. */
  readonly pane: string | undefined
  readonly hidden: boolean
  /**
   * Bound only while {@link pane} is capturing raw keyboard input, instead of only while it
   * is focused. Always false for a global Command: capture is a property of a Pane.
   */
  readonly capture: boolean
  /** The keys actually bound, after config overrides and conflict resolution. */
  readonly keys: readonly string[]
}

/** What the Command layer needs from the Layout: Pane liveness and focus-then-run. */
export interface CommandPaneAccess {
  focus(paneId: string): void
  isLive(paneId: string): boolean
}

interface RegisteredCommand {
  readonly owner: string
  readonly spec: CommandSpec
}

/**
 * The spelling two KeySpecs share exactly when they bind the same physical stroke.
 *
 * @opentui/keymap lowercases every key name when it matches and compares modifier tokens
 * case-insensitively, so folding case here can never invent a conflict the keymap would keep
 * apart — and it closes the one the KeySpec grammar warns about, where `"D"` and `"d"` are one
 * key. Alias and modifier-order spellings are the caller's responsibility: only the keymap's
 * own parser knows them.
 */
export function keyStroke(key: string): string {
  return key.toLowerCase()
}

/**
 * Deduplicated by the stroke each key binds, not by its spelling: a Command claiming both
 * `"s"` and `"S"` claims one physical key and must not register it twice. The author's own
 * spelling is what the cheat sheet shows, so the first spelling of each stroke is kept.
 */
function dedupByStroke(keys: readonly string[]): string[] {
  const byStroke = new Map<string, string>()
  for (const key of keys) {
    const stroke = keyStroke(key)
    if (!byStroke.has(stroke)) byStroke.set(stroke, key)
  }
  return [...byStroke.values()]
}

function declaredKeys(spec: CommandSpec): readonly string[] {
  if (spec.keys === undefined) return []
  return dedupByStroke(typeof spec.keys === "string" ? [spec.keys] : spec.keys)
}

/** A Pane's capture Commands only exist because that Pane has one; a global one cannot capture. */
function capturesOf(spec: CommandSpec): boolean {
  return spec.capture === true && spec.pane !== undefined
}

/**
 * Which claim a key is made against. A Pane's ordinary layer and its capture layer are
 * never enabled at the same time, so the same key may be claimed once in each — `escape`
 * cancelling an edit does not take `escape` away from the Pane's normal mode.
 */
function claimScope(spec: CommandSpec): string {
  return `${spec.pane ?? ""}\0${capturesOf(spec) ? "capture" : "normal"}`
}

/**
 * The Command catalog: one registration yields a keybinding, a palette row, a cheat-sheet row,
 * and — where the author wrote a `hint` — a hint-bar entry. Key resolution happens here rather
 * than in the keymap layer, so every surface agrees on which keys a Command really has.
 */
export class CommandHost {
  readonly #commands = new Map<string, RegisteredCommand>()
  readonly #listeners = new Set<() => void>()
  readonly #reportedConflicts = new Set<string>()
  readonly #diagnostics: Diagnostics
  readonly #panes: CommandPaneAccess
  readonly #notify: Notifier
  #overrides: ReadonlyMap<string, readonly string[]> = new Map()
  #snapshot: readonly CommandEntry[] = []

  constructor(diagnostics: Diagnostics, panes: CommandPaneAccess, notify: Notifier = createNotifier()) {
    this.#diagnostics = diagnostics
    this.#panes = panes
    this.#notify = notify
  }

  getSnapshot = (): readonly CommandEntry[] => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Applies the user's `keybindings` config. An empty key list unbinds the Command. */
  setKeybindings(overrides: ReadonlyMap<string, readonly string[]>): void {
    this.#overrides = overrides
    this.#reportedConflicts.clear()
    this.#publish()
  }

  register(owner: string, spec: CommandSpec): Disposable {
    assertScopedId(owner, spec.id)
    if (this.#commands.has(spec.id)) throw new Error(`Command "${spec.id}" is already registered`)
    if (spec.capture === true && spec.pane === undefined) {
      this.#report("command", owner, `${spec.id}: capture needs a pane and was ignored`)
    }

    const registered = { owner, spec }
    this.#commands.set(spec.id, registered)
    this.#publish()

    return {
      dispose: () => {
        if (this.#commands.get(spec.id) !== registered) return
        this.#commands.delete(spec.id)
        this.#publish()
      },
    }
  }

  registerComponent(owner: string, paneId: string, spec: Omit<CommandSpec, "pane">): Disposable {
    return this.register(owner, { ...spec, pane: paneId })
  }

  /** Commands a palette should offer right now: visible, and live if Pane-scoped. */
  availableEntries(): readonly CommandEntry[] {
    return this.#snapshot.filter((entry) => !entry.hidden && (!entry.pane || this.#panes.isLive(entry.pane)))
  }

  async execute(id: string): Promise<void> {
    const command = this.#commands.get(id)
    if (!command) throw new Error(`Unknown command "${id}"`)
    if (command.spec.pane) this.#panes.focus(command.spec.pane)

    try {
      await command.spec.run()
    } catch (error) {
      const normalized = normalizeError(error)
      this.#report("command", command.owner, `${id}: ${normalized.message}`, normalized)
      try {
        this.#notify({
          extension: command.owner,
          message: `${command.spec.title}: ${normalized.message}`,
          level: "error",
        })
      } catch {
        // Custom notification adapters are isolated from Command execution.
      }
    }
  }

  #publish(): void {
    this.#snapshot = this.#resolve()
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // Snapshot observers cannot poison Command registration.
      }
    }
  }

  /**
   * Two passes, because the two kinds of claim are not equal. Keys the user set in config are
   * claimed first and cannot be taken. Within a pass the later registration wins, mirroring the
   * keymap's own layer precedence; the loser keeps its palette row and loses only the key.
   */
  #resolve(): readonly CommandEntry[] {
    const claimed = new Map<string, string>()
    const keysById = new Map<string, string[]>()
    const configured = new Set<string>()

    const claim = (id: string, command: RegisteredCommand, keys: readonly string[], fromConfig: boolean): void => {
      const accepted: string[] = []
      for (const key of keys) {
        // Scoped by the stroke, not the spelling, so `"D"` and `"d"` contend for one binding.
        const scope = `${claimScope(command.spec)}\0${keyStroke(key)}`
        const previous = claimed.get(scope)
        if (previous !== undefined && !fromConfig && configured.has(scope)) {
          this.#reportConflict(command.owner, key, id, previous)
          continue
        }
        if (previous !== undefined) {
          const losing = keysById.get(previous)
          if (losing)
            keysById.set(
              previous,
              losing.filter((candidate) => keyStroke(candidate) !== keyStroke(key)),
            )
          this.#reportConflict(command.owner, key, previous, id)
        }
        claimed.set(scope, id)
        if (fromConfig) configured.add(scope)
        accepted.push(key)
      }
      keysById.set(id, accepted)
    }

    for (const [id, command] of this.#commands) {
      const override = this.#overrides.get(id)
      if (override !== undefined) claim(id, command, dedupByStroke(override), true)
    }
    for (const [id, command] of this.#commands) {
      if (!this.#overrides.has(id)) claim(id, command, declaredKeys(command.spec), false)
    }

    return [...this.#commands].map(([id, command]) => ({
      id,
      owner: command.owner,
      title: command.spec.title,
      hint: command.spec.hint,
      pane: command.spec.pane,
      hidden: command.spec.hidden === true,
      capture: capturesOf(command.spec),
      keys: Object.freeze(keysById.get(id) ?? []),
    }))
  }

  #reportConflict(owner: string, key: string, previous: string, winner: string): void {
    const signature = `${previous}\0${winner}\0${key}`
    if (this.#reportedConflicts.has(signature)) return
    this.#reportedConflicts.add(signature)
    this.#report("command", owner, `Key "${key}" moved from "${previous}" to "${winner}"`)
  }

  #report(phase: "command", owner: string, message: string, error?: Error): void {
    try {
      this.#diagnostics.report({ extension: owner, phase, message, error })
    } catch {
      // Diagnostics are best-effort and do not change Command execution semantics.
    }
  }
}
