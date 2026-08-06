export type PatchLineKind = "header" | "hunkHeader" | "context" | "added" | "removed" | "metadata"
export type PatchSelectionMode = "line" | "hunk"

export interface PatchLine {
  readonly index: number
  readonly text: string
  readonly kind: PatchLineKind
  readonly hunk: number | null
  readonly stageable: boolean
}

export interface PatchHunk {
  readonly index: number
  readonly headerLine: number
  readonly startLine: number
  readonly endLine: number
  readonly oldStart: number
  readonly newStart: number
  readonly suffix: string
}

export interface ParsedPatchSelection {
  readonly source: string
  readonly lines: readonly PatchLine[]
  readonly hunks: readonly PatchHunk[]
}

export interface PatchSession {
  readonly patch: ParsedPatchSelection
  readonly cursor: number
  readonly mode: PatchSelectionMode
  readonly anchor: number | null
}

const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parsePatchSelection(source: string): ParsedPatchSelection | null {
  const rawLines = source.replace(/\n$/, "").split("\n")
  const lines: PatchLine[] = []
  const hunks: PatchHunk[] = []
  let hunk: {
    index: number
    headerLine: number
    startLine: number
    oldStart: number
    newStart: number
    suffix: string
  } | null = null

  const close = (endLine: number): void => {
    if (hunk === null) return
    hunks.push({ ...hunk, endLine })
    hunk = null
  }

  for (const [index, text] of rawLines.entries()) {
    const header = hunkPattern.exec(text)
    if (header !== null) {
      close(index)
      const oldStart = Number(header[1])
      const newStart = Number(header[3])
      if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)) return null
      hunk = {
        index: hunks.length,
        headerLine: index,
        startLine: index + 1,
        oldStart,
        newStart,
        suffix: header[5] ?? "",
      }
      lines.push({ index, text, kind: "hunkHeader", hunk: hunk.index, stageable: false })
      continue
    }

    if (hunk === null) {
      lines.push({ index, text, kind: "header", hunk: null, stageable: false })
      continue
    }
    const kind: PatchLineKind = text.startsWith("+")
      ? "added"
      : text.startsWith("-")
        ? "removed"
        : text.startsWith("\\")
          ? "metadata"
          : "context"
    lines.push({
      index,
      text,
      kind,
      hunk: hunk.index,
      stageable: kind === "added" || kind === "removed",
    })
  }
  close(rawLines.length)
  return hunks.length === 0 ? null : { source, lines, hunks }
}

function stageableIndices(patch: ParsedPatchSelection): readonly number[] {
  return patch.lines.filter((line) => line.stageable).map((line) => line.index)
}

function nearestStageable(patch: ParsedPatchSelection, requested: number): number | null {
  const indices = stageableIndices(patch)
  if (indices.length === 0) return null
  return indices.reduce((best, candidate) =>
    Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best,
  )
}

export function createPatchSession(source: string, requestedCursor = 0): PatchSession | null {
  const patch = parsePatchSelection(source)
  if (patch === null) return null
  const cursor = nearestStageable(patch, requestedCursor)
  return cursor === null ? null : { patch, cursor, mode: "line", anchor: null }
}

export function replacePatch(session: PatchSession, source: string): PatchSession | null {
  const next = createPatchSession(source, session.cursor)
  return next === null ? null : { ...next, mode: session.mode }
}

export function movePatchCursor(session: PatchSession, offset: number): PatchSession {
  const indices = stageableIndices(session.patch)
  const at = Math.max(0, indices.indexOf(session.cursor))
  const cursor = indices[Math.min(Math.max(at + offset, 0), indices.length - 1)]
  return cursor === undefined ? session : { ...session, cursor }
}

export function movePatchHunk(session: PatchSession, offset: number): PatchSession {
  const line = session.patch.lines[session.cursor]
  if (line?.hunk === null || line?.hunk === undefined) return session
  const hunkIndex = Math.min(Math.max(line.hunk + offset, 0), session.patch.hunks.length - 1)
  const cursor = session.patch.lines.find((candidate) => candidate.hunk === hunkIndex && candidate.stageable)?.index
  return cursor === undefined ? session : { ...session, cursor }
}

export function togglePatchMode(session: PatchSession): PatchSession {
  return { ...session, mode: session.mode === "line" ? "hunk" : "line", anchor: null }
}

