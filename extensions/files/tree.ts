import { isConflicted, isStaged, isUnstaged, isUntracked, type FileChange } from "laziergit"

/**
 * The files Pane's projection of the working tree into a folder hierarchy — a Path Tree.
 *
 * Pure and repository-free, so every rule below is testable against `FileChange` literals.
 * A helper file beside the Extension rather than public API: it is one Pane's view model,
 * and the second consumer (a commit's file list) is the one that would tell us which parts
 * generalise. `import type`-adjacent by design — the only import is the public module.
 */

export interface FileNode {
  readonly kind: "file"
  /** Root-relative, `/`-separated. Node identity, React key, and fold-set key. */
  readonly path: string
  /** What the row prints: the segments this node adds to its parent. */
  readonly label: string
  /**
   * The store's own object, by reference.
   *
   * Load-bearing: `useDecoration` caches by `Object.is` on the row it is handed, so a node
   * that copied or rebuilt the change would evict its own slot on every render and the
   * `useSyncExternalStore` snapshot would never converge.
   */
  readonly change: FileChange
}

export interface DirectoryNode {
  readonly kind: "directory"
  /** A compressed chain keeps the whole chain: `packages/core/src`. */
  readonly path: string
  readonly label: string
  readonly children: readonly TreeNode[]
  /** Rolled up in the build's own post-order pass — O(n), not O(rows × subtree). */
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
  readonly fileCount: number
}

export type TreeNode = FileNode | DirectoryNode

/** A directory under construction, before its children are known and its chain compressed. */
interface Building {
  readonly path: string
  readonly children: Map<string, Building | FileNode>
}

/**
 * Splits a git path into the segments a tree is built from.
 *
 * The empty-segment filter is load-bearing rather than defensive. Under
 * `--untracked-files=all` git reports a nested repository as a single record ending in a
 * slash — `? vendor/nested/` — and `"vendor/nested/".split("/")` is
 * `["vendor", "nested", ""]`. Without the filter that builds a directory holding a child
 * with no name, which is a row that prints nothing and can never be acted on.
 *
 * `node:path` is not available here (ADR-0001) and would be wrong anyway: git reports
 * root-relative paths with `/` separators on every platform, so `/` is the separator even
 * where the OS spells it `\`.
 */
function segmentsOf(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0)
}

/**
 * Sibling order: by full node path, code-unit, case-sensitive, files and directories
 * interleaved — lazygit's default.
 *
 * Comparing full paths rather than labels is what gets `b` before `b.txt`: `/` (0x2F) sorts
 * after `.` (0x2E), so the *file* `b.txt` would otherwise be emitted before the *directory*
 * `b` whose own rows are `b/…`, and a directory's rows would not be contiguous with it.
 * The parser already sorts its entries this way, but insertion order alone cannot produce
 * sibling order — the directory `b` is created when `b/a.txt` arrives, which is after
 * `b.txt`.
 */
function byPath(left: TreeNode, right: TreeNode): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

/**
 * The label a node prints: the segments it adds to its parent, which for a compressed chain
 * is the whole chain (`core/src`). One rule covers plain directories, compressed chains and
 * roots, so there is no separate "compression level" to keep in step with the path.
 */
function labelUnder(parentPath: string, path: string): string {
  return parentPath === "" ? path : path.slice(parentPath.length + 1)
}

/**
 * A file's label, with a rename read as the move it is.
 *
 * The previous path is shortened to its own leaf when the file did not leave its directory,
 * because `src/a.ts → src/b.ts` under a `src` row is three quarters redundant and the row
 * is competing for width in a narrow column.
 */
export function fileLabel(node: FileNode): string {
  const { change } = node
  if (change.previousPath === null) return node.label
  const previous = change.previousPath
  const sameParent = previous.slice(0, previous.lastIndexOf("/")) === change.path.slice(0, change.path.lastIndexOf("/"))
  const from = sameParent ? previous.slice(previous.lastIndexOf("/") + 1) : previous
  return `${from} → ${node.label}`
}

