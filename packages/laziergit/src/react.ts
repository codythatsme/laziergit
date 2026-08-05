import { PaneRuntimeContext, RuntimeContext } from "@laziergit/runtime-bridge"
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import type { HostListQueryRegistration, HostListQueryState, HostRuntime, PaneRuntime } from "./host"
import { filterMatchIndices, searchMatchIndices } from "./list-query"
import type { Cell, CommandHandle, CommandSpec, EventMap, GitActivity, GitState, Theme } from "./types"

// The bridge's contexts carry `unknown`, so this file is where they become typed — parsed
// rather than asserted. The guards check only what these hooks reach for.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function hasMethods(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && names.every((name) => typeof Reflect.get(value, name) === "function")
}

function isHostRuntime(value: unknown): value is HostRuntime {
  if (!isRecord(value)) return false
  return (
    hasMethods(value.git, ["getSnapshot", "subscribe"]) &&
    hasMethods(value.activity, ["getSnapshot", "subscribe"]) &&
    hasMethods(value.events, ["subscribe"]) &&
    hasMethods(value.commands, ["registerComponent"]) &&
    hasMethods(value.keys, ["capture"]) &&
    hasMethods(value.listQuery, ["register"]) &&
    hasMethods(value.theme, ["getSnapshot", "subscribe"])
  )
}

function isPaneRuntime(value: unknown): value is PaneRuntime {
  if (!isRecord(value)) return false
  const paneId = value.paneId
  return typeof value.extension === "string" && (paneId === undefined || typeof paneId === "string")
}

function useRuntime() {
  const runtime = useContext(RuntimeContext)
  if (!isHostRuntime(runtime)) {
    throw new Error("laziergit hooks must be called from a component rendered by laziergit")
  }
  return runtime
}

function usePaneRuntime(): PaneRuntime | null {
  const pane = useContext(PaneRuntimeContext)
  return isPaneRuntime(pane) ? pane : null
}

/** The Pane a hook is registering into. Throws where there is none, before any other hook runs. */
function useEnclosingPane(hook: string): { readonly extension: string; readonly paneId: string } {
  const pane = usePaneRuntime()
  const paneId = pane?.paneId
  if (!pane || paneId === undefined) {
    throw new Error(`${hook} must be called inside a laziergit Pane`)
  }
  return { extension: pane.extension, paneId }
}

/**
 * Selector-aware `useSyncExternalStore`.
 *
 * Two layers of memoization. The inner one runs the selector once per store snapshot, since
 * React calls `getSnapshot` several times a render. The outer one — `committed`, the value
 * React last rendered — is what `isEqual` compares against, which is what stops a selector
 * deriving a fresh object from re-rendering forever.
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

/**
 * The git writes in flight right now, oldest first, wherever they were invoked from. Reads,
 * the background poll, and anything settling inside ~120ms never appear — so this is safe to
 * render directly, with no debounce of your own.
 *
 * ```tsx
 * const [busy] = useGitActivity().slice(-1);
 * return busy ? <text>{`${spinner} ${busy.label}`}</text> : null;
 * ```
 */
export function useGitActivity(): readonly GitActivity[] {
  const runtime = useRuntime()
  return useSyncExternalStore(runtime.activity.subscribe, runtime.activity.getSnapshot, runtime.activity.getSnapshot)
}

export function useEvent<K extends keyof EventMap & string>(
  event: K,
  handler: (payload: EventMap[K]) => void | Promise<void>,
): void {
  const runtime = useRuntime()
  const pane = usePaneRuntime()
  const latest = useRef(handler)
  latest.current = handler

  useEffect(() => {
    const subscription = runtime.events.subscribe(pane?.extension ?? "component", event, (payload) =>
      latest.current(payload),
    )
    return () => subscription.dispose()
  }, [event, pane?.extension, runtime])
}

/**
 * Registers a Pane-scoped Command for as long as the component is mounted.
 *
 * `run` and `when` are live, read through a ref so they never act on stale state. The rest of the spec
 * is read once at registration: re-registering would reorder {@link CommandSpec.keys} conflict
 * resolution, which is insertion-ordered, letting a recomputed title take a key from another
 * Pane mid-session. A Command whose identity changes should change its `id`.
 */
