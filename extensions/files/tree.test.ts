import { expect, it } from "bun:test"
import type { ChangeKind, FileChange } from "laziergit"

import {
  buildFlatList,
  buildTree,
  directoryPaths,
  fileLabel,
  filesUnder,
  isFolded,
  noFolds,
  rowIndexFor,
  visibleRows,
  type DirectoryNode,
  type FileNode,
  type TreeNode,
} from "./tree"

/** Git reports paths in order, so fixtures are written in it and never rely on the builder to sort input. */
function untracked(path: string): FileChange {
  return { kind: "changed", path, previousPath: null, index: null, worktree: "untracked" }
}

function staged(path: string, index: ChangeKind = "added"): FileChange {
  return { kind: "changed", path, previousPath: null, index, worktree: null }
}

function edited(path: string): FileChange {
  return { kind: "changed", path, previousPath: null, index: null, worktree: "modified" }
}

function conflicted(path: string): FileChange {
  return { kind: "conflicted", path, previousPath: null, ours: "modified", theirs: "modified" }
}

/** The rows a Pane would draw, as `depth:path` strings — the shape assertions read best in. */
function rows(nodes: readonly TreeNode[], fold = noFolds, threshold = 0): readonly string[] {
  return visibleRows(nodes, fold, threshold).map((row) => `${row.depth}:${row.node.path}`)
}

function directoryAt(nodes: readonly TreeNode[], path: string): DirectoryNode {
  for (const node of nodes) {
    if (node.path === path && node.kind === "directory") return node
    if (node.kind === "directory") {
      const found = directoryAt(node.children, path)
      if (found.path === path) return found
    }
  }
  return {
    kind: "directory",
    path: "",
    label: "",
    children: [],
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
    fileCount: 0,
  }
}

it("builds one node per path prefix, with a row for each directory above a file", () => {
  const tree = buildTree([untracked("src/a.txt"), untracked("src/nested/b.txt"), untracked("top.txt")])

  expect(rows(tree)).toEqual(["0:src", "1:src/a.txt", "1:src/nested", "2:src/nested/b.txt", "0:top.txt"])
})

it("orders siblings by full path, so a directory sorts against files by its own name", () => {
  // `.` (0x2E) sorts before `/` (0x2F), so comparing full paths puts the directory `b`
  // before the file `b.txt`. Comparing labels would not, and `b`'s rows would be split
  // across `b.txt`.
  const tree = buildTree([edited("b/x.txt"), untracked("b.txt"), untracked("a.txt")])

  expect(rows(tree)).toEqual(["0:a.txt", "0:b", "1:b/x.txt", "0:b.txt"])
})

it("compresses a single-child directory chain into one row", () => {
  const tree = buildTree([untracked("a/b/c.txt")])

  expect(rows(tree)).toEqual(["0:a/b", "1:a/b/c.txt"])
  expect((tree[0] as DirectoryNode).label).toBe("a/b")
})

it("stops compressing when the single child is a file", () => {
  // Otherwise `extensions/diff/index.tsx` would fold a file's whole path into a directory
  // row, and there would be nothing left to expand.
  const tree = buildTree([edited("extensions/diff/index.tsx")])

  expect(rows(tree)).toEqual(["0:extensions/diff", "1:extensions/diff/index.tsx"])
})

it("keeps the top-level directory row when the whole status sits under one directory", () => {
  // The root must never be compressed: it has a single child here, and collapsing it would
  // return that child's children and lose the `src` row entirely.
  const tree = buildTree([untracked("src/a.txt"), untracked("src/b.txt")])

  expect(rows(tree)).toEqual(["0:src", "1:src/a.txt", "1:src/b.txt"])
})

it("reads a nested repository's trailing slash as a file row, and keeps git's own path", () => {
  // Under `--untracked-files=all` git reports a nested repository as one record ending in a
  // slash. Splitting it without dropping the empty segment builds a nameless child.
  const tree = buildTree([untracked("vendor/nested/")])

  expect(rows(tree)).toEqual(["0:vendor", "1:vendor/nested"])
  const leaf = (tree[0] as DirectoryNode).children[0] as FileNode
  expect(leaf.label).toBe("nested/")
  // Every write hands git back what git said, not the normalised node path.
  expect(leaf.change.path).toBe("vendor/nested/")
})

it("rolls each directory's state up from its descendants", () => {
  const tree = buildTree([
    staged("packages/a.ts"),
    conflicted("packages/core/parse.ts"),
    untracked("scratch/log.txt"),
    edited("src/app.ts"),
    staged("src/new.ts"),
  ])

  expect(directoryAt(tree, "packages").conflicted).toBe(true)
  expect(directoryAt(tree, "packages").staged).toBe(true)
  expect(directoryAt(tree, "packages").fileCount).toBe(2)
  expect(directoryAt(tree, "scratch").untracked).toBe(true)
  expect(directoryAt(tree, "scratch").conflicted).toBe(false)
  // Partially staged: one file staged, one only edited.
  expect(directoryAt(tree, "src").staged).toBe(true)
  expect(directoryAt(tree, "src").unstaged).toBe(true)
})

