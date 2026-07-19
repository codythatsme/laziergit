import { useContext, useEffect, useRef, useSyncExternalStore } from "react"

import { PaneRuntimeContext, RuntimeContext } from "./internal"
import type { Cell, CommandSpec, EventMap, GitState, Theme } from "./types"

function useRuntime() {
  const runtime = useContext(RuntimeContext)
  if (!runtime) {
    throw new Error("laziergit hooks must be called from a component rendered by laziergit")
  }
  return runtime
}

export function useGit<T>(selector: (state: GitState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const runtime = useRuntime()
  const selected = useRef(selector(runtime.git.getSnapshot()))

  return useSyncExternalStore(
    (listener) => runtime.git.subscribe(listener),
    () => {
      const next = selector(runtime.git.getSnapshot())
      if (!isEqual(selected.current, next)) selected.current = next
      return selected.current
    },
    () => selected.current,
  )
}

export function useEvent<K extends keyof EventMap & string>(
  event: K,
  handler: (payload: EventMap[K]) => void | Promise<void>,
): void {
  const runtime = useRuntime()
  const pane = useContext(PaneRuntimeContext)
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
  const pane = useContext(PaneRuntimeContext)
  const latest = useRef(spec)
  latest.current = spec

  if (!pane) {
    throw new Error("useCommand must be called inside a laziergit Pane")
  }

  useEffect(() => {
    const registered = runtime.commands.registerComponent(pane.extension, pane.paneId, {
      ...latest.current,
      run: () => latest.current.run(),
    })
    return () => registered.dispose()
  }, [pane.extension, pane.paneId, runtime, spec.id])
}

export function createCell<T>(initial: T): Cell<T> {
  let current = initial
  const listeners = new Set<() => void>()

  return {
    get: () => current,
    set(value) {
      if (Object.is(current, value)) return
      current = value
      for (const listener of listeners) listener()
    },
    use() {
      return useSyncExternalStore(
        (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        () => current,
        () => current,
      )
    },
  }
}

export function useTheme(): Theme {
  return useRuntime().theme
}
