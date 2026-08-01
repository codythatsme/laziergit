import type { CommandHandle, CommandSpec, Disposable, EventMap, GitActivity, GitState, Theme } from "./types"

export type HostListQueryMode = "filter" | "search"

export interface HostListQueryState {
  readonly mode: HostListQueryMode
  /** Draft while editing, applied query otherwise. Empty only while the editor is open. */
  readonly value: string
  readonly editing: boolean
  readonly matchCount: number
  readonly totalCount: number
  /** Zero-based search-result position. Filters report the cursor through their visible list. */
  readonly currentMatch: number | null
}

export interface HostListQueryRegistration extends Disposable {
  update(state: HostListQueryState): void
}

/**
 * What the hooks in this package reach for, and therefore what the host must put on the React
 * context. Not extension-facing: reachable only as `laziergit/host`, since an Extension author
 * never implements it. It cannot live in `@laziergit/runtime-bridge` because every member is
 * spelled in this package's own vocabulary, which would make the dependency circular.
 */
export interface HostRuntime {
  readonly git: {
    getSnapshot(this: void): GitState
    subscribe(this: void, listener: () => void): () => void
  }
  /**
   * Its own store rather than a member of `git` above: the two turn over on completely
   * different schedules, and a `useGit` selector must not re-run because a `git add` started.
   */
  readonly activity: {
    getSnapshot(this: void): readonly GitActivity[]
    subscribe(this: void, listener: () => void): () => void
  }
  readonly events: {
    subscribe<K extends keyof EventMap & string>(
      extension: string,
      event: K,
      handler: (payload: EventMap[K]) => void | Promise<void>,
    ): Disposable
  }
  readonly commands: {
    registerComponent(extension: string, paneId: string, spec: Omit<CommandSpec, "pane">): CommandHandle
  }
  readonly keys: {
    /** Claim raw keyboard input for a Pane; dispose to hand it back. Claims nest. */
    capture(paneId: string): Disposable
  }
  readonly listQuery: {
    register(
      paneId: string,
      id: string,
      input: (value: string) => void,
      initial: HostListQueryState,
    ): HostListQueryRegistration
  }
  readonly theme: {
    getSnapshot(this: void): Theme
    subscribe(this: void, listener: () => void): () => void
  }
}

/**
 * Which Extension — and which of its Panes, if any — is rendering the component that calls a
 * hook, so a registration can be attributed to its owner.
 *
 * `this: void` on the store members above documents an invariant TypeScript cannot enforce:
 * `useSyncExternalStore` calls them unbound, so a host must declare them as bound arrow
 * properties, and a prototype method would typecheck here and lose `this` at runtime.
 */
export interface PaneRuntime {
  readonly extension: string
  /** Absent for status line segments, which are components without a Pane to bind into. */
  readonly paneId?: string
}
