import { expect, it } from "bun:test"
import type { Branch, GitState, RemoteBranch } from "laziergit"

import { emptyGitState, gitStateSlices, reconcileGitState } from "./state"

function branch(name: string, oid: string): Branch {
  return { name, oid, isHead: false, upstream: null, lastCommit: { oid, subject: "s", authoredAt: 1 } }
}

function remoteBranch(name: string, oid: string): RemoteBranch {
  return { name, remote: "origin", oid }
}

const upstream = { remote: "origin", branch: "main", gone: false, ahead: 1, behind: 0 }

function stateWith(overrides: Partial<GitState>): GitState {
  return { ...emptyGitState, ...overrides }
}

it("names every slice, so the derived event vocabulary cannot miss one", () => {
  expect([...gitStateSlices].sort().join(",")).toBe(Object.keys(emptyGitState).sort().join(","))
})

it("returns the previous snapshot itself when nothing changed", () => {
  const previous = stateWith({ branches: [branch("main", "a")] })
  const reconciled = reconcileGitState(previous, stateWith({ branches: [branch("main", "a")] }))

  // Identity all the way up means `git.refreshed` fires but no slice event does.
  expect(reconciled).toBe(previous)
})

it("keeps unchanged slices — and unchanged rows inside a changed slice — referentially stable", () => {
  const previous = stateWith({
    branches: [branch("main", "a"), branch("feature", "b")],
    tags: [{ name: "v1", oid: "a" }],
  })
  const reconciled = reconcileGitState(
    previous,
    stateWith({
      branches: [branch("main", "a"), branch("feature", "CHANGED")],
      tags: [{ name: "v1", oid: "a" }],
    }),
  )

  expect(reconciled).not.toBe(previous)
  // The untouched slice is what makes a `useGit((s) => s.tags)` pane skip the re-render.
  expect(reconciled.tags).toBe(previous.tags)
  expect(reconciled.branches).not.toBe(previous.branches)
  // Per-row identity is what lets a list pane memoize the rows that did not move.
  expect(reconciled.branches[0]).toBe(previous.branches[0])
  expect(reconciled.branches[1]).not.toBe(previous.branches[1])
})

it("keeps unchanged remote branch rows stable while one remote ref moves", () => {
  const previous = stateWith({
    remoteBranches: [remoteBranch("main", "a"), remoteBranch("feature", "b")],
  })
  const reconciled = reconcileGitState(
    previous,
    stateWith({
      remoteBranches: [remoteBranch("main", "a"), remoteBranch("feature", "CHANGED")],
    }),
  )

  expect(reconciled.remoteBranches).not.toBe(previous.remoteBranches)
  expect(reconciled.remoteBranches[0]).toBe(previous.remoteBranches[0])
  expect(reconciled.remoteBranches[1]).not.toBe(previous.remoteBranches[1])
})

it("keeps every unchanged file in the working tree status stable", () => {
  const a = { kind: "changed" as const, path: "a.txt", previousPath: null, index: "added" as const, worktree: null }
  const previous = stateWith({ status: { files: [a], isClean: false } })
  const reconciled = reconcileGitState(
    previous,
    stateWith({
      status: {
        files: [
          { kind: "changed", path: "a.txt", previousPath: null, index: "added", worktree: null },
          { kind: "changed", path: "b.txt", previousPath: null, index: null, worktree: "modified" },
        ],
        isClean: false,
      },
    }),
  )

  expect(reconciled.status).not.toBe(previous.status)
  // Per-entry identity is what a row memoizes on, and what the decoration cache keys its
  // slots by.
  expect(reconciled.status.files[0]).toBe(previous.status.files[0])
})

it("keeps a file's identity when only its other side changes", () => {
  const previous = stateWith({
    status: {
      files: [
        { kind: "changed", path: "a.txt", previousPath: null, index: null, worktree: "modified" },
        { kind: "changed", path: "b.txt", previousPath: null, index: null, worktree: "modified" },
      ],
      isClean: false,
    },
  })
  const reconciled = reconcileGitState(
    previous,
    stateWith({
      status: {
        files: [
          { kind: "changed", path: "a.txt", previousPath: null, index: "modified", worktree: null },
          { kind: "changed", path: "b.txt", previousPath: null, index: null, worktree: "modified" },
        ],
        isClean: false,
      },
    }),
  )

  expect(reconciled.status.files[0]).not.toBe(previous.status.files[0])
  expect(reconciled.status.files[1]).toBe(previous.status.files[1])
})

it("never reuses a reference for a value that actually differs", () => {
  const previous = stateWith({ head: { kind: "onBranch", oid: "a", branch: "main", upstream: null } })
  const reconciled = reconcileGitState(
    previous,
    stateWith({ head: { kind: "onBranch", oid: "a", branch: "main", upstream } }),
  )

  expect(reconciled.head).not.toBe(previous.head)
  expect(reconciled.head).toEqual({ kind: "onBranch", oid: "a", branch: "main", upstream })
})

it("publishes a shorter list as a change rather than reusing the longer one", () => {
  const previous = stateWith({ commits: [] })
  const withOne = reconcileGitState(
    previous,
    stateWith({
      commits: [
        { oid: "a", shortOid: "a", subject: "s", author: { name: "n", email: "e" }, authoredAt: 1, parents: [] },
      ],
    }),
  )
  const backToNone = reconcileGitState(withOne, stateWith({ commits: [] }))

  expect(withOne.commits).toHaveLength(1)
  expect(backToNone.commits).toHaveLength(0)
  expect(backToNone.commits).not.toBe(withOne.commits)
})
