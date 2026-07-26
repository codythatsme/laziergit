import type { CommandSpec, Disposable, EventMap, GitActivity, GitState, Theme } from "./types"

/**
 * The contract between laziergit's host and the React hooks in this package — what a Pane's
 * `useGit`, `useEvent`, `useCommand`, `useKeyCapture` and `useTheme` reach for, and therefore
 * what the host must put on the React context.
 *
 * **Not extension-facing.** It is reachable only as `laziergit/host`, deliberately absent from
 * the package's main entry, because an Extension author never implements it — `ctx` is their
 * surface. It lives in this package rather than in `@laziergit/runtime-bridge`, the package
 * both halves already share, for the reason the bridge cannot solve: every member below is
 * spelled in this package's own vocabulary ({@link GitState}, {@link EventMap},
 * {@link CommandSpec}, {@link Theme}), so a bridge-side declaration would have to import them
 * back out of here and make the dependency circular.
 *
 * It exists at all because it used to exist twice — declared once here and once in the
 * kernel, tied together by a comment asking the two to be kept in lockstep. They had already
 * drifted on the `theme` members' `this: void` by the time anyone compared them.
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
    registerComponent(extension: string, paneId: string, spec: Omit<CommandSpec, "pane">): Disposable
  }
  readonly keys: {
    /** Claim raw keyboard input for a Pane; dispose to hand it back. Claims nest. */
    capture(paneId: string): Disposable
  }
  readonly theme: {
    getSnapshot(this: void): Theme
    subscribe(this: void, listener: () => void): () => void
  }
}

/**
 * Which Extension — and which of its Panes, if any — is rendering the component that calls a
 * hook. The host puts this on the second React context; the hooks read it to attribute a
 * registration to its owner.
 *
 * `this: void` on the store members above is load-bearing and not enforceable: `useSyncExternalStore`
 * calls `getSnapshot` and `subscribe` unbound, so a host that declares them as prototype
 * methods would typecheck here and lose `this` at runtime. TypeScript does not check the
 * marker against a shorthand method, so what actually carries the invariant is the convention
 * that every host declares them as bound arrow properties — the marker documents it, and this
 * sentence is the reason it cannot be relied upon alone.
 */
export interface PaneRuntime {
  readonly extension: string
  /** Absent for status line segments, which are components without a Pane to bind into. */
  readonly paneId?: string
}
