import { expect, it } from "bun:test"
import type { Branch, GitState } from "laziergit"

import { emptyGitState, gitStateSlices, reconcileGitState } from "./state"

function branch(name: string, oid: string): Branch {
  return { name, oid, isHead: false, upstream: null, lastCommit: { oid, subject: "s", authoredAt: 1 } }
}

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

it("keeps the untouched halves of the working tree status stable", () => {
  const staged = [{ path: "a.txt", previousPath: null, kind: "added" as const }]
  const previous = stateWith({ status: { ...emptyGitState.status, staged, isClean: false } })
  const reconciled = reconcileGitState(
    previous,
    stateWith({
      status: {
        ...emptyGitState.status,
        staged: [{ path: "a.txt", previousPath: null, kind: "added" }],
        unstaged: [{ path: "b.txt", previousPath: null, kind: "modified" }],
        isClean: false,
      },
    }),
  )

  expect(reconciled.status).not.toBe(previous.status)
  expect(reconciled.status.staged).toBe(previous.status.staged)
})

it("never reuses a reference for a value that actually differs", () => {
  const previous = stateWith({ head: { oid: "a", branch: "main", detached: false, upstream: null } })
  const reconciled = reconcileGitState(
    previous,
    stateWith({
      head: {
        oid: "a",
        branch: "main",
        detached: false,
        upstream: { remote: "origin", branch: "main", ahead: 1, behind: 0 },
      },
    }),
  )

  expect(reconciled.head).not.toBe(previous.head)
  expect(reconciled.head.upstream).toEqual({ remote: "origin", branch: "main", ahead: 1, behind: 0 })
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
