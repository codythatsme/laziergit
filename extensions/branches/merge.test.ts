import { describe, expect, it } from "bun:test"

import { mergeArgs, mergeChoices, squashCommitMessage } from "./merge"

describe("mergeChoices", () => {
  it("makes the ordinary merge a fast-forward when the selected branch is a descendant", () => {
    expect(mergeChoices(true)).toEqual([
      { key: "m", label: "Regular merge (fast-forward)", mode: "fast-forward" },
      { key: "n", label: "Regular merge (with merge commit)", mode: "merge-commit" },
      { key: "s", label: "Squash merge and leave uncommitted", mode: "squash" },
      { key: "shift+s", label: "Squash merge and commit", mode: "squash-commit" },
    ])
  })

  it("does not offer a fast-forward that git cannot perform", () => {
    expect(mergeChoices(false).map((choice) => choice.mode)).toEqual(["merge-commit", "squash", "squash-commit"])
  })
})

describe("mergeArgs", () => {
  it("pins each menu choice to the behavior its label promises", () => {
    expect(mergeArgs("topic", "fast-forward")).toEqual(["merge", "--ff-only", "--", "topic"])
    expect(mergeArgs("topic", "merge-commit")).toEqual(["merge", "--no-ff", "--no-edit", "--", "topic"])
    expect(mergeArgs("topic", "squash")).toEqual(["merge", "--squash", "--", "topic"])
    expect(mergeArgs("topic", "squash-commit")).toEqual(["merge", "--squash", "--", "topic"])
  })

  it("ends options before the branch name", () => {
    expect(mergeArgs("-topic", "fast-forward")).toEqual(["merge", "--ff-only", "--", "-topic"])
  })
})

it("names a committed squash from both ends of the operation", () => {
  expect(squashCommitMessage("feature/widget", "main")).toBe("Squash merge feature/widget into main")
})
