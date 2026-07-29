import { isConflicted, isStaged, isUnstaged, isUntracked, type FileChange } from "laziergit"

/**
 * The files Pane's projection of the working tree into a folder hierarchy — a Path Tree. Pure
 * and repository-free, so every rule below is testable against `FileChange` literals.
 */

export interface FileNode {
  readonly kind: "file"
  /** Root-relative, `/`-separated. Node identity, React key, and fold-set key. */
  readonly path: string
  /** What the row prints: the segments this node adds to its parent. */
  readonly label: string
  /**
   * The store's own object, by reference: `useDecoration` caches by `Object.is`, so a copy
   * would evict its own slot on every render.
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
 * Splits a git path into the segments a tree is built from. The empty-segment filter is not
 * defensive: git reports a nested repository as `vendor/nested/`, whose trailing slash would
 * otherwise build a child with no name. Always `/` — git's separator on every platform.
 */
function segmentsOf(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0)
}

/**
 * Sibling order: every directory first, then every file, each group by full node path,
 * code-unit, case-sensitive. Sorted here rather than relying on the parser's own path order,
 * which cannot produce it: the directory `b` is created when `b/a.txt` arrives, after `b.txt`.
 */
function byPath(left: TreeNode, right: TreeNode): number {
  const leftIsDirectory = left.kind === "directory"
  if (leftIsDirectory !== (right.kind === "directory")) return leftIsDirectory ? -1 : 1
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

/**
 * The label a node prints: the segments it adds to its parent, which for a compressed chain
 * is the whole chain (`core/src`).
 */
function labelUnder(parentPath: string, path: string): string {
  return parentPath === "" ? path : path.slice(parentPath.length + 1)
}

/**
 * A file's label, with a rename read as the move it is. A rename within one directory keeps
 * only the previous leaf: `src/a.ts → src/b.ts` under a `src` row is mostly redundant.
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
 * Collapses single-child directory chains into one row: `docs` holding only `adr` becomes a
 * `docs/adr` row. Stops at a single *file* child, so `extensions/diff/index.tsx` keeps its
 * directory rows rather than folding a file's whole path into one.
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
 * The children of a level, finished — and the root's entry point. The root is gathered rather
 * than finished because compressing it would drop the one directory row a single-child status
 * has; compression is a relationship to a parent, and the root has none.
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

/** The working tree as a flat-rooted folder hierarchy, with no root row. */
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
    // The label, not the path, carries a nested repository's trailing slash: the path stays
    // the normalised form the tree is keyed by.
    const label = change.path.endsWith("/") ? `${leaf}/` : leaf
    current.children.set(leaf, { kind: "file", path, label, change })
  }

  return gather(root, "").children
}

/**
 * The same files as one depth-0 list labelled with full paths. Built by walking the tree, so
 * flat mode inherits its ordering rather than being a second ordering model.
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
 * Which directories are folded. `expanded` exists so an explicit unfold outranks the fold
 * threshold, which would otherwise re-fold a big directory on the next poll.
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
 * Where a path sits in the visible rows: exactly, else its deepest visible ancestor, else -1.
 * The fallback is what catches a cursor whose row just folded away. Ancestry is tested with
 * `startsWith`, because path compression makes a row's path multi-segment.
 */
export function rowIndexFor(rows: readonly VisibleRow[], path: string): number {
  let best = -1
  let bestLength = -1
  for (const [index, row] of rows.entries()) {
    if (row.node.path === path) return index
    if (path.startsWith(`${row.node.path}/`) && row.node.path.length > bestLength) {
      best = index
      bestLength = row.node.path.length
    }
  }
  return best
}
