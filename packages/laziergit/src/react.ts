import { PaneRuntimeContext, RuntimeContext } from "@laziergit/runtime-bridge"
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import type { HostRuntime, PaneRuntime } from "./host"
import type { Cell, CommandSpec, EventMap, GitActivity, GitState, Theme } from "./types"

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
 * Only `run` is live, read through a ref so it never acts on stale state. The rest of the spec
 * is read once at registration: re-registering would reorder {@link CommandSpec.keys} conflict
 * resolution, which is insertion-ordered, letting a recomputed title take a key from another
 * Pane mid-session. A Command whose identity changes should change its `id`.
 */
export function useCommand(spec: Omit<CommandSpec, "pane">): void {
  const runtime = useRuntime()
  const pane = useEnclosingPane("useCommand")
  const latest = useRef(spec)
  latest.current = spec

  useEffect(() => {
    const registered = runtime.commands.registerComponent(pane.extension, pane.paneId, {
      ...latest.current,
      run: () => latest.current.run(),
    })
    return () => registered.dispose()
  }, [pane.extension, pane.paneId, runtime, spec.id])
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
 * because an Extension may not import `@opentui/core` (ADR-0001).
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
}

/** A cursor over a list, and the row it points at. */
export interface ListCursor<T> {
  /** Always in range: 0 while the list is empty, never past its end. */
  readonly index: number
  readonly selected: T | undefined
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
   *   <box key={item.id} id={cursor.rowId(index)}>…</box>
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
export function useListCursor<T>({ items, idPrefix, noun }: ListCursorOptions<T>): ListCursor<T> {
  const [requested, setRequested] = useState(0)
  const surface = useRef<ScrollSurface | null>(null)
  const last = items.length - 1
  // Clamped on read, so the render where the list shrank already draws a valid cursor.
  const index = last < 0 ? 0 : Math.min(Math.max(requested, 0), last)

  // ...and written back, or the clamp would resurrect the old position once the list grew
  // again. Revealing rides along here because this effect runs on exactly the renders that can
  // move the cursor out of the viewport: a keypress, and a clamp.
  useEffect(() => {
    if (requested !== index) setRequested(index)
    surface.current?.scrollChildIntoView(`${idPrefix}.row.${index}`)
  }, [requested, index, idPrefix])

  // Each motion binds the vim key and its arrow/nav twin. A config rebind replaces the whole
  // list for that Command (§1.7), which is the way to get only one of the two.
  useCommand({
    id: `${idPrefix}.cursor.down`,
    title: `Next ${noun}`,
    keys: ["j", "down"],
    hidden: true,
    run: () => setRequested(Math.min(index + 1, Math.max(last, 0))),
  })
  useCommand({
    id: `${idPrefix}.cursor.up`,
    title: `Previous ${noun}`,
    keys: ["k", "up"],
    hidden: true,
    run: () => setRequested(Math.max(index - 1, 0)),
  })
  useCommand({
    id: `${idPrefix}.cursor.first`,
    title: `First ${noun}`,
    keys: ["g", "home"],
    hidden: true,
    run: () => setRequested(0),
  })
  useCommand({
    id: `${idPrefix}.cursor.last`,
    title: `Last ${noun}`,
    // `shift+g`, not `G`: the parser lowercases a bare letter, colliding with `g` above.
    keys: ["shift+g", "end"],
    hidden: true,
    run: () => setRequested(Math.max(last, 0)),
  })

  const scrollRef = useCallback((node: ScrollSurface | null) => {
    surface.current = node
  }, [])

  const setIndex = useCallback((next: number) => setRequested(next), [])
  const rowId = useCallback((row: number) => `${idPrefix}.row.${row}`, [idPrefix])
  return { index, selected: items[index], setIndex, scrollRef, rowId }
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
