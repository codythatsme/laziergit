import type { Commit } from "laziergit"

import { authorColor, type AuthorColor } from "./authors"

export type CommitGraphTone =
  | "neutral"
  | "highlight"
  | "accent"
  | "success"
  | "warning"
  | "info"
  | "danger"
  | AuthorColor

export interface CommitGraphSpan {
  readonly text: string
  readonly tone: CommitGraphTone
}

export type CommitGraphRow = readonly CommitGraphSpan[]

type GraphCommit = Pick<Commit, "oid" | "parents" | "author">
type PipeKind = "terminates" | "starts" | "continues"

interface Pipe {
  readonly fromOid: string
  readonly toOid: string
  readonly tone: CommitGraphTone
  readonly fromPos: number
  readonly toPos: number
  readonly kind: PipeKind
}

type CellType = "connection" | "commit" | "merge"

interface Cell {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
  type: CellType
  tone: CommitGraphTone
  rightTone: CommitGraphTone | null
}

interface Glyph {
  readonly text: string
  readonly tone: CommitGraphTone
}

const emptyTreeOid = "LAZIERGIT_EMPTY_TREE"
const graphStartOid = "LAZIERGIT_GRAPH_START"

/**
 * Renders the same two-column-per-lane commit graph lazygit draws. The implementation is a
 * TypeScript port of `vendor/lazygit/pkg/gui/presentation/graph`: pipes carry parent identity
 * between rows, then each row collapses those pipes into box-drawing cells.
 *
 * Commits must be newest-first and topologically ordered. Each returned row ends in one space,
 * ready to be placed directly before the commit hash.
 */
export function renderCommitGraph(commits: readonly GraphCommit[], selectedOid?: string): readonly CommitGraphRow[] {
  if (commits.length === 0) return []

  const first = commits[0]
  if (first === undefined) return []

  let pipes: readonly Pipe[] = [
    {
      fromPos: 0,
      toPos: 0,
      fromOid: graphStartOid,
      toOid: first.oid,
      kind: "starts",
      tone: "neutral",
    },
  ]

  return commits.map((commit, index) => {
    pipes = nextPipes(pipes, commit)
    return renderPipeSet(pipes, selectedOid, commits[index - 1])
  })
}

function nextPipes(previous: readonly Pipe[], commit: GraphCommit): readonly Pipe[] {
  let maxPos = 0
  for (const pipe of previous) maxPos = Math.max(maxPos, pipe.toPos)

  // A pipe that ended on the preceding row no longer participates in layout.
  const current = previous.filter((pipe) => pipe.kind !== "terminates")
  let commitPos = maxPos + 1
  for (const pipe of current) {
    if (pipe.toOid === commit.oid) {
      commitPos = pipe.toPos
      break
    }
  }

  const next: Pipe[] = [
    {
      fromPos: commitPos,
      toPos: commitPos,
      fromOid: commit.oid,
      toOid: commit.parents[0] ?? emptyTreeOid,
      kind: "starts",
      tone: authorColor(commit.author.name),
    },
  ]
  const taken = new Set<number>()
  const traversed = new Set<number>()
  const continuingDestinations = new Set(current.filter((pipe) => pipe.toOid !== commit.oid).map((pipe) => pipe.toPos))

  const nextContinuingPosition = (): number => firstFree((position) => !traversed.has(position))
  const nextNewPosition = (): number =>
    firstFree((position) => !taken.has(position) && !continuingDestinations.has(position))

  const traverse = (from: number, to: number): void => {
    const left = Math.min(from, to)
    const right = Math.max(from, to)
    for (let position = left; position <= right; position += 1) traversed.add(position)
    taken.add(to)
  }

  for (const pipe of current) {
    if (pipe.toOid === commit.oid) {
      next.push({
        fromPos: pipe.toPos,
        toPos: commitPos,
        fromOid: pipe.fromOid,
        toOid: pipe.toOid,
        kind: "terminates",
        tone: pipe.tone,
      })
      traverse(pipe.toPos, commitPos)
    } else if (pipe.toPos < commitPos) {
      const available = nextContinuingPosition()
      next.push({
        fromPos: pipe.toPos,
        toPos: available,
        fromOid: pipe.fromOid,
        toOid: pipe.toOid,
        kind: "continues",
        tone: pipe.tone,
      })
      traverse(pipe.toPos, available)
    }
  }

  for (const parent of commit.parents.slice(1)) {
    const available = nextNewPosition()
    next.push({
      fromPos: commitPos,
      toPos: available,
      fromOid: commit.oid,
      toOid: parent,
      kind: "starts",
      tone: authorColor(commit.author.name),
    })
    taken.add(available)
  }

  for (const pipe of current) {
    if (pipe.toOid === commit.oid || pipe.toPos <= commitPos) continue

    let available = pipe.toPos
    for (let position = pipe.toPos; position > commitPos; position -= 1) {
      if (taken.has(position) || traversed.has(position)) break
      available = position
    }
    next.push({
      fromPos: pipe.toPos,
      toPos: available,
      fromOid: pipe.fromOid,
      toOid: pipe.toOid,
      kind: "continues",
      tone: pipe.tone,
    })
    traverse(pipe.toPos, available)
  }

  return next.sort((left, right) => left.toPos - right.toPos || pipeKindOrder(left.kind) - pipeKindOrder(right.kind))
}

