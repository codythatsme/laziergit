import type { LayoutConfig } from "../config/config"
import type { PaneEntry } from "../extension/pane-host"

/** One cell of the resolved screen: a tab group of Panes, of which one is active. */
export interface ResolvedCell {
  /** Stable React key and focus target id. */
  readonly key: string
  readonly paneIds: readonly string[]
}

export interface ResolvedColumn {
  readonly weight: number
  readonly cells: readonly ResolvedCell[]
}

export interface ResolvedLayout {
  readonly columns: readonly ResolvedColumn[]
}

/** A Pane cannot push the Layout arbitrarily wide with a hint; columns past this fold in. */
const maxHintedColumn = 8

interface DraftCell {
  /**
   * Identity that survives membership changes: a config cell is its declared position,
   * a hinted cell is the Pane that opened it. Used as the React key and the key that
   * remembers which tab is showing, so losing a tab never remounts its neighbours.
   */
  readonly key: string
  readonly paneIds: string[]
}

interface DraftColumn {
  weight: number
  readonly cells: DraftCell[]
}

function draftColumn(weight = 1): DraftColumn {
  return { weight, cells: [] }
}

function cellOf(columns: readonly DraftColumn[], paneId: string): DraftCell | undefined {
  for (const column of columns) {
    for (const cell of column.cells) {
      if (cell.paneIds.includes(paneId)) return cell
    }
  }
  return undefined
}

/** Clamped and sanitised: a hint of `NaN` or `Infinity` must not drop a Pane or hang. */
function hintedColumn(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 0
  return Math.min(Math.max(0, Math.trunc(requested)), maxHintedColumn)
}

/**
 * Column 0 is the lists, everything right of it is the detail. Equal columns made the diff —
 * the one Pane whose whole job is to be read — as narrow as a column of branch names. The same
 * 1:2 proportion the shipped config uses; `layout.columns[].weight` still overrides it.
 */
function hintedWeight(index: number): number {
  return index === 0 ? 1 : 2
}

function columnAt(columns: DraftColumn[], index: number): DraftColumn {
  while (columns.length <= index) columns.push(draftColumn(hintedWeight(columns.length)))
  const column = columns[index]
  if (column) return column
  const created = draftColumn(hintedWeight(index))
  columns[index] = created
  return created
}

function comparePlacement(left: PaneEntry, right: PaneEntry): number {
  const order = (left.placement?.order ?? 100) - (right.placement?.order ?? 100)
  return order !== 0 ? order : left.id.localeCompare(right.id)
}

/**
 * Turns the user's Layout plus every registered Pane into the arrangement the screen
 * renders. Config wins for every Pane it mentions; a Pane it leaves out lands wherever
 * its Extension's placement hint asks, which is the whole contract of {@link PlacementHint}.
 */
export function resolveLayout(config: LayoutConfig | null, panes: readonly PaneEntry[]): ResolvedLayout {
  const registered = new Map(panes.map((pane) => [pane.id, pane]))
  const columns: DraftColumn[] = []
  const placed = new Set<string>()

  for (const [columnIndex, configured] of (config?.columns ?? []).entries()) {
    const column = draftColumn(configured.weight)
    for (const [cellIndex, cell] of configured.cells.entries()) {
      const paneIds = cell.filter((paneId) => registered.has(paneId) && !placed.has(paneId))
      if (paneIds.length === 0) continue
      for (const paneId of paneIds) placed.add(paneId)
      column.cells.push({ key: `layout:${columnIndex}.${cellIndex}`, paneIds })
    }
    columns.push(column)
  }

  // Companions are resolved after the Panes that can host them, and then repeatedly, so
  // `tabWith` works whichever of the pair registered first.
  const unplaced = panes.filter((pane) => !placed.has(pane.id)).sort(comparePlacement)
  const companions = unplaced.filter((pane) => pane.placement?.tabWith !== undefined)
  for (const pane of unplaced) {
    if (pane.placement?.tabWith !== undefined) continue
    columnAt(columns, hintedColumn(pane.placement?.column)).cells.push({ key: `pane:${pane.id}`, paneIds: [pane.id] })
    placed.add(pane.id)
  }

  let pending = companions
  while (pending.length > 0) {
    const deferred: PaneEntry[] = []
    for (const pane of pending) {
      const group = cellOf(columns, pane.placement?.tabWith ?? "")
      if (group) {
        group.paneIds.push(pane.id)
        placed.add(pane.id)
      } else {
        deferred.push(pane)
      }
    }
    if (deferred.length === pending.length) break
    pending = deferred
  }

  // Whatever is left asked to join a Pane nothing registered: fall back to its column.
  for (const pane of pending) {
    columnAt(columns, hintedColumn(pane.placement?.column)).cells.push({ key: `pane:${pane.id}`, paneIds: [pane.id] })
    placed.add(pane.id)
  }

  return {
    columns: columns
      .filter((column) => column.cells.length > 0)
      .map((column) => ({
        weight: column.weight,
        cells: column.cells.map((cell) => ({ key: cell.key, paneIds: cell.paneIds })),
      })),
  }
}