function useOptionalCommand(spec: Omit<CommandSpec, "pane"> | null): void {
  const runtime = useRuntime()
  const pane = useEnclosingPane("useCommand")
  const latest = useRef(spec)
  const registration = useRef<CommandHandle | null>(null)
  latest.current = spec

  useEffect(() => {
    if (latest.current === null) return
    const registered = runtime.commands.registerComponent(pane.extension, pane.paneId, {
      ...latest.current,
      when: () => latest.current !== null && (latest.current.when?.() ?? true),
      run: () => latest.current?.run(),
    })
    registration.current = registered
    return () => {
      if (registration.current === registered) registration.current = null
      registered.dispose()
    }
  }, [pane.extension, pane.paneId, runtime, spec?.id])

  // Re-evaluate a live `when` after every committed render without reordering the Command.
  useEffect(() => registration.current?.refresh())
}

export function useCommand(spec: Omit<CommandSpec, "pane">): void {
  useOptionalCommand(spec)
}

/**
 * Claim raw keyboard input for the enclosing Pane while `active` — for a Pane rendering its
 * own `<textarea>`, where every ordinary keybinding is a typo waiting to happen.
 *
 * While a Pane captures, only its own `capture: true` Commands stay live; every other layer
 * goes inert. A popup still outranks a capture. Claims nest: disposing one restores the
 * previous.
 */
export function useKeyCapture(active: boolean): void {
  const runtime = useRuntime()
  const pane = useEnclosingPane("useKeyCapture")

  useEffect(() => {
    if (!active) return
    const claim = runtime.keys.capture(pane.paneId)
    return () => claim.dispose()
  }, [active, pane.paneId, runtime])
}

/**
 * The slice of OpenTUI's `<scrollbox>` the scrolling seam drives. Declared structurally
 * because an Extension may not import `@opentui/core`.
 */
export interface ScrollSurface {
  scrollTop: number
  /** Total height of the content, in rows. */
  readonly scrollHeight: number
  readonly viewport: { readonly height: number }
  /**
   * Scroll the descendant carrying `childId` just far enough to be visible — OpenTUI's own
   * `scrollIntoView({ block: "nearest" })`, measured where the element was actually laid out.
   * This is what lets {@link ListCursor} follow a cursor without computing a row number.
   */
  scrollChildIntoView(childId: string): void
}

/** Imperative control of a Pane's `<scrollbox>` — see {@link useScrollView}. */
export interface ScrollView {
  /**
   * Callback ref for the `<scrollbox>` this view drives. Give the box
   * `flexGrow={1} flexBasis={0}`: without the basis the box is sized by its content and
   * overflows the Pane instead of scrolling inside it.
   */
  readonly ref: (surface: ScrollSurface | null) => void
  /** Rows the viewport shows, or 0 before the first layout. */
  viewportRows(): number
  /** Scroll by whole rows; negative is up. Clamped to the content. */
  scrollBy(rows: number): void
  /** Scroll to an absolute row, or to either end. Clamped to the content. */
  scrollTo(row: number | "start" | "end"): void
}

/**
 * Imperative scrolling for a Pane that shows more than fits and has no cursor to follow.
 * OpenTUI's `<scrollbox>` handles its own keys, but laziergit never gives it renderer focus,
 * so this seam reaches it instead.
 *
 * ```tsx
 * const scroll = useScrollView();
 * useCommand({ id: "x.down", title: "Scroll down", keys: "j", run: () => scroll.scrollBy(1) });
 * useCommand({ id: "x.page", title: "Page down", keys: "ctrl+d", run: () => scroll.scrollBy(scroll.viewportRows() / 2) });
 * <scrollbox ref={scroll.ref} flexGrow={1} flexBasis={0}>…</scrollbox>
 * ```
 */
