import { describe, expect, it } from "bun:test"
import type { ChangeKind, FileChange, WorktreeChange } from "laziergit"

import { previewStage, previewUnstage } from "./optimistic"

function changed(
  path: string,
  index: ChangeKind | null,
  worktree: WorktreeChange | null,
  previousPath: string | null = null,
): FileChange {
  return { kind: "changed", path, previousPath, index, worktree }
}

describe("optimistic staging", () => {
  it("previews only status pairs whose result is unambiguous", () => {
    const conflict: FileChange = {
      kind: "conflicted",
      path: "conflict.txt",
      previousPath: null,
      ours: "modified",
      theirs: "modified",
    }
    const rename = changed("new.txt", "renamed", "modified", "old.txt")
    const files = [
      changed("untracked.txt", null, "untracked"),
      changed("modified.txt", null, "modified"),
      changed("partial.txt", "modified", "modified"),
      changed("deleted-after-stage.txt", "modified", "deleted"),
      conflict,
      rename,
    ]

    expect(previewStage(files, "all")).toEqual([
      changed("untracked.txt", "added", null),
      changed("modified.txt", "modified", null),
      changed("partial.txt", "modified", null),
      changed("deleted-after-stage.txt", "deleted", null),
      conflict,
      rename,
    ])
  })

  it("matches a directory path without matching a same-prefix neighbour", () => {
    const files = [changed("src/a.txt", null, "modified"), changed("src-old/b.txt", null, "modified")]

    expect(previewStage(files, ["src"])).toEqual([
      changed("src/a.txt", "modified", null),
      changed("src-old/b.txt", null, "modified"),
    ])
  })
})

describe("optimistic unstaging", () => {
  it("moves known index-only and partially-staged states back to the working tree", () => {
    const files = [
      changed("added.txt", "added", null),
      changed("modified.txt", "modified", null),
      changed("partial.txt", "modified", "modified"),
      changed("deleted.txt", "deleted", null),
    ]

    expect(previewUnstage(files, "all")).toEqual([
      changed("added.txt", null, "untracked"),
      changed("modified.txt", null, "modified"),
      changed("partial.txt", null, "modified"),
      changed("deleted.txt", null, "deleted"),
    ])
  })

  it("keeps the original array when no status can be safely previewed", () => {
    const files = [changed("new.txt", "renamed", null, "old.txt")]

    expect(previewUnstage(files, "all")).toBe(files)
  })
})