it("hides the descendants of a collapsed directory, chain and all", () => {
  const tree = buildTree([untracked("a/b/c.txt"), untracked("a/b/d.txt"), untracked("top.txt")])
  const folded = { collapsed: new Set(["a/b"]), expanded: new Set<string>() }

  expect(rows(tree, folded)).toEqual(["0:a/b", "0:top.txt"])
  // And renumbers contiguously from 0, because the cursor walks these by index.
  expect(visibleRows(tree, folded, 0).map((row) => row.index)).toEqual([0, 1])
})

it("folds a directory past the threshold, and lets an explicit expand outrank it", () => {
  const tree = buildTree([untracked("big/a.txt"), untracked("big/b.txt"), untracked("big/c.txt")])
  const big = tree[0] as DirectoryNode

  expect(isFolded(big, noFolds, 3)).toBe(true)
  expect(isFolded(big, noFolds, 4)).toBe(false)
  // 0 disables the automatic half entirely.
  expect(isFolded(big, noFolds, 0)).toBe(false)
  // The override the ~2s poll would otherwise undo on every refresh.
  expect(isFolded(big, { collapsed: new Set(), expanded: new Set(["big"]) }, 3)).toBe(false)
  expect(isFolded(big, { collapsed: new Set(["big"]), expanded: new Set() }, 99)).toBe(true)
})

it("lays the same files out flat, at depth 0 with full-path labels", () => {
  const tree = buildFlatList([untracked("src/nested/b.txt"), untracked("src/a.txt"), untracked("top.txt")])

  expect(rows(tree)).toEqual(["0:src/a.txt", "0:src/nested/b.txt", "0:top.txt"])
  expect(tree.map((node) => node.label)).toEqual(["src/a.txt", "src/nested/b.txt", "top.txt"])
})

it("names every directory for collapse-all, and every leaf under a row", () => {
  const tree = buildTree([untracked("src/a.txt"), untracked("src/nested/b.txt"), untracked("top.txt")])

  expect(directoryPaths(tree)).toEqual(["src", "src/nested"])
  expect(filesUnder(tree[0] as TreeNode).map((change) => change.path)).toEqual(["src/a.txt", "src/nested/b.txt"])
  expect(filesUnder(tree[1] as TreeNode).map((change) => change.path)).toEqual(["top.txt"])
})

it("finds a path's row, falling back to its deepest visible ancestor", () => {
  // `src` keeps its own row only because it has two children; with one it would compress
  // into `src/nested` and there would be no ancestor to fall back to.
  const tree = buildTree([untracked("src/a.txt"), untracked("src/nested/b.txt"), untracked("top.txt")])
  const open = visibleRows(tree, noFolds, 0)

  expect(rowIndexFor(open, "src/nested/b.txt")).toBe(3)

  // With `src` collapsed the row is gone, and the directory that swallowed it is where the
  // cursor honestly belongs — not wherever the old index now points.
  const folded = visibleRows(tree, { collapsed: new Set(["src"]), expanded: new Set() }, 0)
  expect(rowIndexFor(folded, "src/nested/b.txt")).toBe(0)
  expect(rowIndexFor(folded, "gone.txt")).toBe(-1)

  // The *deepest* visible ancestor, not the first: with only `src/nested` folded, the row
  // to land on is that chain, not `src`.
  const partly = visibleRows(tree, { collapsed: new Set(["src/nested"]), expanded: new Set() }, 0)
  expect(rowIndexFor(partly, "src/nested/b.txt")).toBe(2)
})

it("hands the store's own FileChange to the row, by reference", () => {
  // `useDecoration` caches by `Object.is`; a node that copied the change would evict its
  // own cache slot on every render and the snapshot would never converge.
  const change = untracked("src/a.txt")
  const tree = buildTree([change])

  expect(((tree[0] as DirectoryNode).children[0] as FileNode).change).toBe(change)
  expect(filesUnder(tree[0] as TreeNode)[0]).toBe(change)
})

it("reads a rename as the move it is, shortening it when the file stayed put", () => {
  const moved: FileChange = {
    kind: "changed",
    path: "src/types.ts",
    previousPath: "src/predicates.ts",
    index: "renamed",
    worktree: null,
  }
  const acrossDirectories: FileChange = {
    kind: "changed",
    path: "src/types.ts",
    previousPath: "old/predicates.ts",
    index: "renamed",
    worktree: null,
  }

  const same = (buildTree([moved])[0] as DirectoryNode).children[0] as FileNode
  expect(fileLabel(same)).toBe("predicates.ts → types.ts")

  const across = (buildTree([acrossDirectories])[0] as DirectoryNode).children[0] as FileNode
  expect(fileLabel(across)).toBe("old/predicates.ts → types.ts")
})
