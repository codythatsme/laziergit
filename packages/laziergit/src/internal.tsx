import { createContext, createElement, type ReactNode } from "react"

import type { CommandSpec, Disposable, EventMap, GitState, Theme } from "./types"

export interface InternalRuntime {
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
  readonly theme: Theme
}

export interface PaneRuntime {
  readonly extension: string
  readonly paneId: string
}

export const RuntimeContext = createContext<InternalRuntime | null>(null)
export const PaneRuntimeContext = createContext<PaneRuntime | null>(null)

export function RuntimeProvider(props: { runtime: InternalRuntime; children?: ReactNode }) {
  return createElement(RuntimeContext.Provider, { value: props.runtime }, props.children)
}

export function PaneRuntimeProvider(props: { value: PaneRuntime; children?: ReactNode }) {
  return createElement(PaneRuntimeContext.Provider, { value: props.value }, props.children)
}