export interface LayoutSnapshot {
  readonly layout: ResolvedLayout
  /** The Pane that owns the keyboard, or null while no Pane is live. */
  readonly focusedPaneId: string | null
  /** Cell key → the Pane showing in it. */
  readonly activeTabs: ReadonlyMap<string, string>
}

const emptySnapshot: LayoutSnapshot = Object.freeze({
  layout: Object.freeze({ columns: Object.freeze([]) }),
  focusedPaneId: null,
  activeTabs: new Map<string, string>(),
})

/**
 * Owns the arrangement of Panes and which one has focus. Focus lives here rather than in
 * the Pane registry because "the next Pane" is a question only the Layout can answer.
 */
export class LayoutHost {
  readonly #listeners = new Set<() => void>()
  readonly #activeTabs = new Map<string, string>()
  #config: LayoutConfig | null = null
  #panes: readonly PaneEntry[] = []
  #snapshot: LayoutSnapshot = emptySnapshot
  #focusedCell: string | null = null
  /** Whether anything has *chosen* a focus — a keypress, a Command, `PaneHandle.focus`. */
  #focusChosen = false
  #onFocus: ((paneId: string | null, previous: string | null) => void) | undefined

  getSnapshot = (): LayoutSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  setFocusListener(listener: (paneId: string | null, previous: string | null) => void): void {
    this.#onFocus = listener
  }

  setConfig(config: LayoutConfig | null): void {
    this.#config = config
    this.#recompute()
  }

  setPanes(panes: readonly PaneEntry[]): void {
    this.#panes = panes
    this.#recompute()
  }

  get focusedPaneId(): string | null {
    return this.#snapshot.focusedPaneId
  }

  /** Every Pane that can hold focus right now, in reading order. */
  liveTabs(): readonly string[] {
    return this.#cells().flatMap((cell) => cell.paneIds.filter((paneId) => this.#isLive(paneId)))
  }

  /**
   * Focuses the nth Pane of {@link liveTabs}, 0-based — the Pane the nth jump key names.
   *
   * Panes rather than cells: a cell holding four tabs would be one jump target showing
   * whichever tab it last had, leaving the other three with no key at all. {@link focus}
   * already brings a hidden tab to the front on the way.
   *
   * An index past the end does nothing rather than throwing: the Command carrying it can
   * outlive the Pane it was registered for by the width of a reload.
   */
  focusAt(index: number): void {
    const paneId = this.liveTabs()[index]
    if (paneId !== undefined) this.focus(paneId)
  }

