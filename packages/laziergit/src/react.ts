import { PaneRuntimeContext, RuntimeContext } from "@laziergit/runtime-bridge"
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import type { HostRuntime, PaneRuntime } from "./host"
import type { Cell, CommandSpec, EventMap, GitActivity, GitState, Theme } from "./types"

/**
 * The two React contexts carry `unknown` — they live in the bridge package precisely so
 * this package and the host never import each other's types — so this file is the boundary
 * where they become typed, and a boundary is parsed rather than asserted. The guards check
 * only what these hooks actually reach for: a lie about anything deeper would be a lie the
 * host told itself, not one an Extension can construct.
 */
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
 * Two layers of memoization, and both are load-bearing. Within one selector identity the
 * selection is computed once per store snapshot — React calls `getSnapshot` several times
 * per render, and the store guarantees a stable snapshot object between publishes, so the
 * selector runs once. Across renders, `committed` carries the value React last rendered,
 * which is what `isEqual` compares against: that is what keeps a derived object (`(s) =>
 * s.status.staged.map(...)`) from re-rendering forever, even though an inline selector has
 * a fresh identity on every render and resets the inner memo.
 *
 * Keying the memo on `selector` is what makes a selector that closes over props correct —
 * a changed selector must not keep returning the previous one's value.
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
      // Reuse the rendered value when the selection is equivalent, so the identity React
      // compares against stays put.
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
 * The git writes in flight right now, oldest first — so `.at(-1)` is the one that started most
 * recently, which is what a one-line surface should name when two overlap.
 *
 * Every write goes through core, so this sees all of them wherever they were invoked from: a
 * `push` from the sync Command, the one buried in the branches menu, a `commit` held up by a
 * pre-commit hook, a `raw(["merge", …])` an Extension built itself. Nothing has to opt in, and
 * an Extension cannot leave its own work unreported.
 *
 * Reads never appear, and neither does the background poll. An operation that settles inside
 * ~120ms never appears either, which is what makes this safe to render directly — no debounce
 * of your own, no spinner blinking once per staged hunk.
 *
 * ```tsx
 * const [busy] = useGitActivity().slice(-1);
 * return busy ? <text>{`${spinner} ${busy.label}`}</text> : null;
 * ```
 */
export function useGitActivity(): readonly GitActivity[] {
  const runtime = useRuntime()
  // Passed through unwrapped: the store returns the same frozen array between publishes, so
  // React sees a stable identity and a fresh closure per render would only churn the
  // subscription — the same reason `useTheme` hands over bound methods.
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
 * Only `run` is live: it is read through a ref, so it always sees the current render's
 * closure and a Command never acts on stale state. The rest of the spec — `title`, `hint`,
 * `keys`, `hidden`, `capture` — is read once, at registration, and a later render changing
 * one of them does not re-register.
 *
 * That is deliberate rather than pending. Re-registering on every spec change would reorder
 * {@link CommandSpec.keys} conflict resolution, which is insertion-ordered, so a Pane that
 * recomputed a title would be able to take a key away from another Pane mid-session —
 * trading a stale cheat-sheet label for nondeterministic key ownership. `keys` is a default
 * the user's config overrides anyway (§1.7), and dynamic capture belongs to
 * {@link useKeyCapture} (§5.8). A Command whose *identity* changes should change its `id`,
 * which does re-register.
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
 * Claim raw keyboard input for the enclosing Pane while `active` — for a Pane that renders
 * its own `<textarea>` or `<input>`, where every ordinary keybinding is a typo waiting to
 * happen (`q` quits, `?` opens the cheat sheet).
 *
 * The same mechanism a popup uses, one band lower: while a Pane captures, the global layer
 * and every Pane layer go inert, and only this Pane's Commands registered with
 * `capture: true` stay live. That keeps the exit keys Commands — rebindable, in the
 * catalog, in the cheat sheet — instead of a second raw key-handler API beside the Command
 * unit (§5.8). A popup still outranks a capture, so `confirm` mid-edit behaves normally.
 * Claims nest: the most recent one is in force and disposing it restores the previous.
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
 * The slice of OpenTUI's `<scrollbox>` the scrolling seam drives.
 *
 * Declared structurally rather than imported, for the same reason `commit-flow` declares
 * its textarea that way: an Extension may import only `"laziergit"`, `"react"` and
 * `"@opentui/react"` (ADR-0001), and `ScrollBoxRenderable` lives in `@opentui/core`. A
 * callback ref still checks the shape against the real renderable on assignment.
 */
export interface ScrollSurface {
  scrollTop: number
  /** Total height of the content, in rows. */
  readonly scrollHeight: number
  readonly viewport: { readonly height: number }
  /**
   * Scroll the descendant carrying `childId` just far enough to be visible, or do nothing if
   * it already is — OpenTUI's own `scrollIntoView({ block: "nearest" })`, which measures the
   * element where it was actually laid out.
   *
   * This is what lets {@link ListCursor} follow a cursor without anyone computing a row
   * number. Group headers, multi-line rows and a collapsed tree all change where a row lands
   * on screen, and layout already knows where that is; arithmetic agreeing with layout is a
   * second model to keep in step, and the one place it was tried it had to be undone by a
   * proxy over this very interface.
   */
  scrollChildIntoView(childId: string): void
}

/** Imperative control of a Pane's `<scrollbox>` — see {@link useScrollView}. */
export interface ScrollView {
  /**
   * Callback ref for the `<scrollbox>` this view drives. Give the box
   * `flexGrow={1} flexBasis={0}`: without the basis its flex size is its *content* height,
   * so a long document makes the box taller than the Pane and paints over the Pane's own
   * header instead of scrolling inside it.
   */
  readonly ref: (surface: ScrollSurface | null) => void
  /** Rows the viewport shows, or 0 before the first layout. The measurement page-wise motions need. */
  viewportRows(): number
  /** Scroll by whole rows; negative is up. Clamped to the content. */
  scrollBy(rows: number): void
  /** Scroll to an absolute row, or to either end. Clamped to the content. */
  scrollTo(row: number | "start" | "end"): void
}

/**
 * Imperative scrolling for a Pane that shows more than fits and has no cursor to follow —
 * the bundled diff Pane, whose `<diff>` renders a whole patch and clips the rest.
 *
 * The `<scrollbox>` OpenTUI ships is focusable and handles its own keys, but nothing in
 * laziergit ever gives it renderer focus (keys arrive as Commands, and focus belongs to the
 * Layout), so its key handling never runs. This is the seam that reaches it instead — the
 * scroll half of what §5.11 declines to ship as a component kit.
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

  // Stable identity, so the callback ref does not detach and reattach on every render and
  // a Command closing over the view keeps working across renders.
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
        // `scrollHeight` for "end" rather than `scrollHeight - viewportRows`: the setter
        // clamps, and doing the arithmetic here would only be a second place to get it wrong.
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
   * Your Extension's name: the Commands are registered as `${idPrefix}.cursor.*`, and the
   * prefix is checked at runtime like every other {@link useCommand} id (§1.8). It also
   * names the rows — see {@link ListCursor.rowId} — so an Extension with two list Panes
   * gives them different prefixes, exactly as their Command ids already require.
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
   * the selected row is scrolled into view whenever the cursor moves past the edge of the
   * viewport. Give the box `flexGrow={1} flexBasis={0}` — see {@link ScrollView.ref}.
   *
   * ```tsx
   * <scrollbox ref={cursor.scrollRef} flexGrow={1} flexBasis={0}>{rows}</scrollbox>
   * ```
   * Optional only in the sense that a Pane short enough never to overflow does not need
   * it; every list Pane that can overflow does, because the cursor is what every key acts
   * on and an invisible cursor is worse than no cursor.
   */
  readonly scrollRef: (surface: ScrollSurface | null) => void
  /**
   * The `id` to put on the element drawn for `items[index]`, so the cursor can find that row
   * and scroll it into view.
   *
   * ```tsx
   * {items.map((item, index) => (
   *   <box key={item.id} id={cursor.rowId(index)}>…</box>
   * ))}
   * ```
   *
   * An id rather than a row number because the two are not the same thing the moment a Pane
   * draws anything between its rows — a group header, a blank line, a second line of detail.
   * Layout already knows where the row landed, so revealing asks it (see
   * {@link ScrollSurface.scrollChildIntoView}) instead of keeping a parallel height model
   * that has to agree with it.
   */
  rowId(index: number): string
}

