import type { FileChange } from "./types"

/**
 * The four questions {@link WorkingTreeStatus}'s old four arrays answered, as predicates
 * over the one list that replaced them (ADR-0005).
 *
 * They are functions rather than arrays or getters for a reason that is easy to miss: the
 * store publishes `status` by structural comparison and keeps unchanged parts referentially
 * stable, so a derived *array* hanging off the status object would be rebuilt on every
 * snapshot and would defeat the very identity the store works to preserve. A predicate
 * costs nothing to keep stable because there is nothing to keep.
 *
 * **Memoise where you filter.** These compose into `useGit` selectors the wrong way round:
 *
 * ```ts
 * // Never — a fresh array every snapshot, so `Object.is` never holds and the Pane spins.
 * const staged = useGit((state) => state.status.files.filter(isStaged));
 *
 * // Instead — select the slice, derive from it.
 * const files = useGit((state) => state.status.files);
 * const staged = useMemo(() => files.filter(isStaged), [files]);
 * ```
 *
 * Counts are safe inline (`useGit((s) => s.status.files.filter(isStaged).length)`) because
 * a number compares by value.
 */

/** Something is in the index that HEAD does not have. */
export function isStaged(change: FileChange): boolean {
  return change.kind === "changed" && change.index !== null
}

/**
 * The working tree differs from the index, for a file git already tracks.
 *
 * Untracked is deliberately excluded: it is a different question with a different answer
 * for every write path — `git restore` refuses a path it has never seen — and folding the
 * two together is what would make a caller reach for the wrong git command.
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
 * Deliberately absent: `isTracked`.
 *
 * `git rm --cached` on a file still on disk produces `{ index: "deleted", worktree:
 * "untracked" }` — one entry that is *both* staged and untracked, because the index really
 * is dropping a path the working tree really does still hold. Any single tracked/untracked
 * boolean has to pick one of those to lie about. A caller who wants "tracked" should spell
 * the disjunction it actually means, at which point the awkward case is visible rather than
 * decided for it.
 */
