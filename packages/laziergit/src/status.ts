import type { FileChange } from "./types"

export type ConflictMarkerKind = "start" | "ancestor" | "separator" | "end"

export interface ConflictMarker {
  readonly kind: ConflictMarkerKind
  readonly size: number
}

/** Predicates over {@link WorkingTreeStatus.files}; memoise any filter over them, since a fresh array every snapshot re-renders forever. */

/** Something is in the index that HEAD does not have. */
export function isStaged(change: FileChange): boolean {
  return change.kind === "changed" && change.index !== null
}

/** The working tree differs from the index, for a file git already tracks; untracked is excluded because `git restore` refuses a path it has never seen. */
export function isUnstaged(change: FileChange): boolean {
  return change.kind === "changed" && change.worktree !== null && change.worktree !== "untracked"
}

/** Git has never been told about this path. */
export function isUntracked(change: FileChange): boolean {
  return change.kind === "changed" && change.worktree === "untracked"
}

/** An unmerged path: the merge left both sides recorded and neither chosen. */
export function isConflicted(change: FileChange): change is Extract<FileChange, { kind: "conflicted" }> {
  return change.kind === "conflicted"
}

/** Classify one complete line using Git's marker grammar, preserving the marker width. */
export function parseConflictMarker(line: string): ConflictMarker | null {
  const withoutLf = line.endsWith("\n") ? line.slice(0, -1) : line
  const value = withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf
  const labelled = /^(<{7,}|\|{7,}|>{7,})(?: .*)?$/.exec(value)
  if (labelled?.[1] !== undefined) {
    const token = labelled[1]
    return {
      kind: token[0] === "<" ? "start" : token[0] === "|" ? "ancestor" : "end",
      size: token.length,
    }
  }
  const separator = /^(={7,})$/.exec(value)?.[1]
  return separator === undefined ? null : { kind: "separator", size: separator.length }
}

/** Whether text contains any Git conflict marker, including an unmatched or malformed one. */
export function containsConflictMarker(contents: string): boolean {
  return (contents.match(/[^\n]*\n|[^\n]+$/g) ?? []).some((line) => parseConflictMarker(line) !== null)
}
