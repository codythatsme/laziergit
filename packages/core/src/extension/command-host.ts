import type { CommandSpec, Disposable } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"
import { assertScopedId } from "./id"

interface RegisteredCommand {
  readonly owner: string
  readonly spec: CommandSpec
}

export class CommandHost {
  readonly #commands = new Map<string, RegisteredCommand>()
  readonly #diagnostics: Diagnostics
  readonly #focusPane: (id: string) => void

  constructor(diagnostics: Diagnostics, focusPane: (id: string) => void) {
    this.#diagnostics = diagnostics
    this.#focusPane = focusPane
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
      this.#diagnostics.report({
        extension: command.owner,
        phase: "command",
        message: `${id}: ${normalized.message}`,
        error: normalized,
      })
      throw normalized
    }
  }
}
