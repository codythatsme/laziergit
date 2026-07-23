import { PaneRuntimeContext, RuntimeContext } from "@laziergit/runtime-bridge"
import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react"

import type { Cell, CommandSpec, Disposable, EventMap, GitState, Theme } from "./types"

/**
 * The host contract these hooks consume. `this: void` throughout because
 * {@link useSyncExternalStore} calls them unbound — which is why every host declares them
 * as bound arrow properties.
 */
interface InternalRuntime {
  readonly git: {
    getSnapshot(this: void): GitState
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
  readonly theme: {
    getSnapshot(this: void): Theme
    subscribe(this: void, listener: () => void): () => void
  }
}

interface PaneRuntime {
  readonly extension: string
  /** Absent for status line segments, which are components without a Pane to bind into. */
  readonly paneId?: string
}

function useRuntime() {
  const runtime = useContext(RuntimeContext) as InternalRuntime | null
  if (!runtime) {
    throw new Error("laziergit hooks must be called from a component rendered by laziergit")
  }
  return runtime
}

/**
 * Selector-aware `useSyncExternalStore`.
 *
 * Two layers of memoization, and both are load-bearing. Within one selector identity the
 * selection is computed once per store snapshot — React calls `getSnapshot` several times
 * per render, and the store guarantees a stable snapshot object between publishes, so the
 * selector runs once. Across renders, `committed` carries the value React last rendered,
 * which is what `isEqual` compares against: that is what keeps a derived object (`(s) =>
 * s.status.staged.map(...)`) from re-rendering forever, even though an inline selector has
 * a fresh identity on every render and resets the inner memo.
 *
 * Keying the memo on `selector` is what makes a selector that closes over props correct —
 * a changed selector must not keep returning the previous one's value.
 */
export function useGit<T>(selector: (state: GitState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const runtime = useRuntime()
  const committed = useRef<{ value: T } | null>(null)

  const getSelection = useMemo(() => {
    let memoized: { state: GitState; value: T } | null = null

    return (): T => {
      const state = runtime.git.getSnapshot()
      if (memoized && Object.is(memoized.state, state)) return memoized.value

      const next = selector(state)
      const previous = committed.current
      // Reuse the rendered value when the selection is equivalent, so the identity React
      // compares against stays put.
      const value = previous !== null && isEqual(previous.value, next) ? previous.value : next
      memoized = { state, value }
      return value
    }
  }, [runtime, selector, isEqual])

  const value = useSyncExternalStore(runtime.git.subscribe, getSelection, getSelection)
  useEffect(() => {
    committed.current = { value }
  }, [value])
  return value
}

export function useEvent<K extends keyof EventMap & string>(
  event: K,
  handler: (payload: EventMap[K]) => void | Promise<void>,
): void {
  const runtime = useRuntime()
  const pane = useContext(PaneRuntimeContext) as PaneRuntime | null
  const latest = useRef(handler)
  latest.current = handler

  useEffect(() => {
    const subscription = runtime.events.subscribe(pane?.extension ?? "component", event, (payload) =>
      latest.current(payload),
    )
    return () => subscription.dispose()
  }, [event, pane?.extension, runtime])
}

export function useCommand(spec: Omit<CommandSpec, "pane">): void {
  const runtime = useRuntime()
  const pane = useContext(PaneRuntimeContext) as PaneRuntime | null
  const latest = useRef(spec)
  latest.current = spec

  const paneId = pane?.paneId
  if (!pane || paneId === undefined) {
    throw new Error("useCommand must be called inside a laziergit Pane")
  }

  useEffect(() => {
    const registered = runtime.commands.registerComponent(pane.extension, paneId, {
      ...latest.current,
      run: () => latest.current.run(),
    })
    return () => registered.dispose()
  }, [pane.extension, paneId, runtime, spec.id])
}

export function createCell<T>(initial: T): Cell<T> {
  let current = initial
  const listeners = new Set<() => void>()

  // Hoisted out of `use()` so their identities are stable across renders: a fresh
  // `subscribe` closure per render makes React tear the subscription down and rebuild it
  // on every render, which is exactly the churn `useTheme` passes bound methods to avoid.
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const getSnapshot = (): T => current

  return {
    get: getSnapshot,
    set(value) {
      if (Object.is(current, value)) return
      current = value
      // Snapshotted, so a component unmounting in response cannot break the iteration.
      for (const listener of [...listeners]) listener()
    },
    use() {
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    },
  }
}

export function useTheme(): Theme {
  const runtime = useRuntime()
  // Passed through rather than wrapped: a fresh closure per render would make React tear
  // down and re-establish the subscription on every render.
  return useSyncExternalStore(runtime.theme.subscribe, runtime.theme.getSnapshot, runtime.theme.getSnapshot)
}
