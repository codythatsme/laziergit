import { describe, expect, it } from "bun:test"

import { renderCommitGraph, type CommitGraphRow } from "./graph"

interface TestCommit {
  readonly oid: string
  readonly parents: readonly string[]
  readonly author: { readonly name: string; readonly email: string }
}

function commit(oid: string, parents: readonly string[], author = oid): TestCommit {
  return { oid, parents, author: { name: author, email: `${author}@example.com` } }
}

function text(row: CommitGraphRow): string {
  return row.map((span) => span.text).join("")
}

function graph(commits: readonly TestCommit[]): readonly string[] {
  return renderCommitGraph(commits).map((row) => text(row).trimEnd())
}

describe("commit graph topology", () => {
  it("renders a linear history as one lane with a node per commit", () => {
    const rows = renderCommitGraph([commit("1", ["2"]), commit("2", ["3"]), commit("3", [])])

    expect(rows.map(text)).toEqual(["○ ", "○ ", "○ "])
  })

  it("opens and closes merge lanes", () => {
    expect(
      graph([
        commit("1", ["2"]),
        commit("2", ["3"]),
        commit("3", ["4"]),
        commit("4", ["5", "7"]),
        commit("7", ["5"]),
        commit("5", ["8"]),
        commit("8", ["9"]),
        commit("9", ["A", "B"]),
        commit("B", ["D"]),
        commit("D", ["A"]),
        commit("A", ["E"]),
        commit("E", ["F"]),
        commit("F", ["G"]),
        commit("G", []),
      ]),
    ).toEqual(["○", "○", "○", "◎─╮", "│ ○", "○─╯", "○", "◎─╮", "│ ○", "│ ○", "○─╯", "○", "○", "○"])
  })

  it("moves lanes left when a merge frees space", () => {
    expect(
      graph([
        commit("1", ["2"]),
        commit("2", ["3", "4"]),
        commit("4", ["3", "5"]),
        commit("3", ["5"]),
        commit("5", ["6"]),
        commit("6", []),
      ]),
    ).toEqual(["○", "◎─╮", "│ ◎─╮", "○─╯ │", "○───╯", "○"])
  })

  it("keeps unrelated history in a separate lane", () => {
    expect(
      graph([
        commit("1", ["2"]),
        commit("2", ["3", "4"]),
        commit("4", ["3", "5"]),
        commit("Z", ["Y"]),
        commit("3", ["5"]),
        commit("5", ["6"]),
        commit("6", []),
      ]),
    ).toEqual(["○", "◎─╮", "│ ◎─╮", "│ │ │ ○", "○─╯ │ │", "○───╯ │", "○ ╭───╯"])
  })

  it("renders crossings for several simultaneous merge paths", () => {
    expect(
      graph([
        commit("1", ["2"]),
        commit("2", ["3", "4"]),
        commit("3", ["5", "4"]),
        commit("5", ["7", "8"]),
        commit("7", ["4", "A"]),
        commit("4", ["B"]),
        commit("B", ["C"]),
        commit("C", []),
      ]),
    ).toEqual(["○", "◎─╮", "◎─│─╮", "◎─│─│─╮", "◎─│─│─│─╮", "○─┴─╯ │ │", "○ ╭───╯ │", "○ │ ╭───╯"])
  })
})

it("highlights every visible pipe sourced from the selected merge", () => {
  const commits = [commit("merge", ["main", "topic"], "Ada"), commit("topic", ["main"], "Grace"), commit("main", [])]
  const ordinary = renderCommitGraph(commits)
  const selected = renderCommitGraph(commits, "merge")

  expect(ordinary[0]?.some((span) => span.tone !== "highlight")).toBeTrue()
  expect(selected[0]?.every((span) => span.tone === "highlight")).toBeTrue()
  expect(selected[1]?.some((span) => span.tone === "highlight")).toBeTrue()
})