  focus(paneId: string): void {
    if (!this.#isLive(paneId)) throw new Error(`Pane "${paneId}" has no live instance`)
    const cell = this.#cells().find((candidate) => candidate.paneIds.includes(paneId))
    if (!cell) throw new Error(`Pane "${paneId}" is not placed by the current Layout`)

    this.#activeTabs.set(cell.key, paneId)
    this.#focusedCell = cell.key
    this.#focusChosen = true
    this.#recompute()
  }

  /**
   * Makes `paneId` the visible tab of its cell, without moving the keyboard — the half a Pane
   * that follows someone else's selection needs. The diff Pane is tab-grouped with
   * `commit-flow`, so after a commit it would otherwise sit stranded behind the Commit tab
   * while every cursor move updated something nobody can see.
   *
   * Silent where {@link focus} throws: revealing runs on cursor movement, so "that Pane is not
   * on screen right now" is an ordinary condition rather than a programming error.
   */
  reveal(paneId: string): void {
    if (!this.#isLive(paneId)) return
    const cell = this.#cells().find((candidate) => candidate.paneIds.includes(paneId))
    if (!cell || this.#activeTabs.get(cell.key) === paneId) return
    this.#activeTabs.set(cell.key, paneId)
    this.#recompute()
  }

  /**
   * Puts focus on the Layout's first cell, unless something has already chosen one. Called
   * once, when activation has finished: Panes register one at a time and every registration
   * re-lays-out, so during startup "the first cell" is whichever Extension has got there so
   * far. Running continuously instead would drag focus across Panes mid-startup and fire their
   * focus-gated effects on the way past.
   */
  settleInitialFocus(): void {
    if (this.#focusChosen) return
    const requested = this.#config?.focus
    if (requested !== undefined && requested !== null && this.#isLive(requested)) {
      const cell = this.#cells().find((candidate) => candidate.paneIds.includes(requested))
      if (cell) {
        this.focus(requested)
        return
      }
    }
    const first = this.#focusableCells()[0]
    if (first) this.#focusCell(first)
  }

  /** Moves focus by whole cells, so tabbing never walks through hidden tabs. */
  focusStep(delta: number): void {
    const cells = this.#focusableCells()
    if (cells.length === 0) return
    const current = cells.findIndex((cell) => cell.key === this.#focusedCell)
    const next = cells[(((current === -1 ? 0 : current + delta) % cells.length) + cells.length) % cells.length]
    if (next) this.#focusCell(next)
  }

  /** Cycles the visible tab inside the focused cell. */
  cycleTab(delta: number): void {
    const cell = this.#cells().find((candidate) => candidate.key === this.#focusedCell)
    if (!cell) return
    const live = cell.paneIds.filter((paneId) => this.#isLive(paneId))
    if (live.length < 2) return

    const current = live.indexOf(this.#snapshot.focusedPaneId ?? "")
    const next = live[(((current === -1 ? 0 : current + delta) % live.length) + live.length) % live.length]
    if (next) this.focus(next)
  }

  #focusCell(cell: ResolvedCell): void {
    const target = this.#activeTabs.get(cell.key)
    const paneId = target !== undefined && this.#isLive(target) ? target : cell.paneIds.find((id) => this.#isLive(id))
    if (paneId) this.focus(paneId)
  }

  #cells(): readonly ResolvedCell[] {
    return this.#snapshot.layout.columns.flatMap((column) => column.cells)
  }

  #focusableCells(): readonly ResolvedCell[] {
    return this.#cells().filter((cell) => cell.paneIds.some((paneId) => this.#isLive(paneId)))
  }

  #isLive(paneId: string): boolean {
    return this.#panes.some((pane) => pane.id === paneId && pane.state === "active")
  }

  #recompute(): void {
    const layout = resolveLayout(this.#config, this.#panes)
    const cells = layout.columns.flatMap((column) => column.cells)
    const keys = new Set(cells.map((cell) => cell.key))
    for (const key of Array.from(this.#activeTabs.keys())) {
      if (!keys.has(key)) this.#activeTabs.delete(key)
    }

    for (const cell of cells) {
      const active = this.#activeTabs.get(cell.key)
      if (active === undefined || !cell.paneIds.includes(active)) {
        const replacement = cell.paneIds.find((paneId) => this.#isLive(paneId)) ?? cell.paneIds[0]
        if (replacement === undefined) this.#activeTabs.delete(cell.key)
        else this.#activeTabs.set(cell.key, replacement)
      }
    }

    const focusable = cells.filter((cell) => cell.paneIds.some((paneId) => this.#isLive(paneId)))
    if (this.#focusedCell === null || !cells.some((cell) => cell.key === this.#focusedCell)) {
      this.#focusedCell = focusable[0]?.key ?? null
    }

    const focusedTab = this.#focusedCell === null ? undefined : this.#activeTabs.get(this.#focusedCell)
    const focusedPaneId = focusedTab !== undefined && this.#isLive(focusedTab) ? focusedTab : null
    const previous = this.#snapshot.focusedPaneId

    this.#snapshot = { layout, focusedPaneId, activeTabs: new Map(this.#activeTabs) }
    this.#publish()

    if (focusedPaneId !== previous) {
      try {
        this.#onFocus?.(focusedPaneId, previous)
      } catch {
        // Focus observers cannot change Layout focus semantics.
      }
    }
  }

  #publish(): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // Snapshot observers cannot poison Layout recomputation.
      }
    }
  }
}
