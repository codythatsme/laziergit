import type { FileChange } from "./types"

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
