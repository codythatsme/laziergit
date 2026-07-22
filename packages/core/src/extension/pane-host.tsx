import { PaneRuntimeProvider } from "@laziergit/runtime-bridge"
import { createElement } from "react"
import type { Disposable, PaneSpec } from "laziergit"

import { paneSlotName, type SlotOwners, type UiSlotRegistry } from "../ui/slots"
import { assertScopedId } from "./id"

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

/**
 * The Pane registry: which Panes exist, who owns them, and whether they are live.
 * Where they appear and which one has focus is the Layout's business, not this one's.
 */
export class PaneHost {
  readonly registry: UiSlotRegistry
  readonly #owners: SlotOwners
  readonly #entries = new Map<string, MutablePaneEntry>()
  readonly #listeners = new Set<() => void>()
  readonly #reloadingOwners = new Set<string>()
  #snapshot: readonly PaneEntry[] = []

  constructor(registry: UiSlotRegistry, owners: SlotOwners) {
    this.registry = registry
    this.#owners = owners
  }

  getSnapshot = (): readonly PaneEntry[] => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  isLive(id: string): boolean {
    return this.#entries.get(id)?.state === "active"
  }

  register(owner: string, spec: PaneSpec): Disposable {
    assertScopedId(owner, spec.id)

    const existing = this.#entries.get(spec.id)
    if (existing?.state === "active") throw new Error(`Pane "${spec.id}" is already registered`)
    if (existing && existing.owner !== owner) throw new Error(`Pane "${spec.id}" belongs to "${existing.owner}"`)

    const registration = Symbol(spec.id)
    const pluginId = `pane:${spec.id}`
    const previousOwner = this.#owners.ownerOf(pluginId)
    this.#owners.claim(pluginId, owner)
    let unregisterPlugin: () => void
    try {
      unregisterPlugin = this.registry.register({
        id: pluginId,
        slots: {
          [paneSlotName(spec.id)]: (_context, props) =>
            createElement(
              PaneRuntimeProvider,
              { value: { extension: owner, paneId: spec.id } },
              createElement(spec.component, props),
            ),
        },
      })
    } catch (error) {
      if (previousOwner) this.#owners.claim(pluginId, previousOwner)
      else this.#owners.release(pluginId, owner)
      throw error
    }

    this.#entries.set(spec.id, {
      id: spec.id,
      owner,
      title: spec.title,
      state: "active",
      placement: spec.placement,
      registration,
    })
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
        }
        this.#publish()
      },
    }
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
    this.#publish()
  }

  #publish(): void {
    this.#snapshot = [...this.#entries.values()].map(({ registration: _registration, ...entry }) => entry)
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // Snapshot observers cannot poison registration or reload.
      }
    }
  }
}