/**
 * Cursor state for a list Pane, with `j` / `k` / `g` / `G` registered as hidden
 * Pane-scoped Commands.
 *
 * Four Bundled list Panes want the identical thing, and ADR-0001 gives them no sibling
 * package to share it from, so it is public API rather than the same 30 lines four times.
 * Attach {@link ListCursor.scrollRef} to the Pane's `<scrollbox>`, or the cursor walks off
 * the bottom of it and the selection — still what every key acts on — becomes invisible.
 *
 * Half-page motions (`ctrl+d` / `ctrl+u`) stay absent, but they are no longer impossible:
 * a Pane that wants them measures with {@link ScrollView.viewportRows} and moves the cursor
 * with {@link ListCursor.setIndex}. Nothing here guesses a constant on its behalf.
 */
export function useListCursor<T>({ items, idPrefix, noun }: ListCursorOptions<T>): ListCursor<T> {
  const [requested, setRequested] = useState(0)
  const surface = useRef<ScrollSurface | null>(null)
  const last = items.length - 1
  // Clamped on read, so the render where the list shrank already draws a valid cursor
  // rather than a highlight on a row that is gone.
  const index = last < 0 ? 0 : Math.min(Math.max(requested, 0), last)

  // ...and written back, because a clamp that lived only in the read would resurrect the
  // old position the moment the list grew again. Replacing a list with an equal-length one
  // touches neither, which is what keeps the cursor still across a refresh.
  //
  // Revealing rides along here rather than in an effect of its own, because this one
  // already runs on exactly the renders that can move the cursor away from the window it
  // was in: a keypress (which moves `requested`) and a clamp (which moves `index` on its
  // own, so the row the cursor lands on after a delete can be above the window the old one
  // left behind).
  useEffect(() => {
    if (requested !== index) setRequested(index)
    // Layout has resolved by the time an effect runs, so the row is where OpenTUI will draw
    // it and this needs no deferral — the reveal is a plain call, not a hook that schedules
    // a frame and re-renders itself.
    surface.current?.scrollChildIntoView(`${idPrefix}.row.${index}`)
  }, [requested, index, idPrefix])

  // Each motion binds the vim key and the arrow/nav key that means the same thing, so muscle
  // memory from either reaches the same Command. A user rebinding one of these in config
  // replaces the whole list for that Command (config keys win outright, §1.7), which is the
  // escape hatch for anyone who wants only one of the two.
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
    // `shift+g`, not `G`: the binding parser lowercases a bare letter, so `"G"` would bind
    // the same stroke as the `g` above and one of them would silently never fire (§1.1).
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

  // Hoisted out of `use()` so their identities are stable across renders: a fresh
  // `subscribe` closure per render makes React tear the subscription down and rebuild it
  // on every render, which is exactly the churn `useTheme` passes bound methods to avoid.
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
  // Passed through rather than wrapped: a fresh closure per render would make React tear
  // down and re-establish the subscription on every render.
  return useSyncExternalStore(runtime.theme.subscribe, runtime.theme.getSnapshot, runtime.theme.getSnapshot)
}
