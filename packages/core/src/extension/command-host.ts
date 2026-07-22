import type { CommandSpec, Disposable } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"
import { assertScopedId } from "./id"
import { createNotifier, type Notifier } from "./notifier"

interface RegisteredCommand {
  readonly owner: string
  readonly spec: CommandSpec
}

export class CommandHost {
  readonly #commands = new Map<string, RegisteredCommand>()
  readonly #diagnostics: Diagnostics
  readonly #focusPane: (id: string) => void
  readonly #notify: Notifier

  constructor(diagnostics: Diagnostics, focusPane: (id: string) => void, notify: Notifier = createNotifier()) {
    this.#diagnostics = diagnostics
    this.#focusPane = focusPane
    this.#notify = notify
  }

  register(owner: string, spec: CommandSpec): Disposable {
    assertScopedId(owner, spec.id)
    if (this.#commands.has(spec.id)) throw new Error(`Command "${spec.id}" is already registered`)

    const registered = { owner, spec }
    this.#commands.set(spec.id, registered)
    return {
      dispose: () => {
        if (this.#commands.get(spec.id) === registered) this.#commands.delete(spec.id)
      },
    }
  }

  registerComponent(owner: string, paneId: string, spec: Omit<CommandSpec, "pane">): Disposable {
    return this.register(owner, { ...spec, pane: paneId })
  }

  async execute(id: string): Promise<void> {
    const command = this.#commands.get(id)
    if (!command) throw new Error(`Unknown command "${id}"`)
    if (command.spec.pane) this.#focusPane(command.spec.pane)

    try {
      await command.spec.run()
    } catch (error) {
      const normalized = normalizeError(error)
      try {
        this.#diagnostics.report({
          extension: command.owner,
          phase: "command",
          message: `${id}: ${normalized.message}`,
          error: normalized,
        })
      } catch {
        // Diagnostics are best-effort and do not change Command execution semantics.
      }
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
}