export function useScrollView(): ScrollView {
  const surface = useRef<ScrollSurface | null>(null)

  // Stable identity, so the callback ref does not detach and reattach on every render.
  return useMemo<ScrollView>(
    () => ({
      ref: (node) => {
        surface.current = node
      },
      viewportRows: () => surface.current?.viewport.height ?? 0,
      scrollBy: (rows) => {
        const node = surface.current
        if (node) node.scrollTop = node.scrollTop + Math.trunc(rows)
      },
      scrollTo: (row) => {
        const node = surface.current
        if (!node) return
        // `scrollHeight` for "end", not `scrollHeight - viewportRows`: the setter clamps.
        node.scrollTop = row === "start" ? 0 : row === "end" ? node.scrollHeight : Math.trunc(row)
      },
    }),
    [],
  )
}

/** Options for {@link useListCursor}. */
export interface ListCursorOptions<T> {
  /** The rows the cursor walks, newest snapshot each render. */
  items: readonly T[]
  /**
   * Your Extension's name: the Commands register as `${idPrefix}.cursor.*` and the rows as
   * `${idPrefix}.row.*`, so an Extension with two list Panes gives them different prefixes.
   */
  idPrefix: string
  /** Singular noun for the cheat-sheet titles, e.g. `"file"` → "Next file". */
  noun: string
  /**
   * Neighboring rows to keep visible in the direction of travel. Defaults to `2`, matching
   * lazygit's scroll-off margin; pass `0` when a list deliberately wants nearest-only scrolling.
   */
  scrollOffMargin?: number
  /**
   * Optional `/` query behavior. A filter projects the list live; a search retains every row
   * and moves among matches with `n` / `N`.
   */
  query?: ListQueryOptions<T>
}

export interface ListQueryOptions<T> {
  readonly mode: "filter" | "search"
  /** Complete searchable values, including text a clipped row does not draw. */
  readonly fields: (item: T) => string | readonly string[]
}

export interface ListQuery {
  readonly mode: "filter" | "search"
  readonly value: string
  readonly editing: boolean
  readonly matchCount: number
  /** Zero-based search match position; null for filters and searches with no matches. */
  readonly currentMatch: number | null
  clear(): void
}

/** A cursor over a list, and the row it points at. */
export interface ListCursor<T> {
  /** The rows to render: projected matches for a filter, the source rows for a search. */
  readonly items: readonly T[]
  /** Always in range: 0 while the list is empty, never past its end. */
  readonly index: number
  readonly selected: T | undefined
  readonly query: ListQuery | undefined
  /** Move the cursor (clicking a row, or jumping to a row your Extension just created). */
  setIndex(index: number): void
  /**
   * Callback ref for the Pane's `<scrollbox>`: attach it, put {@link rowId} on each row, and
   * the selected row is scrolled into view whenever the cursor leaves the viewport. Give the
   * box `flexGrow={1} flexBasis={0}` — see {@link ScrollView.ref}.
   *
   * ```tsx
   * <scrollbox ref={cursor.scrollRef} flexGrow={1} flexBasis={0}>{rows}</scrollbox>
   * ```
   */
  readonly scrollRef: (surface: ScrollSurface | null) => void
  /**
   * The `id` to put on the element drawn for `items[index]`, so the cursor can find that row
   * and scroll it into view. An id rather than a row number, because a Pane may draw headers
   * or multi-line rows between them.
   *
   * ```tsx
   * {items.map((item, index) => (
   *   <box key={item.id} id={cursor.rowId(index)} onMouseDown={() => cursor.setIndex(index)}>…</box>
   * ))}
   * ```
   */
  rowId(index: number): string
}

/**
 * Cursor state for a list Pane, with `j` / `k` / `g` / `G` registered as hidden Pane-scoped
 * Commands. Attach {@link ListCursor.scrollRef} to the Pane's `<scrollbox>`, or the cursor
 * walks off the bottom of it.
 *
 * Half-page motions are left out: a Pane that wants them measures with
 * {@link ScrollView.viewportRows} and moves with {@link ListCursor.setIndex}.
 */
interface QueryState {
  readonly applied: string
  readonly draft: string
  readonly editing: boolean
  readonly searchPosition: number
}

const emptyQueryState: QueryState = { applied: "", draft: "", editing: false, searchPosition: 0 }

