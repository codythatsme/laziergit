import type { GitState, WorkingTreeStatus } from "laziergit"

const noFiles = Object.freeze([])

/**
 * What the store reads before its first refresh, and what it keeps serving when there is
 * no repository to read. Frozen down to the leaves so the very first publish already has
 * the stable slice identities every later reconcile compares against.
 *
 * `head` is `noRepository`, the one variant that asserts nothing at all — every other one
 * would have to invent something git never said: an oid, a branch name, or both. It is also
 * what the store keeps serving outside a repository, so a Pane reads the same answer at
 * startup and after a failed open rather than distinguishing "not read yet" from "nothing
 * to read".
 */
export const emptyGitState: GitState = Object.freeze({
  head: Object.freeze({ kind: "noRepository" }),
  branches: Object.freeze([]),
  remotes: Object.freeze([]),
  tags: Object.freeze([]),
  status: Object.freeze({ files: noFiles, isClean: true }),
  commits: Object.freeze([]),
  stash: Object.freeze([]),
})

/**
 * The mapped type is the point: adding a slice to {@link GitState} without naming it here
 * is a compile error, so the derived `git.<slice>.changed` event vocabulary cannot drift
 * from the store shape.
 */
const sliceNames: { readonly [K in keyof GitState]: K } = {
  head: "head",
  branches: "branches",
  remotes: "remotes",
  tags: "tags",
  status: "status",
  commits: "commits",
  stash: "stash",
}

export const gitStateSlices: readonly (keyof GitState)[] = Object.freeze(Object.values(sliceNames))

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Structural equality over git data, which is plain JSON-shaped and acyclic by
 * construction — it was parsed out of git's own output.
 */
function deepEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEquals(value, right[index]))
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => Object.hasOwn(right, key) && deepEquals(left[key], right[key]))
  }

  return false
}

function reuseValue<T>(previous: T, next: T): T {
  return deepEquals(previous, next) ? previous : next
}

/**
 * Keeps every element that did not change referentially stable, and the array itself when
 * none did. Per-element reuse is what lets a pane memoize a row: one edited file leaves
 * every other `FileChange` `Object.is`-identical.
 */
function reuseList<T>(previous: readonly T[], next: readonly T[]): readonly T[] {
  const merged = next.map((value, index) => {
    const before = previous[index]
    return before !== undefined && deepEquals(before, value) ? before : value
  })
  const unchanged =
    previous.length === merged.length && merged.every((value, index) => Object.is(value, previous[index]))
  return unchanged ? previous : Object.freeze(merged)
}

/**
 * One list to reconcile, and it holds identity better than the four it replaced: staging a
 * file used to move a fresh object from the unstaged array into the staged one, so both
 * arrays changed length and every row after it shifted. Now the entry keeps its slot in
 * path order with one field rewritten, and every neighbour stays `Object.is`-identical.
 */
function reuseStatus(previous: WorkingTreeStatus, next: WorkingTreeStatus): WorkingTreeStatus {
  const files = reuseList(previous.files, next.files)
  const unchanged = Object.is(files, previous.files) && previous.isClean === next.isClean
  return unchanged ? previous : Object.freeze({ files, isClean: next.isClean })
}

/**
 * Publishes `next` while keeping every unchanged part of `previous` referentially stable.
 *
 * This is what makes `useGit` selectors cheap: a refresh that only touched the working
 * tree leaves `state.branches` — and every `Branch` inside it — `Object.is`-identical, so
 * a pane selecting branches never re-renders, and `git.branches.changed` never fires.
 * Identity is only ever kept for values that are structurally equal, so a reused reference
 * can never be a stale one.
 */
export function reconcileGitState(previous: GitState, next: GitState): GitState {
  const head = reuseValue(previous.head, next.head)
  const branches = reuseList(previous.branches, next.branches)
  const remotes = reuseList(previous.remotes, next.remotes)
  const tags = reuseList(previous.tags, next.tags)
  const status = reuseStatus(previous.status, next.status)
  const commits = reuseList(previous.commits, next.commits)
  const stash = reuseList(previous.stash, next.stash)

  const unchanged =
    Object.is(head, previous.head) &&
    Object.is(branches, previous.branches) &&
    Object.is(remotes, previous.remotes) &&
    Object.is(tags, previous.tags) &&
    Object.is(status, previous.status) &&
    Object.is(commits, previous.commits) &&
    Object.is(stash, previous.stash)

  return unchanged ? previous : Object.freeze({ head, branches, remotes, tags, status, commits, stash })
}