function renderPipeSet(
  pipes: readonly Pipe[],
  selectedOid: string | undefined,
  previousCommit: GraphCommit | undefined,
): CommitGraphRow {
  let maxPos = 0
  let commitPos = 0
  let startCount = 0
  for (const pipe of pipes) {
    if (pipe.kind === "starts") {
      startCount += 1
      commitPos = pipe.fromPos
    } else if (pipe.kind === "terminates") {
      commitPos = pipe.toPos
    }
    maxPos = Math.max(maxPos, pipe.fromPos, pipe.toPos)
  }

  const cells = Array.from({ length: maxPos + 1 }, createCell)
  const paintPipe = (pipe: Pipe, tone: CommitGraphTone, overrideRightTone: boolean): void => {
    const left = Math.min(pipe.fromPos, pipe.toPos)
    const right = Math.max(pipe.fromPos, pipe.toPos)
    if (left !== right) {
      for (let position = left + 1; position < right; position += 1) {
        setLeft(cellAt(cells, position), tone)
        setRight(cellAt(cells, position), tone, overrideRightTone)
      }
      setRight(cellAt(cells, left), tone, overrideRightTone)
      setLeft(cellAt(cells, right), tone)
    }

    if (pipe.kind === "starts" || pipe.kind === "continues") setDown(cellAt(cells, pipe.toPos), tone)
    if (pipe.kind === "terminates" || pipe.kind === "continues") setUp(cellAt(cells, pipe.fromPos), tone)
  }

  // A direct parent on the next row shares the same cell as the selected commit. Highlighting
  // both nodes would imply both are selected, so only retain the highlight when an edge is seen.
  let highlight = selectedOid !== undefined
  if (previousCommit?.oid === selectedOid) {
    highlight = pipes.some(
      (pipe) => pipe.fromOid === selectedOid && (pipe.kind !== "terminates" || pipe.fromPos !== pipe.toPos),
    )
  }

  const selectedPipes = pipes.filter((pipe) => highlight && pipe.fromOid === selectedOid)
  const ordinaryPipes = pipes.filter((pipe) => !highlight || pipe.fromOid !== selectedOid)

  // Starting pipes establish a commit's color. Crossings are laid over them afterward, and the
  // selected commit's own path is painted last so it remains legible through intersections.
  for (const pipe of ordinaryPipes) {
    if (pipe.kind === "starts") paintPipe(pipe, pipe.tone, true)
  }
  for (const pipe of ordinaryPipes) {
    if (
      pipe.kind !== "starts" &&
      !(pipe.kind === "terminates" && pipe.fromPos === commitPos && pipe.toPos === commitPos)
    ) {
      paintPipe(pipe, pipe.tone, false)
    }
  }
  for (const pipe of selectedPipes) {
    for (
      let position = Math.min(pipe.fromPos, pipe.toPos);
      position <= Math.max(pipe.fromPos, pipe.toPos);
      position += 1
    ) {
      resetCell(cellAt(cells, position))
    }
  }
  for (const pipe of selectedPipes) {
    paintPipe(pipe, "highlight", true)
    if (pipe.toPos === commitPos) cellAt(cells, pipe.toPos).tone = "highlight"
  }

  cellAt(cells, commitPos).type = startCount > 1 ? "merge" : "commit"
  return collapse(cells.flatMap(renderCell))
}

