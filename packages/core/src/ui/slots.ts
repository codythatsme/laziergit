import type { PluginContext, SlotRegistry } from "@opentui/core"
import type { ReactNode } from "react"
import type { PaneProps } from "laziergit"

import { normalizeError, type Diagnostics } from "../extension/diagnostics"

/**
 * Every Extension-rendered region — Panes and status line segments — shares one slot
 * registry: `createReactSlotRegistry` is memoised per renderer, so a second registry is
 * not available, and one registry with disjoint slot names is the honest way to get the
 * registry's per-plugin error boundary for both surfaces. Pane slots are named by the
 * Pane id; segments carry a prefix no {@link ScopedId} can produce.
 */
export type UiSlots = Record<string, PaneProps>

export type UiSlotRegistry = SlotRegistry<ReactNode, UiSlots, PluginContext>

const segmentPrefix = "statusline:"

export function paneSlotName(paneId: string): string {
  return paneId
}

export function segmentSlotName(segmentId: string): string {
  return `${segmentPrefix}${segmentId}`
}

/**
 * Maps a registered plugin back to the Extension that owns it, so a render failure the
 * registry catches is reported against a name rather than swallowed. Shared by every
 * surface that registers into the registry — a plugin nobody claims has no owner to
 * blame, and reporting it against the wrong one would be worse than silence.
 */
export class SlotOwners {
  readonly #owners = new Map<string, string>()

  claim(pluginId: string, owner: string): void {
    this.#owners.set(pluginId, owner)
  }

  release(pluginId: string, owner: string): void {
    if (this.#owners.get(pluginId) === owner) this.#owners.delete(pluginId)
  }

  ownerOf(pluginId: string): string | undefined {
    return this.#owners.get(pluginId)
  }

  /** Routes the registry's render failures to diagnostics. Returns the unsubscribe. */
  watch(registry: UiSlotRegistry, diagnostics: Diagnostics): () => void {
    return registry.onPluginError((failure) => {
      const owner = this.#owners.get(failure.pluginId)
      if (!owner) return
      try {
        diagnostics.report({
          extension: owner,
          phase: "render",
          message: failure.error.message,
          error: normalizeError(failure.error),
        })
      } catch {
        // Registry error reporting cannot feed a failure back into the registry.
      }
    })
  }

  clear(): void {
    this.#owners.clear()
  }
}
