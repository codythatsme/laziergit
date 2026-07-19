export type DiagnosticPhase =
  | "discover"
  | "import"
  | "activate"
  | "deactivate"
  | "dispose"
  | "event"
  | "command"
  | "render"
  | "watch"

export interface Diagnostic {
  readonly extension?: string
  readonly phase: DiagnosticPhase
  readonly message: string
  readonly error?: Error
  readonly timestamp: number
}

export class Diagnostics {
  #entries: readonly Diagnostic[] = []
  readonly #listeners = new Set<() => void>()

  getSnapshot = (): readonly Diagnostic[] => this.#entries

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  report(input: Omit<Diagnostic, "timestamp">): void {
    const diagnostic = { ...input, timestamp: Date.now() }
    this.#entries = [...this.#entries, diagnostic].slice(-100)

    const prefix = diagnostic.extension ? `[${diagnostic.extension}]` : "[extensions]"
    console.error(`${prefix} ${diagnostic.phase}: ${diagnostic.message}`)
    if (diagnostic.error?.stack) console.error(diagnostic.error.stack)

    for (const listener of this.#listeners) listener()
  }
}

export function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  return new Error(String(error))
}