/**
 * Collapses single-child directory chains into one row: `docs` holding only `adr` holding
 * files becomes one `docs/adr` row.
 *
 * Stops as soon as the single child is a *file*, so `extensions/diff/index.tsx` keeps its
 * `extensions` and `diff` rows rather than folding a file's whole path into its directory.
 * Without this a deep repository spends most of a narrow Pane on rows that offer no choice.
 *
 * Deliberately not ported from lazygit: its single-file special case, which suppresses the
 * directory row entirely when the whole status is one file one level down. It produces a row
 * whose label is a path with no parent above it, and it vanishes the moment a second file
 * appears — a layout that reshuffles on an unrelated edit.
 */
function compress(node: Building): Building {
  let current = node
  for (;;) {
    if (current.children.size !== 1) return current
    const only = [...current.children.values()][0]
    if (only === undefined || !("children" in only)) return current
    current = only
  }
}

/** Turns a directory under construction into a finished node, rolling aggregates up. */
function finish(node: Building, parentPath: string): DirectoryNode {
  const collapsed = compress(node)
  return { ...gather(collapsed, parentPath), path: collapsed.path }
}

/**
 * The children of a level, finished — and the root's entry point.
 *
 * The root is gathered rather than finished because it must never be *compressed*: a repo
 * whose whole status sits under one directory has a root with a single child, and
 * compressing it would return that child's children and drop the directory row itself.
 * Compression is a property of a directory's relationship to its parent, and the root has
 * no parent.
 */
function gather(node: Building, parentPath: string): DirectoryNode {
  const collapsed = node
  const children: TreeNode[] = []
  let staged = false
  let unstaged = false
  let untracked = false
  let conflicted = false
  let fileCount = 0

  for (const child of collapsed.children.values()) {
    if ("children" in child) {
      const directory = finish(child, collapsed.path)
      children.push(directory)
      staged ||= directory.staged
      unstaged ||= directory.unstaged
      untracked ||= directory.untracked
      conflicted ||= directory.conflicted
      fileCount += directory.fileCount
      continue
    }
    children.push(child)
    staged ||= isStaged(child.change)
    unstaged ||= isUnstaged(child.change)
    untracked ||= isUntracked(child.change)
    conflicted ||= isConflicted(child.change)
    fileCount += 1
  }

  children.sort(byPath)
  return {
    kind: "directory",
    path: collapsed.path,
    label: labelUnder(parentPath, collapsed.path),
    children,
    staged,
    unstaged,
    untracked,
    conflicted,
    fileCount,
  }
}

/**
 * The working tree as a flat-rooted folder hierarchy.
 *
 * No root row (lazygit's `showRootItem: false`): with one path form there is exactly one way
 * to name a node, so the two-path confusion lazygit documents in `node.go` — an internal
 * `./x` path alongside a display `x` — cannot arise here.
 */
export function buildTree(files: readonly FileChange[]): readonly TreeNode[] {
  const root: Building = { path: "", children: new Map() }

  for (const change of files) {
    const segments = segmentsOf(change.path)
    if (segments.length === 0) continue

    let current = root
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const segment = segments[depth] ?? ""
      const path = current.path === "" ? segment : `${current.path}/${segment}`
      const existing = current.children.get(segment)
      if (existing !== undefined && "children" in existing) {
        current = existing
        continue
      }
      const created: Building = { path, children: new Map() }
      current.children.set(segment, created)
      current = created
    }

    const leaf = segments[segments.length - 1] ?? ""
    const path = current.path === "" ? leaf : `${current.path}/${leaf}`
    // The label, not the path, restores a nested repository's trailing slash: every write
    // hands git back `change.path` verbatim, so the node's own path stays the normalised
    // form the tree is keyed by while the row still reads as the directory git reported.
    const label = change.path.endsWith("/") ? `${leaf}/` : leaf
    current.children.set(leaf, { kind: "file", path, label, change })
  }

  return gather(root, "").children
}

