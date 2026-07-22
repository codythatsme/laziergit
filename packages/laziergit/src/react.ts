import { PaneRuntimeContext, RuntimeContext } from "@laziergit/runtime-bridge"
import { useContext, useEffect, useRef, useSyncExternalStore } from "react"

import type { Cell, CommandSpec, Disposable, EventMap, GitState, Theme } from "./types"

interface InternalRuntime {
  readonly git: {
    getSnapshot(): GitState
    subscribe(listener: () => void): () => void
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
    getSnapshot(): Theme
    subscribe(listener: () => void): () => void
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
  const runtime = useRuntime()
  return useSyncExternalStore(
    (listener) => runtime.theme.subscribe(listener),
    () => runtime.theme.getSnapshot(),
    () => runtime.theme.getSnapshot(),
  )
}
