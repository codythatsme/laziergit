import type { CommandSpec, Disposable } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"
import { assertScopedId } from "./id"
import { createNotifier, type Notifier } from "./notifier"

/** One Command as the palette, cheat sheet, and keybinding layers see it. */
export interface CommandEntry {
  readonly id: string
  readonly owner: string
  readonly title: string
  /** Pane id this Command is bound inside, or undefined for a global Command. */
  readonly pane: string | undefined
  readonly hidden: boolean
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

/** Deduplicated: one Command claiming a key twice must not register the binding twice. */
function declaredKeys(spec: CommandSpec): readonly string[] {
  if (spec.keys === undefined) return []
  return [...new Set(typeof spec.keys === "string" ? [spec.keys] : spec.keys)]
}

function scopeOf(entry: { readonly pane?: string }): string {
  return entry.pane ?? ""
}

/**
 * The Command catalog: one registration yields a keybinding, a palette row, and a
 * cheat-sheet row. Key resolution (user overrides, conflicts) happens here rather than
 * in the keymap layer, so every surface agrees on which keys a Command really has and
 * the rules stay testable without a renderer.
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
   * Two passes, because the two kinds of claim are not equal. Keys the user set in config
   * are claimed first and cannot be taken: an Extension's declared default must never
   * quietly steal a key its owner deliberately bound elsewhere. Within a pass the later
   * registration wins, mirroring the keymap's own layer precedence; the loser keeps its
   * palette row and loses only the key.
   */
  #resolve(): readonly CommandEntry[] {
    const claimed = new Map<string, string>()
    const keysById = new Map<string, string[]>()
    const configured = new Set<string>()

    const claim = (id: string, command: RegisteredCommand, keys: readonly string[], fromConfig: boolean): void => {
      const accepted: string[] = []
      for (const key of keys) {
        const scope = `${scopeOf(command.spec)}\0${key}`
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
              losing.filter((candidate) => candidate !== key),
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
      if (override !== undefined) claim(id, command, [...new Set(override)], true)
    }
    for (const [id, command] of this.#commands) {
      if (!this.#overrides.has(id)) claim(id, command, declaredKeys(command.spec), false)
    }

    return [...this.#commands].map(([id, command]) => ({
      id,
      owner: command.owner,
      title: command.spec.title,
      pane: command.spec.pane,
      hidden: command.spec.hidden === true,
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
