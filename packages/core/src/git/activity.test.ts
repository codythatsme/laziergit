import { expect, it } from "bun:test"

import { GitActivityStore, labelFor } from "./activity"

/** Longer than the store's 120ms reveal delay, with room for a slow machine. */
const pastReveal = 200

function createStore(): { store: GitActivityStore; errors: unknown[] } {
  const errors: unknown[] = []
  return { store: new GitActivityStore((error) => errors.push(error)), errors }
}

it("says nothing about an operation that finishes before it was worth mentioning", async () => {
  const { store } = createStore()
  const before = store.getSnapshot()
  let notified = 0
  store.subscribe(() => {
    notified += 1
  })

  // The case that made the delay necessary: the diff Pane stages a hunk per keypress, and a
  // spinner appearing for one frame per keystroke reads as a fault.
  store.begin("staging")()

  await Bun.sleep(pastReveal)
  expect(store.getSnapshot()).toEqual([])
  expect(notified).toBe(0)
  // Identity too: `useSyncExternalStore` re-reads the snapshot every render and treats a fresh
  // array as a change.
  expect(store.getSnapshot()).toBe(before)
})

it("publishes an operation that outlives the delay, and withdraws it when it settles", async () => {
  const { store } = createStore()
  const seen: (readonly { label: string }[])[] = []
  store.subscribe(() => seen.push(store.getSnapshot()))

  const end = store.begin("pushing")
  expect(store.getSnapshot()).toEqual([])

  await Bun.sleep(pastReveal)
  expect(store.getSnapshot()).toEqual([{ id: 1, label: "pushing" }])

  end()
  expect(store.getSnapshot()).toEqual([])
  expect(seen.map((snapshot) => snapshot.map((entry) => entry.label))).toEqual([["pushing"], []])
})

it("orders overlapping operations oldest first, so the newest is the one a single line names", async () => {
  const { store } = createStore()
  const endFetch = store.begin("fetching")
  const endCommit = store.begin("committing")

  await Bun.sleep(pastReveal)
  expect(store.getSnapshot().map((entry) => entry.label)).toEqual(["fetching", "committing"])
  expect(store.getSnapshot().at(-1)?.label).toBe("committing")

  endCommit()
  expect(store.getSnapshot().map((entry) => entry.label)).toEqual(["fetching"])
  endFetch()
  expect(store.getSnapshot()).toEqual([])
})

it("ignores a second call to the same finisher, so a bail-out path may also call it", async () => {
  const { store } = createStore()
  const endFirst = store.begin("pulling")
  await Bun.sleep(pastReveal)
  const endSecond = store.begin("fetching")
  await Bun.sleep(pastReveal)

  endFirst()
  endFirst()
  endFirst()

  expect(store.getSnapshot().map((entry) => entry.label)).toEqual(["fetching"])
  endSecond()
  expect(store.getSnapshot()).toEqual([])
})

it("keeps one listener's throw from starving the rest", async () => {
  const { store, errors } = createStore()
  let reached = false
  store.subscribe(() => {
    throw new Error("listener exploded")
  })
  store.subscribe(() => {
    reached = true
  })

  store.begin("merging")
  await Bun.sleep(pastReveal)

  expect(reached).toBe(true)
  expect(errors).toHaveLength(1)
})

it("drops everything in flight on shutdown, so no reveal outlives the renderer", async () => {
  const { store } = createStore()
  store.begin("pushing")
  await Bun.sleep(pastReveal)
  expect(store.getSnapshot()).toHaveLength(1)

  store.clear()
  expect(store.getSnapshot()).toEqual([])
})

// ---- labels --------------------------------------------------------------------------

/**
 * The argv each case names is the argv the service actually builds, so a helper that changes
 * its flags is caught here rather than by someone noticing the wrong word on the status line.
 */
it("names an operation after what it does, not after its subcommand", () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [["push", "main:main"], "pushing"],
    [["push", "--force-with-lease", "origin", "main:main"], "force-pushing"],
    [["push", "--set-upstream", "origin", "topic"], "pushing"],
    [["push", "--delete", "--", "origin", "topic"], "deleting remote branch"],
    [["pull"], "pulling"],
    [["pull", "--rebase"], "pulling (rebase)"],
    [["fetch", "--all"], "fetching"],
    [["fetch", "--prune", "--all"], "fetching (prune)"],
    [["commit", "--message", "x"], "committing"],
    [["commit", "--amend", "--message", "x"], "amending"],
    [["checkout", "main", "--"], "checking out"],
    [["checkout", "-b", "topic"], "creating branch"],
    [["branch", "--", "topic"], "creating branch"],
    [["branch", "-D", "--", "topic"], "deleting branch"],
    [["branch", "--set-upstream-to", "origin/main", "--", "topic"], "setting upstream"],
    [["add", "--all", "--"], "staging"],
    // The unstage path builds exactly this; a reset naming a mode is moving HEAD instead.
    [["reset", "--quiet", "--", "."], "unstaging"],
    [["reset", "--hard", "abc1234"], "resetting"],
    [["restore", "--worktree", "--", "a.txt"], "discarding"],
    [["clean", "-ffd", "--", "b.txt"], "discarding"],
    [["stash", "push", "--include-untracked"], "stashing"],
    [["stash", "apply", "stash@{0}"], "applying stash"],
    [["stash", "pop", "stash@{1}"], "popping stash"],
    [["stash", "drop", "stash@{2}"], "dropping stash"],
    [["merge", "--ff-only", "origin/main"], "merging"],
    [["revert", "--no-edit", "abc1234"], "reverting"],
    // Anything the table has never heard of still gets an honest word rather than "working".
    [["bisect", "start"], "running git bisect"],
  ]

  for (const [args, expected] of cases) {
    const subcommand = args[0]
    if (subcommand === undefined) throw new Error("every case names a subcommand")
    expect([args, labelFor(args, subcommand)]).toEqual([args, expected])
  }
})
