import type { HostListQueryRegistration, HostListQueryState } from "laziergit/host"

export interface ListQuerySnapshot extends HostListQueryState {
  readonly paneId: string
  readonly id: string
  readonly input: (value: string) => void
}

interface Registration {
  readonly paneId: string
  readonly id: string
  readonly input: (value: string) => void
  state: HostListQueryState
}

/**
 * Query state contributed by list hooks. Core selects only the focused Pane's active query;
 * matching and cursor behavior remain inside the Extension-facing hook.
 */
export class ListQueryHost {
  readonly #registrations = new Map<string, Registration>()
  readonly #listeners = new Set<() => void>()
  #focusedPaneId: string | null = null
  #snapshot: ListQuerySnapshot | null = null

  getSnapshot = (): ListQuerySnapshot | null => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  setFocusedPane(paneId: string | null): void {
    if (this.#focusedPaneId === paneId) return
    this.#focusedPaneId = paneId
    this.#publish()
  }

  register(
    paneId: string,
    id: string,
    input: (value: string) => void,
    initial: HostListQueryState,
  ): HostListQueryRegistration {
    const key = this.#key(paneId, id)
    if (this.#registrations.has(key)) {
      throw new Error(`List query "${id}" is already registered in Pane "${paneId}"`)
    }

    const registration: Registration = { paneId, id, input, state: initial }
    this.#registrations.set(key, registration)
    this.#publish()

    let disposed = false
    return {
      update: (state) => {
        if (disposed || this.#registrations.get(key) !== registration) return
        if (this.#sameState(registration.state, state)) return
        registration.state = state
        this.#publish()
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.#registrations.get(key) === registration) this.#registrations.delete(key)
        this.#publish()
      },
    }
  }

  #key(paneId: string, id: string): string {
    return `${paneId}\0${id}`
  }

  #sameState(left: HostListQueryState, right: HostListQueryState): boolean {
    return (
      left.mode === right.mode &&
      left.value === right.value &&
      left.editing === right.editing &&
      left.matchCount === right.matchCount &&
      left.totalCount === right.totalCount &&
      left.currentMatch === right.currentMatch
    )
  }

  #resolve(): ListQuerySnapshot | null {
    if (this.#focusedPaneId === null) return null
    const candidates = [...this.#registrations.values()].filter(
      (registration) =>
        registration.paneId === this.#focusedPaneId &&
        (registration.state.editing || registration.state.value.length > 0),
    )
    const registration = candidates.at(-1)
    if (registration === undefined) return null
    return {
      paneId: registration.paneId,
      id: registration.id,
      input: registration.input,
      ...registration.state,
    }
  }

  #publish(): void {
    const next = this.#resolve()
    const previous = this.#snapshot
    if (
      previous !== null &&
      next !== null &&
      previous.paneId === next.paneId &&
      previous.id === next.id &&
      previous.input === next.input &&
      this.#sameState(previous, next)
    ) {
      return
    }
    if (previous === null && next === null) return

    this.#snapshot = next
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // A Status Line observer cannot poison query registration.
      }
    }
  }
}