function firstMatchAfter(matches: readonly number[], index: number): number {
  const after = matches.findIndex((candidate) => candidate > index)
  return after === -1 ? 0 : after
}

function nearestMatch(matches: readonly number[], index: number): number {
  let nearest = 0
  for (const [position, match] of matches.entries()) {
    if (match === index) return position
    if (match > index) break
    nearest = position
  }
  return nearest
}

export function useListCursor<T>({
  items,
  idPrefix,
  noun,
  scrollOffMargin = 2,
  query: queryOptions,
}: ListCursorOptions<T>): ListCursor<T> {
  const runtime = useRuntime()
  const pane = useEnclosingPane("useListCursor")
  const [requested, setRequested] = useState(0)
  const [queryState, setQueryState] = useState<QueryState>(emptyQueryState)
  const surface = useRef<ScrollSurface | null>(null)
  const mode = queryOptions?.mode
  const fields = queryOptions?.fields
  const filterIndices = useMemo(
    () =>
      mode === "filter" && fields && queryState.applied.length > 0
        ? filterMatchIndices(items, queryState.applied, fields)
        : undefined,
    [fields, items, mode, queryState.applied],
  )
  const searchIndices = useMemo(
    () =>
      mode === "search" && fields && queryState.applied.length > 0
        ? searchMatchIndices(items, queryState.applied, fields)
        : [],
    [fields, items, mode, queryState.applied],
  )
  const visibleItems = useMemo(
    () => (filterIndices === undefined ? items : filterIndices.flatMap((source) => items[source] ?? [])),
    [filterIndices, items],
  )
  const last = visibleItems.length - 1
  // Clamped on read, so the render where the list shrank already draws a valid cursor.
  const index = last < 0 ? 0 : Math.min(Math.max(requested, 0), last)
  const revealedIndex = useRef(index)
  const searchPosition =
    searchIndices.length === 0 ? 0 : Math.min(Math.max(queryState.searchPosition, 0), searchIndices.length - 1)
  const currentSearchMatch = searchIndices[searchPosition]

  const request = useCallback((next: number) => {
    setRequested(next)
  }, [])

  // ...and written back, or the clamp would resurrect the old position once the list grew
  // again. Revealing rides along here because this effect runs on exactly the renders that can
  // move the cursor out of the viewport: a keypress, and a clamp. A scroll-off margin reveals
  // the neighboring row first, then the selection; the second call is normally a no-op, but
  // guarantees a very tall custom row cannot push the actual cursor out of view.
  useEffect(() => {
    if (requested !== index) request(index)
    const node = surface.current
    const before = revealedIndex.current
    revealedIndex.current = index
    if (!node) return

    const configuredMargin = Number.isFinite(scrollOffMargin) ? Math.max(0, Math.trunc(scrollOffMargin)) : 0
    const viewportRows = Math.max(0, Math.trunc(node.viewport.height))
    const movingDown = index > before
    const movingUp = index < before
    // Lazygit caps its margin at half the viewport. Besides keeping the cursor visible, that
    // makes an intentionally huge configured value behave like a centred cursor.
    const marginCap = movingDown ? Math.floor((viewportRows - 1) / 2) : Math.floor(viewportRows / 2)
    const margin = Math.min(configuredMargin, Math.max(0, marginCap))
    const revealIndex = movingDown ? Math.min(index + margin, last) : movingUp ? Math.max(index - margin, 0) : index
    if (revealIndex !== index) node.scrollChildIntoView(`${idPrefix}.row.${revealIndex}`)
    node.scrollChildIntoView(`${idPrefix}.row.${index}`)
  }, [requested, index, idPrefix, last, request, scrollOffMargin])

  const latest = useRef({
    items,
    visibleItems,
    filterIndices,
    searchIndices,
    currentSearchMatch,
    index,
    queryState,
    mode,
    fields,
  })
  latest.current = {
    items,
    visibleItems,
    filterIndices,
    searchIndices,
    currentSearchMatch,
    index,
    queryState,
    mode,
    fields,
  }

  const updateQueryState = useCallback((next: QueryState) => {
    latest.current = { ...latest.current, queryState: next }
    setQueryState(next)
  }, [])

  // Lazygit advances the active search position as ordinary cursor movement crosses matches.
  // This makes `n` / `N` continue from the cursor's neighbourhood rather than from the commit
  // the original search happened to land on.
  useEffect(() => {
    if (mode !== "search" || searchIndices.length === 0) return
    const nearest = nearestMatch(searchIndices, index)
    if (nearest === searchPosition) return
    updateQueryState({ ...queryState, searchPosition: nearest })
  }, [index, mode, queryState, searchIndices, searchPosition, updateQueryState])

  const clearQuery = useCallback(() => {
    const current = latest.current
    const sourceIndex = current.filterIndices?.[current.index] ?? current.index
    request(sourceIndex)
    updateQueryState(emptyQueryState)
  }, [request, updateQueryState])

  const inputQuery = useCallback(
    (value: string) => {
      const current = latest.current
      if (current.mode === "filter") {
        request(0)
        updateQueryState({ applied: value, draft: value, editing: true, searchPosition: 0 })
        return
      }
      updateQueryState({ ...current.queryState, draft: value, editing: true })
    },
    [request, updateQueryState],
  )

  const openQuery = useCallback(() => {
    const current = latest.current
    if (current.mode === "filter") {
      request(0)
      updateQueryState({ applied: "", draft: "", editing: true, searchPosition: 0 })
      return
    }
    updateQueryState({ ...current.queryState, draft: "", editing: true })
  }, [request, updateQueryState])

  const acceptQuery = useCallback(() => {
    const current = latest.current
    const value = current.queryState.draft
    if (value.length === 0 || current.mode === undefined || current.fields === undefined) {
      clearQuery()
      return
    }
    if (current.mode === "filter") {
      updateQueryState({ applied: value, draft: value, editing: false, searchPosition: 0 })
      return
    }

    const matches = searchMatchIndices(current.items, value, current.fields)
    const position = matches.length === 0 ? 0 : firstMatchAfter(matches, current.index)
    const target = matches[position]
    if (target !== undefined) request(target)
    updateQueryState({ applied: value, draft: value, editing: false, searchPosition: position })
  }, [clearQuery, request, updateQueryState])

  const moveSearch = useCallback(
    (delta: -1 | 1) => {
      const current = latest.current
      const matches = current.searchIndices
      if (matches.length === 0) return
      const position = Math.min(Math.max(current.queryState.searchPosition, 0), matches.length - 1)
      const match = matches[position]
      if (match === undefined) return

      if ((delta > 0 && current.index < match) || (delta < 0 && current.index > match)) {
        request(match)
        return
      }

      const next = (position + delta + matches.length) % matches.length
      const target = matches[next]
      if (target === undefined) return
      request(target)
      updateQueryState({ ...current.queryState, searchPosition: next })
    },
    [request, updateQueryState],
  )

  useKeyCapture(queryOptions !== undefined && queryState.editing)

  useOptionalCommand(
    queryOptions
      ? {
          id: `${idPrefix}.query.open`,
          title: `${queryOptions.mode === "filter" ? "Filter" : "Search"} this ${noun} list`,
          hint: queryOptions.mode,
          keys: "/",
          run: openQuery,
        }
      : null,
  )
  useOptionalCommand(
    queryOptions
      ? {
          id: `${idPrefix}.query.accept`,
          title: `Apply ${queryOptions.mode}`,
          keys: "return",
          capture: true,
          hidden: true,
          run: acceptQuery,
        }
      : null,
  )
  useOptionalCommand(
    queryOptions
      ? {
          id: `${idPrefix}.query.cancel`,
          title: `Cancel ${queryOptions.mode}`,
          keys: "escape",
          capture: true,
          hidden: true,
          run: clearQuery,
        }
      : null,
  )
  useOptionalCommand(
    queryOptions && !queryState.editing && queryState.applied.length > 0
      ? {
          id: `${idPrefix}.query.clear`,
          title: `Clear ${queryOptions.mode}`,
          keys: "escape",
          hidden: true,
          run: clearQuery,
        }
      : null,
  )
  useOptionalCommand(
    mode === "search" && !queryState.editing && queryState.applied.length > 0
      ? {
          id: `${idPrefix}.query.next`,
          title: `Next matching ${noun}`,
          keys: "n",
          hidden: true,
          run: () => moveSearch(1),
        }
      : null,
  )
  useOptionalCommand(
    mode === "search" && !queryState.editing && queryState.applied.length > 0
      ? {
          id: `${idPrefix}.query.previous`,
          title: `Previous matching ${noun}`,
          keys: "shift+n",
          hidden: true,
          run: () => moveSearch(-1),
        }
      : null,
  )

  const hostState: HostListQueryState = {
    mode: mode ?? "filter",
    value: queryState.editing ? queryState.draft : queryState.applied,
    editing: queryState.editing,
    matchCount: mode === "search" ? searchIndices.length : visibleItems.length,
    totalCount: items.length,
    currentMatch:
      mode === "search"
        ? currentSearchMatch === undefined
          ? null
          : searchPosition
        : visibleItems.length === 0
          ? null
          : index,
  }
  const queryRegistration = useRef<HostListQueryRegistration | null>(null)
  useEffect(() => {
    if (queryOptions === undefined) return
    const registration = runtime.listQuery.register(pane.paneId, idPrefix, inputQuery, hostState)
    queryRegistration.current = registration
    return () => {
      if (queryRegistration.current === registration) queryRegistration.current = null
      registration.dispose()
    }
  }, [idPrefix, inputQuery, pane.paneId, queryOptions === undefined, runtime])
  useEffect(() => {
    queryRegistration.current?.update(hostState)
  }, [
    hostState.currentMatch,
    hostState.editing,
    hostState.matchCount,
    hostState.mode,
    hostState.totalCount,
    hostState.value,
  ])

  // Each motion binds the vim key and its arrow/nav twin. A config rebind replaces the whole
  // list for that Command, which is the way to get only one of the two.
  useCommand({
    id: `${idPrefix}.cursor.down`,
    title: `Next ${noun}`,
    keys: ["j", "down"],
    hidden: true,
    run: () => request(Math.min(index + 1, Math.max(last, 0))),
  })
  useCommand({
    id: `${idPrefix}.cursor.up`,
    title: `Previous ${noun}`,
    keys: ["k", "up"],
    hidden: true,
    run: () => request(Math.max(index - 1, 0)),
  })
  useCommand({
    id: `${idPrefix}.cursor.first`,
    title: `First ${noun}`,
    keys: ["g", "home"],
    hidden: true,
    run: () => request(0),
  })
  useCommand({
    id: `${idPrefix}.cursor.last`,
    title: `Last ${noun}`,
    // `shift+g`, not `G`: the parser lowercases a bare letter, colliding with `g` above.
    keys: ["shift+g", "end"],
    hidden: true,
    run: () => request(Math.max(last, 0)),
  })

  const scrollRef = useCallback((node: ScrollSurface | null) => {
    surface.current = node
  }, [])

  const setIndex = request
  const rowId = useCallback((row: number) => `${idPrefix}.row.${row}`, [idPrefix])
  const query =
    queryOptions === undefined
      ? undefined
      : {
          mode: queryOptions.mode,
          value: queryState.applied,
          editing: queryState.editing,
          matchCount: hostState.matchCount,
          currentMatch: mode === "search" && currentSearchMatch !== undefined ? searchPosition : null,
          clear: clearQuery,
        }
  return { items: visibleItems, index, selected: visibleItems[index], query, setIndex, scrollRef, rowId }
}

export function createCell<T>(initial: T): Cell<T> {
  let current = initial
  const listeners = new Set<() => void>()

  // Hoisted out of `use()` for a stable identity: a fresh closure per render would make React
  // tear the subscription down and rebuild it every time.
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
      const listenerSnapshot = [...listeners]
      for (const listener of listenerSnapshot) listener()
    },
    use() {
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    },
  }
}

export function useTheme(): Theme {
  const runtime = useRuntime()
  return useSyncExternalStore(runtime.theme.subscribe, runtime.theme.getSnapshot, runtime.theme.getSnapshot)
}
