import type { FileChange } from "./types"

/**
 * Predicates over {@link WorkingTreeStatus.files} — one entry per path (ADR-0005).
 *
 * **Memoise where you filter**, or the Pane spins:
 *
 * ```ts
 * // Never — a fresh array every snapshot, so `Object.is` never holds.
 * const staged = useGit((state) => state.status.files.filter(isStaged));
 *
 * // Instead — select the slice, derive from it.
 * const files = useGit((state) => state.status.files);
 * const staged = useMemo(() => files.filter(isStaged), [files]);
 * ```
 *
 * Counts are safe inline, because a number compares by value.
 */

/** Something is in the index that HEAD does not have. */
export function isStaged(change: FileChange): boolean {
  return change.kind === "changed" && change.index !== null
}

/**
 * The working tree differs from the index, for a file git already tracks. Untracked is
 * excluded: every write path answers it differently — `git restore` refuses a path it has
 * never seen.
 */
export function isUnstaged(change: FileChange): boolean {
  return change.kind === "changed" && change.worktree !== null && change.worktree !== "untracked"
}

/** Git has never been told about this path. */
export function isUntracked(change: FileChange): boolean {
  return change.kind === "changed" && change.worktree === "untracked"
}

/** An unmerged path: the merge left both sides recorded and neither chosen. */
export function isConflicted(change: FileChange): boolean {
  return change.kind === "conflicted"
}

/*
 * Deliberately absent: `isTracked`. `git rm --cached` on a file still on disk produces
 * `{ index: "deleted", worktree: "untracked" }` — one entry that is both staged and
 * untracked — so any single tracked/untracked boolean has to lie about one of them.
 */