/**
 * The same files as one depth-0 list labelled with full paths — today's density, one key
 * away.
 *
 * Built by walking the tree rather than mapping the input, so flat mode inherits the tree's
 * ordering instead of being a second ordering model with its own cursor cases. (lazygit's
 * flat mode floats conflicts, then tracked, then untracked; ours does not, deliberately.)
 */
export function buildFlatList(files: readonly FileChange[]): readonly TreeNode[] {
  return leavesOf(buildTree(files)).map((node) => ({ ...node, label: node.change.path }))
}

function leavesOf(nodes: readonly TreeNode[]): readonly FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.kind === "file") out.push(node)
    else out.push(...leavesOf(node.children))
  }
  return out
}

/**
 * Which directories are folded.
 *
 * Three states rather than a single collapsed set, because a threshold that folds a huge
 * directory on first draw has to lose to an explicit "no, keep this open" — otherwise the
 * ~2s poll would re-fold it under the user every time the status object changed. `expanded`
 * is that override, and it outranks both the threshold and nothing else.
 */
export interface FoldState {
  readonly collapsed: ReadonlySet<string>
  readonly expanded: ReadonlySet<string>
}

export const noFolds: FoldState = { collapsed: new Set(), expanded: new Set() }

/**
 * A directory is folded when the user folded it, or when it is big enough to bury the rest
 * of the tree and the user has not said otherwise. `threshold` of 0 disables the automatic
 * half entirely.
 */
export function isFolded(node: DirectoryNode, fold: FoldState, threshold: number): boolean {
  if (fold.collapsed.has(node.path)) return true
  if (fold.expanded.has(node.path)) return false
  return threshold > 0 && node.fileCount >= threshold
}

export interface VisibleRow {
  readonly node: TreeNode
  readonly depth: number
  /** Position in the flat list the cursor walks — contiguous from 0, folds excluded. */
  readonly index: number
}

/** The rows actually on screen, in draw order. */
export function visibleRows(nodes: readonly TreeNode[], fold: FoldState, threshold: number): readonly VisibleRow[] {
  const rows: VisibleRow[] = []

  const walk = (level: readonly TreeNode[], depth: number): void => {
    for (const node of level) {
      rows.push({ node, depth, index: rows.length })
      if (node.kind === "directory" && !isFolded(node, fold, threshold)) walk(node.children, depth + 1)
    }
  }

  walk(nodes, 0)
  return rows
}

/** Every directory path in the tree, for collapse-all. */
export function directoryPaths(nodes: readonly TreeNode[]): readonly string[] {
  const out: string[] = []
  for (const node of nodes) {
    if (node.kind !== "directory") continue
    out.push(node.path)
    out.push(...directoryPaths(node.children))
  }
  return out
}

/** The changes a row stands for: one for a file, every leaf beneath a directory. */
export function filesUnder(node: TreeNode): readonly FileChange[] {
  return node.kind === "file" ? [node.change] : leavesOf(node.children).map((leaf) => leaf.change)
}

/**
 * Where a path sits in the visible rows: exactly, else its deepest visible ancestor, else
 * -1.
 *
 * The ancestor fallback is what keeps a cursor on screen when the directory above it folds —
 * the row it was on is gone, and the row that swallowed it is the honest place to land. It
 * also gives lazygit's collapse-all behaviour (the cursor rises to the top-level ancestor)
 * as a consequence of the general rule rather than as its own special case.
 *
 * Tested with `startsWith(path + "/")` rather than by counting segments, because path
 * compression makes a row's path multi-segment: `packages/core/src` is one row, so "a row's
 * parent is its path minus one segment" is false everywhere in this tree.
 */
export function rowIndexFor(rows: readonly VisibleRow[], path: string): number {
  let best = -1
  let bestLength = -1
  for (const row of rows) {
    if (row.node.path === path) return row.index
    if (path.startsWith(`${row.node.path}/`) && row.node.path.length > bestLength) {
      best = row.index
      bestLength = row.node.path.length
    }
  }
  return best
}