export function togglePatchRange(session: PatchSession): PatchSession {
  return { ...session, anchor: session.anchor === null ? session.cursor : null }
}

export function selectedPatchLines(session: PatchSession): ReadonlySet<number> {
  if (session.anchor !== null) {
    const start = Math.min(session.anchor, session.cursor)
    const end = Math.max(session.anchor, session.cursor)
    return new Set(
      session.patch.lines
        .filter((line) => line.stageable && line.index >= start && line.index <= end)
        .map((line) => line.index),
    )
  }
  if (session.mode === "line") return new Set([session.cursor])
  const hunk = session.patch.lines[session.cursor]?.hunk
  return new Set(session.patch.lines.filter((line) => line.stageable && line.hunk === hunk).map((line) => line.index))
}

function transformedLine(
  line: PatchLine,
  selected: ReadonlySet<number>,
  keepUnselectedAdditions: boolean,
): string | null {
  if (line.kind === "added")
    return selected.has(line.index) ? line.text : keepUnselectedAdditions ? ` ${line.text.slice(1)}` : null
  if (line.kind === "removed") return selected.has(line.index) ? line.text : ` ${line.text.slice(1)}`
  return line.text
}

export interface SelectPatchOptions {
  /** The patch will be applied in reverse (unstage/discard rather than stage). */
  readonly reverse?: boolean
}

function regularFileHeader(lines: readonly PatchLine[], kind: "new" | "deleted"): readonly string[] {
  const oldPath = lines.find((line) => line.text.startsWith("--- a/"))?.text.slice("--- a/".length)
  const newPath = lines.find((line) => line.text.startsWith("+++ b/"))?.text.slice("+++ b/".length)
  const path = oldPath ?? newPath
  if (path === undefined) return lines.map((line) => line.text)

  return lines.flatMap((line) => {
    if (line.text.startsWith("index ") || line.text.startsWith(`${kind} file mode `)) return []
    if (kind === "new" && line.text === "--- /dev/null") return [`--- a/${path}`]
    if (kind === "deleted" && line.text === "+++ /dev/null") return [`+++ b/${path}`]
    return [line.text]
  })
}

/** Build a valid patch containing only the selected added/removed lines. */
export function selectPatch(session: PatchSession, options: SelectPatchOptions = {}): string | null {
  const selected = selectedPatchLines(session)
  if (selected.size === 0) return null
  const output: string[] = []

  const firstHunk = session.patch.hunks[0]?.headerLine ?? session.patch.lines.length
  const header = session.patch.lines.slice(0, firstHunk)
  const complete = selected.size === stageableIndices(session.patch).length
  const newFile = header.some((line) => line.text.startsWith("new file mode ") || line.text === "--- /dev/null")
  const deletedFile = header.some((line) => line.text.startsWith("deleted file mode ") || line.text === "+++ /dev/null")
  const regularizeNew = options.reverse === true && !complete && newFile
  const regularizeDeleted = options.reverse !== true && !complete && deletedFile
  output.push(
    ...(regularizeNew
      ? regularFileHeader(header, "new")
      : regularizeDeleted
        ? regularFileHeader(header, "deleted")
        : header.map((line) => line.text)),
  )

  for (const hunk of session.patch.hunks) {
    const body = session.patch.lines.slice(hunk.startLine, hunk.endLine)
    if (!body.some((line) => line.stageable && selected.has(line.index))) continue

    const transformed: string[] = []
    let previousSurvived = false
    for (const line of body) {
      if (line.kind === "metadata") {
        // A no-final-newline marker belongs to the preceding patch line. Keep it only when
        // that line survived this selected patch.
        if (previousSurvived) transformed.push(line.text)
        continue
      }
      const value = transformedLine(line, selected, regularizeNew)
      previousSurvived = value !== null
      if (value !== null) transformed.push(value)
    }

    const oldCount = transformed.filter((line) => line.startsWith(" ") || line.startsWith("-")).length
    const newCount = transformed.filter((line) => line.startsWith(" ") || line.startsWith("+")).length
    const oldStart = regularizeNew && hunk.oldStart === 0 ? 1 : hunk.oldStart
    const newStart = regularizeDeleted && hunk.newStart === 0 ? 1 : hunk.newStart
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.suffix}`, ...transformed)
  }

  return output.length === firstHunk ? null : `${output.join("\n")}\n`
}
