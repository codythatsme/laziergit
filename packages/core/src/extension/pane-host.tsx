import type { PluginContext, SlotRegistry } from "@opentui/core"
import type { ReactNode } from "react"
import { createElement } from "react"
import { PaneRuntimeProvider, RuntimeProvider, type InternalRuntime } from "laziergit/internal"
import type { PaneHandle, PaneProps, PaneSpec } from "laziergit"

import { assertScopedId } from "./id"

export type PaneSlots = Record<string, PaneProps>

export interface PaneEntry {
  readonly id: string
  readonly owner: string
  readonly title: string
  readonly state: "active" | "reloading"
  readonly placement?: PaneSpec["placement"]
}

interface MutablePaneEntry extends PaneEntry {
  registration?: symbol
}

export class PaneHost {
  readonly registry: SlotRegistry<ReactNode, PaneSlots, PluginContext>
  readonly #entries = new Map<string, MutablePaneEntry>()
  readonly #listeners = new Set<() => void>()
  readonly #reloadingOwners = new Set<string>()
  #runtime: InternalRuntime | undefined
  #snapshot: readonly PaneEntry[] = []
  #focused: string | null = null
  #onFocus: ((paneId: string, previous: string | null) => void) | undefined

  constructor(registry: SlotRegistry<ReactNode, PaneSlots, PluginContext>) {
    this.registry = registry
  }

  setRuntime(runtime: InternalRuntime): void {
    this.#runtime = runtime
  }

  setFocusListener(listener: (paneId: string, previous: string | null) => void): void {
    this.#onFocus = listener
  }

  getSnapshot = (): readonly PaneEntry[] => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get focused(): string | null {
    return this.#focused
  }

  register(owner: string, spec: PaneSpec): PaneHandle {
    assertScopedId(owner, spec.id)
    const runtime = this.#runtime
    if (!runtime) throw new Error("Pane runtime is not initialized")

    const existing = this.#entries.get(spec.id)
    if (existing?.state === "active") throw new Error(`Pane "${spec.id}" is already registered`)
    if (existing && existing.owner !== owner) throw new Error(`Pane "${spec.id}" belongs to "${existing.owner}"`)

    const registration = Symbol(spec.id)
    const unregisterPlugin = this.registry.register({
      id: `pane:${spec.id}`,
      slots: {
        [spec.id]: (_context, props) =>
          createElement(
            RuntimeProvider,
            { runtime },
            createElement(
              PaneRuntimeProvider,
              { value: { extension: owner, paneId: spec.id } },
              createElement(spec.component, props),
            ),
          ),
      },
    })

    this.#entries.set(spec.id, {
      id: spec.id,
      owner,
      title: spec.title,
      state: "active",
      placement: spec.placement,
      registration,
    })
    if (!this.#focused) this.#focused = spec.id
    this.#publish()

    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        unregisterPlugin()

        const current = this.#entries.get(spec.id)
        if (current?.registration !== registration) return
        if (this.#reloadingOwners.has(owner)) {
          this.#entries.set(spec.id, { ...current, state: "reloading", registration: undefined })
        } else {
          this.#entries.delete(spec.id)
          if (this.#focused === spec.id) this.#focused = this.#firstActivePane()
        }
        this.#publish()
      },
      focus: () => this.focus(spec.id),
    }
  }

  focus(id: string): void {
    const pane = this.#entries.get(id)
    if (!pane || pane.state !== "active") throw new Error(`Pane "${id}" has no live instance`)
    if (this.#focused === id) return
    const previous = this.#focused
    this.#focused = id
    this.#publish()
    this.#onFocus?.(id, previous)
  }

  prepareReload(owners: readonly string[]): void {
    for (const owner of owners) this.#reloadingOwners.add(owner)
    for (const [id, pane] of this.#entries) {
      if (this.#reloadingOwners.has(pane.owner)) this.#entries.set(id, { ...pane, state: "reloading" })
    }
    this.#publish()
  }

  finishReload(owners: readonly string[]): void {
    for (const owner of owners) this.#reloadingOwners.delete(owner)
    for (const [id, pane] of this.#entries) {
      if (pane.state === "reloading" && owners.includes(pane.owner)) this.#entries.delete(id)
    }
    if (!this.#focused || !this.#entries.has(this.#focused)) this.#focused = this.#firstActivePane()
    this.#publish()
  }

  #firstActivePane(): string | null {
    return [...this.#entries.values()].find((pane) => pane.state === "active")?.id ?? null
  }

  #publish(): void {
    this.#snapshot = [...this.#entries.values()]
      .map(({ registration: _registration, ...entry }) => entry)
      .sort((left, right) => {
        const column = (left.placement?.column ?? 0) - (right.placement?.column ?? 0)
        if (column !== 0) return column
        const order = (left.placement?.order ?? 100) - (right.placement?.order ?? 100)
        return order !== 0 ? order : left.id.localeCompare(right.id)
      })
    for (const listener of this.#listeners) listener()
  }
}
