import type { GitState, WorkingTreeStatus } from "laziergit"

import { noOperation } from "./operation"

const noFiles = Object.freeze([])

/**
 * What the store reads before its first refresh, and what it keeps serving when there is no
 * repository. Frozen down to the leaves, so the very first publish already has the stable
 * slice identities every later reconcile compares against.
 */
export const emptyGitState: GitState = Object.freeze({
  head: Object.freeze({ kind: "noRepository" }),
  operation: noOperation,
  branches: Object.freeze([]),
  remoteBranches: Object.freeze([]),
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
  operation: "operation",
  branches: "branches",
  remoteBranches: "remoteBranches",
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
 * One list to reconcile: an entry keeps its slot in path order with one field rewritten, so
 * staging a file leaves every neighbour `Object.is`-identical.
 */
function reuseStatus(previous: WorkingTreeStatus, next: WorkingTreeStatus): WorkingTreeStatus {
  const files = reuseList(previous.files, next.files)
  const unchanged = Object.is(files, previous.files) && previous.isClean === next.isClean
  return unchanged ? previous : Object.freeze({ files, isClean: next.isClean })
}

/**
 * Publishes `next` while keeping every unchanged part of `previous` referentially stable, which
 * is what makes `useGit` selectors cheap: a refresh that only touched the working tree leaves
 * `state.branches` identical, so a pane selecting branches never re-renders. Identity is only
 * kept for structurally equal values, so a reused reference can never be a stale one.
 */
export function reconcileGitState(previous: GitState, next: GitState): GitState {
  const head = reuseValue(previous.head, next.head)
  const operation = reuseValue(previous.operation, next.operation)
  const branches = reuseList(previous.branches, next.branches)
  const remoteBranches = reuseList(previous.remoteBranches, next.remoteBranches)
  const remotes = reuseList(previous.remotes, next.remotes)
  const tags = reuseList(previous.tags, next.tags)
  const status = reuseStatus(previous.status, next.status)
  const commits = reuseList(previous.commits, next.commits)
  const stash = reuseList(previous.stash, next.stash)

  const unchanged =
    Object.is(head, previous.head) &&
    Object.is(operation, previous.operation) &&
    Object.is(branches, previous.branches) &&
    Object.is(remoteBranches, previous.remoteBranches) &&
    Object.is(remotes, previous.remotes) &&
    Object.is(tags, previous.tags) &&
    Object.is(status, previous.status) &&
    Object.is(commits, previous.commits) &&
    Object.is(stash, previous.stash)

  return unchanged
    ? previous
    : Object.freeze({ head, operation, branches, remoteBranches, remotes, tags, status, commits, stash })
}
