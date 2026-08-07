import { parseConflictMarker } from "laziergit"

export type ConflictSideChoice = "current" | "ancestor" | "incoming"
export type ConflictChoice = ConflictSideChoice | "both"

export interface ConflictBlock {
  readonly start: number
  readonly ancestor: number | null
  readonly separator: number
  readonly end: number
  readonly markerSize: number
}

export type ConflictParseResult =
  | { readonly kind: "ready"; readonly lines: readonly string[]; readonly conflicts: readonly ConflictBlock[] }
  | { readonly kind: "malformed"; readonly message: string }

export interface ConflictSession {
  readonly content: string
  readonly lines: readonly string[]
  readonly conflicts: readonly ConflictBlock[]
  readonly conflictIndex: number
  readonly side: ConflictSideChoice
  readonly undo: readonly string[]
}

export interface ConflictResolution {
  readonly content: string
  /** Null after the last marker block was resolved. */
  readonly session: ConflictSession | null
}

/** Split without losing CRLF or the absence of a final newline. */
export function splitLines(content: string): readonly string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

export function parseConflicts(content: string): ConflictParseResult {
  const lines = splitLines(content)
  const conflicts: ConflictBlock[] = []
  let pending:
    | {
        readonly start: number
        readonly markerSize: number
        ancestor: number | null
        separator: number | null
      }
    | undefined

  for (const [index, line] of lines.entries()) {
    const found = parseConflictMarker(line)
    if (found === null) continue

    if (found.kind === "start") {
      if (pending !== undefined) return { kind: "malformed", message: `Nested conflict marker at line ${index + 1}` }
      pending = { start: index, markerSize: found.size, ancestor: null, separator: null }
      continue
    }
    if (pending === undefined) {
      // Marker-shaped ordinary content outside a conflict is left alone.
      continue
    }
    if (found.size !== pending.markerSize) {
      return { kind: "malformed", message: `Mismatched conflict marker size at line ${index + 1}` }
    }

    if (found.kind === "ancestor") {
      if (pending.ancestor !== null || pending.separator !== null) {
        return { kind: "malformed", message: `Unexpected ancestor marker at line ${index + 1}` }
      }
      pending.ancestor = index
      continue
    }
    if (found.kind === "separator") {
      if (pending.separator !== null) {
        return { kind: "malformed", message: `Repeated conflict separator at line ${index + 1}` }
      }
      pending.separator = index
      continue
    }
    if (pending.separator === null) {
      return { kind: "malformed", message: `Conflict ending before its separator at line ${index + 1}` }
    }
    conflicts.push({
      start: pending.start,
      ancestor: pending.ancestor,
      separator: pending.separator,
      end: index,
      markerSize: pending.markerSize,
    })
    pending = undefined
  }

  if (pending !== undefined)
    return { kind: "malformed", message: `Unclosed conflict beginning at line ${pending.start + 1}` }
  return { kind: "ready", lines, conflicts }
}

export function availableSides(block: ConflictBlock): readonly ConflictSideChoice[] {
  return block.ancestor === null ? ["current", "incoming"] : ["current", "ancestor", "incoming"]
}

function normalizeSide(side: ConflictSideChoice, block: ConflictBlock): ConflictSideChoice {
  return side === "ancestor" && block.ancestor === null ? "incoming" : side
}

export function createConflictSession(
  content: string,
  preferred: ConflictSideChoice = "current",
): ConflictSession | null {
  const parsed = parseConflicts(content)
  if (parsed.kind === "malformed" || parsed.conflicts.length === 0) return null
  const first = parsed.conflicts[0]
  if (first === undefined) return null
  return {
    content,
    lines: parsed.lines,
    conflicts: parsed.conflicts,
    conflictIndex: 0,
    side: normalizeSide(preferred, first),
    undo: [],
  }
}

