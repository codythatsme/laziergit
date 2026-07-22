import { expect, it } from "bun:test"

import { fuzzyFilter, fuzzyScore } from "./fuzzy"

function ranking(items: readonly string[], query: string): readonly string[] {
  return fuzzyFilter(items, query, (item) => item).map((result) => result.item)
}

it("keeps every item in its original order when the query is empty", () => {
  expect(ranking(["push", "stage", "stash"], "")).toEqual(["push", "stage", "stash"])
  expect(fuzzyScore("", "stage")).toBe(0)
})

it("rejects a query that is not a subsequence of the text", () => {
  expect(fuzzyScore("zq", "stage")).toBeNull()
  expect(fuzzyScore("gs", "stage")).toBeNull()
  expect(fuzzyScore("ss", "stage")).toBeNull()
  expect(fuzzyScore("ss", "stash")).not.toBeNull()
  expect(ranking(["stage", "commit"], "zq")).toEqual([])
})

it("matches without regard to case in either the query or the text", () => {
  expect(fuzzyScore("PUSH", "push")).not.toBeNull()
  expect(fuzzyScore("PUSH", "push")).toBe(fuzzyScore("push", "push"))
  expect(fuzzyScore("psh", "PUSH")).toBe(fuzzyScore("psh", "push"))
  expect(ranking(["Stage all", "Commit"], "SA")).toEqual(["Stage all"])
})

it("ranks a consecutive run above the same characters scattered through a word", () => {
  expect(ranking(["chrome", "commit"], "com")).toEqual(["commit", "chrome"])
})

it("ranks a prefix hit above the same character buried mid-word", () => {
  expect(ranking(["push", "stash"], "s")).toEqual(["stash", "push"])
})

it("ranks a hit at the start of the text above the same hit further in", () => {
  expect(ranking(["diff view", "view all"], "v")).toEqual(["view all", "diff view"])
})

it("ranks a tighter match above a looser one when nothing else separates them", () => {
  expect(ranking(["great", "gift"], "gt")).toEqual(["gift", "great"])
  expect(fuzzyScore("gt", "gift")).toBeGreaterThan(fuzzyScore("gt", "great") ?? 0)
})

it("ranks a word-boundary hit above one at the same offset mid-word", () => {
  expect(ranking(["archive", "diff view"], "v")).toEqual(["diff view", "archive"])
})

it("ignores spaces in the query so a typed phrase still matches one word", () => {
  expect(fuzzyScore("st", "stash")).not.toBeNull()
  expect(fuzzyScore("s t", "stash")).toBe(fuzzyScore("st", "stash"))
  expect(fuzzyScore("g c", "git commit")).toBe(fuzzyScore("gc", "git commit"))
  expect(ranking(["git commit", "git push"], "  commit  ")).toEqual(["git commit"])
})

it("preserves the original order between items that score the same", () => {
  expect(ranking(["push", "stage", "stash"], "s")).toEqual(["stage", "stash", "push"])
  expect(ranking(["push", "stash", "stage"], "s")).toEqual(["stash", "stage", "push"])
})

it("reports the index each match had in the original list, not in the filtered one", () => {
  const items = [{ label: "push" }, { label: "stage" }, { label: "stash" }]

  const results = fuzzyFilter(items, "st", (item) => item.label)

  expect(results.map((result) => result.item.label)).toEqual(["stage", "stash"])
  expect(results.map((result) => result.index)).toEqual([1, 2])
  expect(results.map((result) => items.at(result.index))).toEqual(results.map((result) => result.item))
})
