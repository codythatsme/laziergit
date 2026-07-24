import { useCallback, useSyncExternalStore } from "react"

import type { RowDecoration, RowDecorationHandle, RowSource, Theme, Tone } from "./types"

/**
 * Tone → theme token. A total mapping rather than a switch, so adding a {@link Tone} is a
 * compile error here instead of a badge that silently renders in the default colour.
 */
const toneTokens: { readonly [K in Tone]: keyof Theme } = {
  neutral: "text",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
  muted: "textMuted",
}

/**
 * The colour a {@link RowDecoration} badge is drawn in.
 *
 * Decorations are contributed by one Extension and drawn by the Extension that owns the
 * row, so the tone→colour mapping cannot live in either: the decorator never sees a theme,
 * and the list Pane never sees the tone vocabulary the decorator was written against.
 * Both sides reach it here instead of agreeing on raw colours. An absent tone is ordinary
 * text — a badge is extra data, not an alarm.
 */
export function toneColor(theme: Theme, tone: Tone | undefined): string {
  return theme[tone === undefined ? "text" : toneTokens[tone]]
}

/**
 * The merged shape, with every field present. Annotating {@link mergeDecorations} with it
 * is what keeps the merge total: a new {@link RowDecoration} field fails to compile until
 * the merge decides what happens to it.
 */
type MergedDecoration = {
  readonly [K in keyof Required<RowDecoration>]: Required<RowDecoration>[K] | undefined
}

/**
 * Later providers win, per field rather than wholesale, so a provider that only sets a
 * badge does not erase the tone an earlier one chose. `??` and not a spread because an
 * explicit `tone: undefined` means "I have no opinion", not "clear it".
 */
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

/** What a row's merged decoration was, and what it was computed from. */
interface CachedDecoration<Row> {
  readonly generation: number
  readonly row: Row
  readonly decoration: RowDecoration | undefined
}

/** Options for {@link createRowSource}. */
export interface RowSourceOptions<Row> {
  /**
   * Stable identity for a row, independent of the object carrying it.
   *
   * The git store hands out a fresh object for a row whenever its data changes and reuses
   * the old one when it does not, so object identity is a cache *hit* test but not a cache
   * *slot*: keyed by object, every refresh would strand the previous generation's entries
   * with nothing able to say they are dead. Keyed by the row's own name — a path, an oid, a
   * stash index — there is exactly one slot per logical row, reused as the store replaces
   * the objects beneath it.
   *
   * Make it unique across the rows this Pane shows — but "unique" is a claim about the ROW
   * TYPE, not the screen. `files` keys on all three fields of its `FileChange` row (kind,
   * previousPath, path), which is why a path modified in *both* the index and the working
   * tree — one identical `FileChange` value drawn on two lines — lands in one slot: a
   * decorating provider handed either object says the same thing, so sharing is correct. Two
   * *different* objects sharing a key would evict each other on every pass and the merged
   * decoration would never settle.
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
 * Builds the {@link RowSource} a list Extension exports.
 *
 * Every list Pane owes the same four things — hold the providers, merge them per row, track
 * the selection, re-render when a provider's async data lands — and ADR-0001 leaves the
 * Bundled Extensions no sibling package to share them through. So they live here, on the
 * same public API a third-party list Pane would use.
 */
export function createRowSource<Row>(options: RowSourceOptions<Row>): RowSourceHost<Row> {
  const providers = new Set<DecorationProvider<Row>>()
  const listeners = new Set<() => void>()
  const cache = new Map<string, CachedDecoration<Row>>()
  /** Providers that threw during the current generation — §5.9's "skipped for the pass". */
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
        // Both are "do something to my registration", so the answer for a dead one is
        // "nothing" — never a throw, however late an async tail calls them (§1.1).
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