/** Refresh an open conflict without losing navigation or valid in-memory undo history. */
export function replaceConflictSession(previous: ConflictSession, content: string): ConflictSession | null {
  if (content === previous.content) return previous
  const next = createConflictSession(content, previous.side)
  if (next === null) return null
  const conflictIndex = Math.min(previous.conflictIndex, next.conflicts.length - 1)
  const block = next.conflicts[conflictIndex]
  return block === undefined
    ? null
    : {
        ...next,
        conflictIndex,
        side: normalizeSide(previous.side, block),
      }
}

export function moveConflict(session: ConflictSession, offset: number): ConflictSession {
  const conflictIndex = Math.min(Math.max(session.conflictIndex + offset, 0), session.conflicts.length - 1)
  const block = session.conflicts[conflictIndex]
  return block === undefined ? session : { ...session, conflictIndex, side: normalizeSide(session.side, block) }
}

export function moveSide(session: ConflictSession, offset: number): ConflictSession {
  const block = session.conflicts[session.conflictIndex]
  if (block === undefined) return session
  const sides = availableSides(block)
  const current = Math.max(0, sides.indexOf(normalizeSide(session.side, block)))
  const side = sides[Math.min(Math.max(current + offset, 0), sides.length - 1)]
  return side === undefined ? session : { ...session, side }
}

export function sideRange(block: ConflictBlock, side: ConflictSideChoice): readonly [start: number, end: number] {
  if (side === "current") return [block.start + 1, block.ancestor ?? block.separator]
  if (side === "ancestor") return [block.ancestor === null ? block.separator + 1 : block.ancestor + 1, block.separator]
  return [block.separator + 1, block.end]
}

function replacement(session: ConflictSession, block: ConflictBlock, choice: ConflictChoice): readonly string[] {
  const take = (side: ConflictSideChoice): readonly string[] => {
    const [start, end] = sideRange(block, side)
    return session.lines.slice(start, end)
  }
  return choice === "both" ? [...take("current"), ...take("incoming")] : take(choice)
}

export function chooseConflict(session: ConflictSession, choice: ConflictChoice): ConflictResolution {
  const block = session.conflicts[session.conflictIndex]
  if (block === undefined) return { content: session.content, session }
  const content = [
    ...session.lines.slice(0, block.start),
    ...replacement(session, block, choice),
    ...session.lines.slice(block.end + 1),
  ].join("")
  const parsed = parseConflicts(content)
  if (parsed.kind === "malformed") return { content: session.content, session }
  if (parsed.conflicts.length === 0) return { content, session: null }
  const conflictIndex = Math.min(session.conflictIndex, parsed.conflicts.length - 1)
  const next = parsed.conflicts[conflictIndex]
  if (next === undefined) return { content, session: null }
  return {
    content,
    session: {
      content,
      lines: parsed.lines,
      conflicts: parsed.conflicts,
      conflictIndex,
      side: normalizeSide(session.side, next),
      undo: [...session.undo, session.content],
    },
  }
}

export function undoConflict(session: ConflictSession): ConflictSession {
  const content = session.undo.at(-1)
  if (content === undefined) return session
  const parsed = parseConflicts(content)
  if (parsed.kind === "malformed" || parsed.conflicts.length === 0) return session
  const conflictIndex = Math.min(session.conflictIndex, parsed.conflicts.length - 1)
  const block = parsed.conflicts[conflictIndex]
  if (block === undefined) return session
  return {
    content,
    lines: parsed.lines,
    conflicts: parsed.conflicts,
    conflictIndex,
    side: normalizeSide(session.side, block),
    undo: session.undo.slice(0, -1),
  }
}

export function lineRole(block: ConflictBlock, index: number): "marker" | "current" | "ancestor" | "incoming" | null {
  if (index === block.start || index === block.ancestor || index === block.separator || index === block.end)
    return "marker"
  const current = sideRange(block, "current")
  if (index >= current[0] && index < current[1]) return "current"
  if (block.ancestor !== null) {
    const ancestor = sideRange(block, "ancestor")
    if (index >= ancestor[0] && index < ancestor[1]) return "ancestor"
  }
  const incoming = sideRange(block, "incoming")
  return index >= incoming[0] && index < incoming[1] ? "incoming" : null
}
