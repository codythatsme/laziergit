import { PaneRuntimeProvider } from "@laziergit/runtime-bridge"
import { createElement } from "react"
import type { Disposable, StatusSegmentSpec } from "laziergit"

import type { StatuslineConfig } from "../config/config"
import { assertScopedId } from "../extension/id"
import { segmentSlotName, type SlotOwners, type UiSlotRegistry } from "./slots"

export interface StatusSegment {
  readonly id: string
  readonly owner: string
  readonly align: "left" | "right"
  readonly priority: number
}

export interface StatuslineSnapshot {
  readonly left: readonly StatusSegment[]
  readonly right: readonly StatusSegment[]
}

const emptySnapshot: StatuslineSnapshot = Object.freeze({ left: Object.freeze([]), right: Object.freeze([]) })

const defaultConfig: StatuslineConfig = Object.freeze({
  left: Object.freeze([]),
  right: Object.freeze([]),
  hidden: new Set<string>(),
})

/**
 * Status line segments. They ride the same slot registry as Panes — so a throwing
 * segment collapses to a placeholder instead of taking the line down — and the user's
 * config decides order: ids listed in `statusline.left`/`right` come first in the order
 * written, and everything else falls back to the segment's own align and priority.
 */
export class StatuslineHost {
  readonly #registry: UiSlotRegistry
  readonly #owners: SlotOwners
  readonly #segments = new Map<string, StatusSegment>()
  readonly #listeners = new Set<() => void>()
  #config: StatuslineConfig = defaultConfig
  #snapshot: StatuslineSnapshot = emptySnapshot

  constructor(registry: UiSlotRegistry, owners: SlotOwners) {
    this.#registry = registry
    this.#owners = owners
  }

  getSnapshot = (): StatuslineSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  setConfig(config: StatuslineConfig): void {
    this.#config = config
    this.#publish()
  }

  register(owner: string, spec: StatusSegmentSpec): Disposable {
    assertScopedId(owner, spec.id)
    if (this.#segments.has(spec.id)) throw new Error(`Status segment "${spec.id}" is already registered`)

    const slot = segmentSlotName(spec.id)
    this.#owners.claim(slot, owner)
    const unregister = this.#registry.register({
      id: slot,
      slots: {
        [slot]: () =>
          createElement(
            PaneRuntimeProvider,
            // No paneId: a segment is not a Pane, so `useCommand` must refuse it rather
            // than register a binding that could never fire.
            { value: { extension: owner } },
            createElement(spec.component),
          ),
      },
    })

    const segment: StatusSegment = {
      id: spec.id,
      owner,
      align: spec.align ?? "left",
      priority: spec.priority ?? 100,
    }
    this.#segments.set(spec.id, segment)
    this.#publish()

    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        unregister()
        this.#owners.release(slot, owner)
        if (this.#segments.get(spec.id) === segment) this.#segments.delete(spec.id)
        this.#publish()
      },
    }
  }

  #publish(): void {
    this.#snapshot = this.#resolve()
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // Snapshot observers cannot poison segment registration.
      }
    }
  }

  #resolve(): StatuslineSnapshot {
    const pinned = new Set([...this.#config.left, ...this.#config.right])
    const visible = [...this.#segments.values()].filter((segment) => !this.#config.hidden.has(segment.id))

    const listed = (ids: readonly string[]): StatusSegment[] =>
      ids.flatMap((id) => {
        const segment = visible.find((candidate) => candidate.id === id)
        return segment ? [segment] : []
      })

    const remaining = (align: "left" | "right"): StatusSegment[] =>
      visible
        .filter((segment) => !pinned.has(segment.id) && segment.align === align)
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))

    // The right side renders left to right, so "lower priority sits closer to its edge"
    // means the low-priority segments come last in the array.
    return {
      left: [...listed(this.#config.left), ...remaining("left")],
      right: [...listed(this.#config.right), ...remaining("right")].reverse(),
    }
  }
}
