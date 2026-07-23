import type { Disposable, GitState } from "laziergit"

import { emptyGitState, reconcileGitState } from "./state"

export interface GitPublication {
  readonly previous: GitState
  readonly current: GitState
}

/**
 * The single canonical snapshot every reader shares — React panes through `useGit`,
 * activate-scope code through `ctx.git.subscribe`, and the kernel's event bridge — so no
 * two consumers can disagree about the repository mid-render.
 *
 * `getSnapshot` and `subscribe` are bound arrow properties because `useSyncExternalStore`
 * calls them unbound, and `getSnapshot` returns the *same* object until a publish happens:
 * React re-reads it repeatedly per render and treats a fresh object as a change.
 */
export class GitStore {
  readonly #listeners = new Set<() => void>()
  readonly #publications = new Set<(publication: GitPublication) => void>()
  readonly #report: (error: unknown) => void
  #snapshot: GitState = emptyGitState

  constructor(report: (error: unknown) => void) {
    this.#report = report
  }

  getSnapshot = (): GitState => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** The non-React face: fires only when the selected value changes, per the public contract. */
  subscribeSelector<T>(selector: (state: GitState) => T, onChange: (value: T, previous: T) => void): Disposable {
    let current: T
    try {
      current = selector(this.#snapshot)
    } catch (error) {
      this.#report(error)
      return { dispose: () => undefined }
    }

    const listener = (publication: GitPublication): void => {
      const next = selector(publication.current)
      if (Object.is(next, current)) return
      const previous = current
      current = next
      onChange(next, previous)
    }

    this.#publications.add(listener)
    return {
      dispose: () => {
        this.#publications.delete(listener)
      },
    }
  }

  /** Observes every publish with both snapshots — how the kernel derives `git.<slice>.changed`. */
  onPublish(listener: (publication: GitPublication) => void): () => void {
    this.#publications.add(listener)
    return () => {
      this.#publications.delete(listener)
    }
  }

  /**
   * Installs `next`, keeping every unchanged part of the previous snapshot referentially
   * stable, then notifies. Listeners run *after* the swap because React re-reads the
   * snapshot from inside the notification, and each runs in isolation so one failing pane
   * cannot starve the rest.
   */
  publish(next: GitState): GitPublication {
    const previous = this.#snapshot
    const current = reconcileGitState(previous, next)
    this.#snapshot = current
    const publication: GitPublication = { previous, current }

    // Snapshotted so a listener may unsubscribe from inside the notification, then
    // re-checked so one that was unsubscribed *by an earlier listener in the same pass*
    // is not called anyway — a disposed subscription must go quiet immediately.
    const publications = [...this.#publications]
    for (const listener of publications) {
      if (!this.#publications.has(listener)) continue
      try {
        listener(publication)
      } catch (error) {
        this.#report(error)
      }
    }

    // React listeners only ever say "something changed"; skipping them when nothing did
    // avoids a render pass per poll tick on an idle repository.
    if (!Object.is(previous, current)) {
      const listeners = [...this.#listeners]
      for (const listener of listeners) {
        if (!this.#listeners.has(listener)) continue
        try {
          listener()
        } catch (error) {
          this.#report(error)
        }
      }
    }
    return publication
  }
}