function createCell(): Cell {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    type: "connection",
    tone: "neutral",
    rightTone: null,
  }
}

function resetCell(cell: Cell): void {
  cell.up = false
  cell.down = false
  cell.left = false
  cell.right = false
}

function setUp(cell: Cell, tone: CommitGraphTone): void {
  cell.up = true
  cell.tone = tone
}

function setDown(cell: Cell, tone: CommitGraphTone): void {
  cell.down = true
  cell.tone = tone
}

function setLeft(cell: Cell, tone: CommitGraphTone): void {
  cell.left = true
  if (!cell.up && !cell.down) cell.tone = tone
}

function setRight(cell: Cell, tone: CommitGraphTone, override: boolean): void {
  cell.right = true
  if (cell.rightTone === null || override) cell.rightTone = tone
}

function renderCell(cell: Cell): readonly Glyph[] {
  const [first, second] = boxDrawingCharacters(cell.up, cell.down, cell.left, cell.right)
  const node = cell.type === "commit" ? "○" : cell.type === "merge" ? "◎" : first
  return [
    { text: node, tone: cell.tone },
    { text: second, tone: cell.rightTone ?? cell.tone },
  ]
}

function collapse(glyphs: readonly Glyph[]): CommitGraphRow {
  const spans: CommitGraphSpan[] = []
  for (const glyph of glyphs) {
    const previous = spans[spans.length - 1]
    if (previous?.tone === glyph.tone) {
      spans[spans.length - 1] = { text: previous.text + glyph.text, tone: glyph.tone }
    } else {
      spans.push(glyph)
    }
  }
  return spans
}

function boxDrawingCharacters(up: boolean, down: boolean, left: boolean, right: boolean): readonly [string, string] {
  if (up && down && left && right) return ["│", "─"]
  if (up && down && left && !right) return ["│", " "]
  if (up && down && !left && right) return ["│", "─"]
  if (up && down && !left && !right) return ["│", " "]
  if (up && !down && left && right) return ["┴", "─"]
  if (up && !down && left && !right) return ["╯", " "]
  if (up && !down && !left && right) return ["╰", "─"]
  if (up && !down && !left && !right) return ["╵", " "]
  if (!up && down && left && right) return ["┬", "─"]
  if (!up && down && left && !right) return ["╮", " "]
  if (!up && down && !left && right) return ["╭", "─"]
  if (!up && down && !left && !right) return ["╷", " "]
  if (!up && !down && left && right) return ["─", "─"]
  if (!up && !down && left && !right) return ["─", " "]
  if (!up && !down && !left && right) return ["╶", "─"]
  return [" ", " "]
}

function firstFree(available: (position: number) => boolean): number {
  for (let position = 0; ; position += 1) {
    if (available(position)) return position
  }
}

function pipeKindOrder(kind: PipeKind): number {
  if (kind === "terminates") return 0
  if (kind === "starts") return 1
  return 2
}

function cellAt(cells: readonly Cell[], position: number): Cell {
  const cell = cells[position]
  if (cell === undefined) throw new RangeError(`Commit graph cell ${position} is outside the row`)
  return cell
}
