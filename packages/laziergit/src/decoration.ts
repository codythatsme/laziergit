import { useCallback, useSyncExternalStore } from "react"

import type { RowDecoration, RowDecorationHandle, RowSource, Theme, Tone } from "./types"

const toneTokens: { readonly [K in Tone]: keyof Theme } = {
  neutral: "text",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
  muted: "textMuted",
}

/** The colour a {@link RowDecoration} badge is drawn in; an absent tone is ordinary text. */
export function toneColor(theme: Theme, tone: Tone | undefined): string {
  return theme[tone === undefined ? "text" : toneTokens[tone]]
}

/** Every {@link RowDecoration} field present, so a new field fails to compile until the merge handles it. */
type MergedDecoration = {
  readonly [K in keyof Required<RowDecoration>]: Required<RowDecoration>[K] | undefined
}

/** Later providers win per field; an explicit `undefined` leaves the earlier value in place. */
function mergeDecorations(base: RowDecoration | undefined, next: RowDecoration): MergedDecoration {
  return {
    badge: next.badge ?? base?.badge,
    tone: next.tone ?? base?.tone,
    dim: next.dim ?? base?.dim,
  }
}

/** One registration, wrapped so that registering the same function twice stays two providers. */
interface DecorationProvider<Row> {
  readonly decorate: (row: Row) => RowDecoration | undefined
}

interface CachedDecoration<Row> {
  readonly generation: number
  readonly row: Row
  readonly decoration: RowDecoration | undefined
}

/** Options for {@link createRowSource}. */
export interface RowSourceOptions<Row> {
  /**
   * Stable identity for a row, independent of the object carrying it — a path, an oid, a stash
   * index. Must be unique across the row type: two rows sharing a key evict each other on
   * every pass, and the merged decoration never settles.
   */
  key(row: Row): string
}

/**
 * The Extension-side half of a {@link RowSource}: the decoration providers other Extensions
 * have registered, merged per row, plus the selected row they can read.
 */
export interface RowSourceHost<Row> {
  /** Return this from `activate` — it is the {@link RowSource} other Extensions consume. */
  readonly api: RowSource<Row>
  /** Called by the Pane whenever the cursor moves. */
  setSelected(row: Row | undefined): void
  /** Hook: the merged decoration for a row, live across provider churn and `refresh()`. */
  useDecoration(row: Row): RowDecoration | undefined
}

/**
 * Builds the {@link RowSource} a list Extension exports: holds the decoration providers,
 * merges them per row, tracks the selection, and re-renders when a provider's data lands.
 */
export function createRowSource<Row>(options: RowSourceOptions<Row>): RowSourceHost<Row> {
  const providers = new Set<DecorationProvider<Row>>()
  const listeners = new Set<() => void>()
  const cache = new Map<string, CachedDecoration<Row>>()
  /** Providers that threw during the current generation, skipped until the next bump. */
  const failed = new Set<DecorationProvider<Row>>()
  let generation = 0
  let selected: Row | undefined

  /** Every cached decoration was merged from the old provider set, so nothing survives a bump. */
  const bump = (): void => {
    generation += 1
    cache.clear()
    failed.clear()
    // Snapshotted, so a component unmounting in response cannot break the iteration.
    for (const listener of Array.from(listeners)) listener()
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const decorationFor = (row: Row): RowDecoration | undefined => {
    const slot = options.key(row)
    const cached = cache.get(slot)
    // Also what makes this safe as a `useSyncExternalStore` snapshot: repeated reads of an
    // unchanged row must return the identical object or React re-renders forever.
    if (cached !== undefined && cached.generation === generation && Object.is(cached.row, row)) {
      return cached.decoration
    }

    let decoration: RowDecoration | undefined
    for (const provider of providers) {
      if (failed.has(provider)) continue
      let contributed: RowDecoration | undefined
      try {
        contributed = provider.decorate(row)
      } catch (error) {
        // Dropped for the rest of the generation rather than retried per row: one throwing
        // provider must not decorate half the list. The next refresh() gives it another go.
        failed.add(provider)
        console.warn("Row decoration provider failed and is skipped for this pass", error)
        continue
      }
      if (contributed !== undefined) decoration = mergeDecorations(decoration, contributed)
    }

    cache.set(slot, { generation, row, decoration })
    return decoration
  }

  const api: RowSource<Row> = {
    decorateRows(provider) {
      const registered: DecorationProvider<Row> = { decorate: provider }
      providers.add(registered)
      bump()

      let disposed = false
      const handle: RowDecorationHandle = {
        // Both are no-ops once disposed, never a throw, however late an async tail calls them.
        refresh: () => {
          if (disposed) return
          bump()
        },
        dispose: () => {
          if (disposed) return
          disposed = true
          providers.delete(registered)
          bump()
        },
      }
      return handle
    },
    selected: () => selected,
  }

  return {
    api,
    setSelected(row) {
      selected = row
    },
    useDecoration(row) {
      // Keyed on the row so a Pane rendering many rows gets one snapshot reader per row.
      const getSnapshot = useCallback(() => decorationFor(row), [row])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    },
  }
}
