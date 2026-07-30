/** @jsxImportSource @opentui/react */
import {
  createCell,
  createRowSource,
  defineExtension,
  describeGitFailure,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  option,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type ChangeKind,
  type ConflictSide,
  type DiffTarget,
  type FileChange,
  type FilesApi,
  type Head,
  type RowDecoration,
  type PaneProps,
  type Theme,
} from "laziergit"
import { useEffect, useMemo, useRef } from "react"

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
  type FoldState,
  type TreeNode,
  type VisibleRow,
} from "./tree"

/** A total record rather than a switch: a new kind is a compile error, not a blank column. */
const kindGlyphs: { readonly [K in ChangeKind | "untracked"]: string } = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "?",
}

/** Git's own unmerged letters, so a conflicted row says which side did what. */
const conflictGlyphs: { readonly [K in ConflictSide]: string } = {
  added: "A",
  deleted: "D",
  modified: "U",
}

/** A row's two status columns: `X` then `Y`, the same pair `git status` prints. */
interface StatusCell {
  readonly index: string
  readonly worktree: string
  readonly indexToken: keyof Theme
  readonly worktreeToken: keyof Theme
}

function statusCell(change: FileChange): StatusCell {
  if (change.kind === "conflicted") {
    return {
      index: conflictGlyphs[change.ours],
      worktree: conflictGlyphs[change.theirs],
      indexToken: "danger",
      worktreeToken: "danger",
    }
  }
  // Both columns, because porcelain spells untracked `??`.
  if (change.index === null && change.worktree === "untracked") {
    return { index: "?", worktree: "?", indexToken: "info", worktreeToken: "info" }
  }
  return {
    index: change.index === null ? " " : kindGlyphs[change.index],
    worktree: change.worktree === null ? " " : kindGlyphs[change.worktree],
    indexToken: change.index === null ? "text" : "success",
    worktreeToken: change.worktree === null ? "text" : change.worktree === "untracked" ? "info" : "danger",
  }
}

/**
 * A directory's two columns: the expand marker, then one character summarising the subtree.
 * A character as well as a colour, so the summary survives a no-colour terminal. First match
 * wins, worst news first.
 */
function directoryCell(node: DirectoryNode, folded: boolean): StatusCell {
  // U+25B6 / U+25BC, lazygit's own pair, both one column wide.
  const marker = folded ? "\u25b6" : "\u25bc"
  const mark = node.conflicted
    ? { text: "!", token: "danger" as keyof Theme }
    : node.staged && !node.unstaged && !node.untracked
      ? { text: "+", token: "success" as keyof Theme }
      : node.staged
        ? { text: "~", token: "warning" as keyof Theme }
        : { text: " ", token: "text" as keyof Theme }
  return { index: marker, worktree: mark.text, indexToken: "textMuted", worktreeToken: mark.token }
}

/** A path holds exactly one entry (ADR-0005), so the path alone identifies a decoration slot. */
function changeKey(change: FileChange): string {
  return change.path
}

function labelOf(change: FileChange): string {
  return change.previousPath === null ? change.path : `${change.previousPath} → ${change.path}`
}

/** Every path one row owns: a rename is two index entries, and they only ever move together. */
function pathsOf(change: FileChange): readonly string[] {
  return change.previousPath === null ? [change.path] : [change.path, change.previousPath]
}

function inRepository(head: Head): boolean {
  return head.kind !== "noRepository"
}

/**
 * What discarding a row has to undo. `ctx.git.discard` is `git restore --worktree` (plus
 * `clean` for an untracked path), so it restores *from the index* — staged content has to
 * leave the index first or the discard is a confirmation followed by nothing.
 */
type DiscardOutcome =
  /** Untracked: no HEAD version to come back to, so the file goes. */
  | "delete"
  /** Tracked, working-tree edits only: restore from the index. */
  | "restore"
  /** Staged content: take it out of the index, then restore from HEAD. */
  | "unstageAndRestore"
  /** A staged addition: HEAD has no such file, so going back to HEAD deletes it. */
  | "unstageAndDelete"

interface DiscardPlan {
  readonly outcome: DiscardOutcome
  /** Every path the undo touches, the index side included. */
  readonly paths: readonly string[]
}

/** Null on a conflicted path: resolving one belongs to the user's editor (§5.12). */
function discardPlan(change: FileChange): DiscardPlan | null {
  if (change.kind === "conflicted") return null
  if (change.index === null) {
    return change.worktree === "untracked"
      ? { outcome: "delete", paths: [change.path] }
      : { outcome: "restore", paths: pathsOf(change) }
  }
  return { outcome: change.index === "added" ? "unstageAndDelete" : "unstageAndRestore", paths: pathsOf(change) }
}

interface Confirmation {
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
}

/** One wording per outcome: two of the four delete the file, and the text has to say so. */
function discardConfirmation(plan: DiscardPlan, change: FileChange): Confirmation {
  const label = labelOf(change)
  switch (plan.outcome) {
    case "delete":
      return {
        title: "Delete untracked file?",
        message: `${label} is untracked — discarding it deletes the file.`,
        confirmLabel: "delete",
      }
    case "restore":
      return {
        title: "Discard changes?",
        message: `Throw away working-tree changes to ${label}.`,
        confirmLabel: "discard",
      }
    case "unstageAndRestore":
      return {
        title: "Discard staged changes?",
        message: `Unstage ${label} and throw away its changes — the file goes back to what HEAD has.`,
        confirmLabel: "discard",
      }
    case "unstageAndDelete":
      return {
        title: "Delete staged file?",
        message: `${label} is not in HEAD — discarding it unstages the file and deletes it.`,
        confirmLabel: "delete",
      }
  }
}

const isNotConflicted = (change: FileChange): boolean => !isConflicted(change)

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

export default defineExtension({
  name: "files",
  description: "The working tree as a folder tree, with staged and unstaged state per row",
  needs: ["diff"],

  config: {
    view: option.enum(["tree", "flat"] as const, {
      default: "tree",
      description: "File list layout at startup: a folder tree, or one flat list of paths",
    }),
    collapseThreshold: option.number({
      default: 200,
      min: 0,
      max: 100_000,
      description: "Fold a folder on first draw once it holds this many changed files (0 disables)",
    }),
  },

  activate(ctx): FilesApi {
    const host = createRowSource<FileChange>({ key: changeKey })
    const diff = ctx.extensions.get("diff")

    // Cells in `activate`, not `useState`: the Layout unmounts a Pane it has tabbed away, and
    // the folds have to outlive that. `viewMode` is seeded from the activation-constant config
    // snapshot and never written back, so a toggle is a session layer over the default.
    const fold = createCell<FoldState>(noFolds)
    const viewMode = createCell<"tree" | "flat">(ctx.config.view)
    const threshold = ctx.config.collapseThreshold

    /**
     * Folds or unfolds one directory, writing to *both* sets. A collapsed set alone cannot
     * express "keep this open", so the fold threshold would re-fold a big directory on the
     * next poll.
     */
    function setFolded(node: DirectoryNode, folded: boolean): void {
      const current = fold.get()
      const collapsed = new Set(current.collapsed)
      const expanded = new Set(current.expanded)
      if (folded) {
        collapsed.add(node.path)
        expanded.delete(node.path)
      } else {
        collapsed.delete(node.path)
        expanded.add(node.path)
      }
      fold.set({ collapsed, expanded })
    }

    /**
     * What the diff Pane should show for a row. A change living only in the index has nothing
     * in the working tree to diff, so `staged` is the only side that shows anything.
     */
    function diffTarget(node: TreeNode): DiffTarget {
      if (node.kind === "directory") {
        return { kind: node.staged && !node.unstaged ? "staged" : "workingTree", path: node.path }
      }
      const staged = node.change.kind === "changed" && node.change.index !== null && node.change.worktree === null
      return { kind: staged ? "staged" : "workingTree", path: node.change.path }
    }

    const fail = (action: string, error: unknown): void => {
      ctx.popups.notify(`${action}: ${describeGitFailure(error)}`, "error")
    }

    async function stage(paths: readonly string[] | "all"): Promise<void> {
      try {
        await ctx.git.stage(paths)
      } catch (error) {
        fail("Stage", error)
      }
    }

    // A staged rename is two index entries, and `unstage` resets exactly the paths it is
    // handed: dropping the previous path would leave the file looking half-renamed.
    async function unstage(change: FileChange): Promise<void> {
      try {
        await ctx.git.unstage(pathsOf(change))
      } catch (error) {
        fail("Unstage", error)
      }
    }

    async function unstageAll(): Promise<void> {
      try {
        await ctx.git.unstage("all")
      } catch (error) {
        fail("Unstage all", error)
      }
    }

    /**
     * `space` on a file: stage it unless there is nothing left to stage. Staging a conflicted
     * file is how git records a resolution, which is v1's whole conflict write path (§5.12).
     */
    async function toggleFile(change: FileChange): Promise<void> {
      if (isUnstaged(change) || isUntracked(change) || isConflicted(change)) await stage([change.path])
      else await unstage(change)
    }

    /**
     * `space` on a directory: the same rule over the subtree. Staging passes the directory
     * pathspec and lets git recurse; unstaging also names every descendant's previous path, or
     * a rename into this directory leaves its other half staged.
     */
    async function toggleDirectory(node: DirectoryNode): Promise<void> {
      // Refused rather than staged: `git add` on an unmerged file marks the conflict resolved
      // with the markers still in it, which is not what a keypress aimed at a folder asked for.
      if (node.conflicted) {
        ctx.popups.notify(`${node.path} holds a conflict — resolve it before staging the folder`, "warning")
        return
      }
      if (node.unstaged || node.untracked) {
        await stage([node.path])
        return
      }
      const previous = filesUnder(node).flatMap((change) => (change.previousPath === null ? [] : [change.previousPath]))
      try {
        await ctx.git.unstage([node.path, ...previous])
      } catch (error) {
        fail("Unstage", error)
      }
    }

    async function toggleRow(node: TreeNode | undefined): Promise<void> {
      if (node === undefined) return
      if (node.kind === "file") await toggleFile(node.change)
      else await toggleDirectory(node)
    }

    async function discard(change: FileChange): Promise<void> {
      const plan = discardPlan(change)
      if (plan === null) return
      const confirmed = await ctx.popups.confirm({ ...discardConfirmation(plan, change), danger: true })
      if (!confirmed) return

      try {
        // Unstage first: `discard` restores from the index, so whatever is still in the index
        // is exactly what survives.
        if (plan.outcome === "unstageAndRestore" || plan.outcome === "unstageAndDelete") {
          await ctx.git.unstage(plan.paths)
        }
        await ctx.git.discard(plan.paths)
      } catch (error) {
        fail("Discard", error)
      }
    }

    /**
     * `d` on a directory, expanded to leaves rather than passed as a pathspec: `ctx.git.discard`
     * partitions paths by exact membership in the untracked set, so a directory would always
     * land in `git restore --worktree` and skip the untracked files under it.
     */
    async function discardDirectory(node: DirectoryNode): Promise<void> {
      const plans = filesUnder(node).flatMap((change) => {
        const plan = discardPlan(change)
        return plan === null ? [] : [plan]
      })
      if (plans.length === 0) {
        ctx.popups.notify(`Nothing under ${node.path} can be discarded`)
        return
      }

      const deletions = plans.filter((plan) => plan.outcome === "delete" || plan.outcome === "unstageAndDelete").length
      const confirmed = await ctx.popups.confirm({
        title: `Discard everything under ${node.path}?`,
        message:
          deletions === 0
            ? `Throw away changes to ${plural(plans.length, "file")}.`
            : `Throw away changes to ${plural(plans.length, "file")}, deleting ${plural(deletions, "untracked file")}.`,
        confirmLabel: "discard",
        danger: true,
      })
      if (!confirmed) return

      const unstageFirst = plans
        .filter((plan) => plan.outcome === "unstageAndRestore" || plan.outcome === "unstageAndDelete")
        .flatMap((plan) => [...plan.paths])
      const paths = [...new Set(plans.flatMap((plan) => [...plan.paths]))]

      try {
        if (unstageFirst.length > 0) await ctx.git.unstage([...new Set(unstageFirst)])
        await ctx.git.discard(paths)
      } catch (error) {
        fail("Discard", error)
      }
    }

    /**
     * Working-tree changes only: staged content survives, since `discard` restores from the
     * index. Conflicted paths are left out — resolving them belongs to the editor (§5.12).
     */
    async function discardAll(): Promise<void> {
      const status = ctx.git.state.status
      const affected = status.files.filter((change) => isUnstaged(change) || isUntracked(change))
      const paths = affected.map((change) => change.path)
      if (paths.length === 0) {
        ctx.popups.notify("No working-tree changes to discard")
        return
      }

      const untracked = affected.filter(isUntracked).length
      const confirmed = await ctx.popups.confirm({
        title: "Discard all working-tree changes?",
        message:
          untracked === 0
            ? `Throw away changes to ${plural(paths.length, "file")}.`
            : `Throw away changes to ${plural(paths.length, "file")}, deleting ${plural(untracked, "untracked file")}.`,
        confirmLabel: "discard all",
        danger: true,
      })
      if (!confirmed) return

      try {
        await ctx.git.discard(paths)
      } catch (error) {
        fail("Discard all", error)
      }
    }

    /**
     * `ctx.open`, not `ctx.exec`: `exec` pipes the child's stdio, so a terminal editor would
     * have no terminal to draw on. The root is joined by hand because an Extension has no
     * `node:path` (ADR-0001); git reports paths relative to the root with `/` separators.
     */
    async function openPath(path: string): Promise<void> {
      try {
        await ctx.open(`${ctx.git.root}/${path}`)
      } catch (error) {
        fail("Open", error)
      }
    }

    const openFile = (change: FileChange): Promise<void> => openPath(change.path)

    /**
     * `x` opens the registered `files.actions` menu on a file, and an ad-hoc one on a folder:
     * a directory row is not a `FileChange`, and widening that payload would push the union
     * onto every third-party splice. The cost, named in §5.12, is that nothing can splice into
     * the folder menu.
     */
    async function openMenu(node: TreeNode | undefined): Promise<void> {
      if (node === undefined) return
      if (node.kind === "file") {
        await ctx.menus.open("files.actions", node.change)
        return
      }
      await ctx.popups.menu({
        title: `Folder: ${node.path}`,
        groups: [
          {
            id: "folder",
            title: "This folder",
            items: [
              { key: "s", label: "Stage everything here", run: () => stage([node.path]) },
              {
                key: "u",
                label: "Unstage everything here",
                run: () => toggleDirectory({ ...node, unstaged: false, untracked: false }),
              },
              { key: "shift+d", label: "Discard everything here", run: () => discardDirectory(node) },
              { key: "o", label: "Open folder", run: () => openPath(node.path) },
            ],
          },
        ],
      })
    }

    ctx.menus.register({
      id: "files.actions",
      title: (change) => `File: ${change.path}`,
      groups: [
        {
          id: "file",
          title: "This file",
          items: [
            { key: "s", label: "Stage", when: isNotConflicted, run: (change) => stage([change.path]) },
            {
              key: "u",
              label: "Unstage",
              when: isStaged,
              run: unstage,
            },
            { key: "d", label: "Discard changes", when: isNotConflicted, run: discard },
            // Shares `o` with the conflict group below: visibility is settled before key
            // conflicts, and these two `when`s are exact opposites (§5.7).
            { key: "o", label: "Open in default application", when: isNotConflicted, run: openFile },
          ],
        },
        {
          // Delegated to the editor (§5.12): no pick-ours/pick-theirs, which needs both a
          // conflict-kind variant `FileChange` does not carry and patch-level staging.
          id: "conflict",
          title: "Conflict",
          items: [
            { key: "o", label: "Open in default application", when: isConflicted, run: openFile },
            { key: "m", label: "Stage resolved", when: isConflicted, run: (change) => stage([change.path]) },
          ],
        },
        {
          id: "all",
          title: "All files",
          items: [
            { key: "a", label: "Stage all files", run: () => stage("all") },
            { key: "r", label: "Unstage all files", run: unstageAll },
            {
              // `shift+d`, not `D`: the parser lowercases a bare letter, colliding with `d`.
              key: "shift+d",
              label: "Discard all working-tree changes",
              run: discardAll,
            },
          ],
        },
      ],
    })

    /**
     * The shared shape of every row. Split from the two wrappers below because `useDecoration`
     * is a hook and a directory has no `FileChange` to look one up by.
     */
    function Line({
      id,
      depth,
      cell,
      label,
      decoration,
      selected,
      focused,
      onSelect,
    }: {
      readonly id: string
      readonly depth: number
      readonly cell: StatusCell
      readonly label: string
      readonly decoration: RowDecoration | undefined
      readonly selected: boolean
      readonly focused: boolean
      readonly onSelect: () => void
    }) {
      const theme = useTheme()
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined} onMouseDown={onSelect}>
          {/* The status pair sits before the indent, so `XY` pins to the same two columns
              however deep the row is. */}
          <span fg={dim ? theme.textMuted : theme[cell.indexToken]}>{cell.index}</span>
          <span fg={dim ? theme.textMuted : theme[cell.worktreeToken]}>{cell.worktree}</span>
          {/* Indent is spaces inside the one `<text>`, not nested boxes: `scrollChildIntoView`
              finds a row by id. */}
          <span fg={dim ? theme.textMuted : theme.text}>{` ${"  ".repeat(depth)}${label}`}</span>
          <span fg={toneColor(theme, decoration?.tone)}>{badge === undefined ? "" : ` ${badge}`}</span>
        </text>
      )
    }

    function FileLine(props: {
      readonly node: FileNode
      readonly id: string
      readonly depth: number
      readonly selected: boolean
      readonly focused: boolean
      readonly onSelect: () => void
    }) {
      const decoration = host.useDecoration(props.node.change)
      return (
        <Line
          id={props.id}
          depth={props.depth}
          cell={statusCell(props.node.change)}
          label={fileLabel(props.node)}
          decoration={decoration}
          selected={props.selected}
          focused={props.focused}
          onSelect={props.onSelect}
        />
      )
    }

    function DirectoryLine(props: {
      readonly node: DirectoryNode
      readonly id: string
      readonly depth: number
      readonly folded: boolean
      readonly selected: boolean
      readonly focused: boolean
      readonly onSelect: () => void
    }) {
      return (
        <Line
          id={props.id}
          depth={props.depth}
          cell={directoryCell(props.node, props.folded)}
          label={props.node.label}
          decoration={undefined}
          selected={props.selected}
          focused={props.focused}
          onSelect={props.onSelect}
        />
      )
    }

    function FilesPane({ focused }: PaneProps) {
      const theme = useTheme()
      const status = useGit((state) => state.status)
      const repository = useGit((state) => inRepository(state.head))
      const view = viewMode.use()
      const folds = fold.use()

      // Memoised on the store slice's identity: a refresh that changed nothing hands back the
      // same object, so the tree survives the poll. Separate memos so expanding a directory
      // re-walks the tree without rebuilding it.
      const nodes = useMemo(
        () => (view === "tree" ? buildTree(status.files) : buildFlatList(status.files)),
        [status.files, view],
      )
      const sourceRows = useMemo(() => visibleRows(nodes, folds, threshold), [nodes, folds, threshold])
      const cursor = useListCursor({
        items: sourceRows,
        idPrefix: "files",
        noun: "file",
        query: {
          mode: "filter",
          fields: (row) =>
            filesUnder(row.node).flatMap((change) =>
              change.previousPath === null ? [change.path] : [change.path, change.previousPath],
            ),
        },
      })
      const rows = cursor.items

      /**
       * The cursor follows the node it was on, not the index: collapsing a directory above the
       * cursor deletes several rows at once, and `useListCursor` only clamps against the end of
       * the list. Resolved during render, so no frame lights the wrong row.
       */
      const anchor = useRef<{ rows: readonly VisibleRow[]; path: string | null }>({ rows, path: null })
      const anchored =
        anchor.current.rows !== rows && anchor.current.path !== null ? rowIndexFor(rows, anchor.current.path) : -1
      const index = anchored === -1 ? cursor.index : anchored
      const selected = rows[index]

      useEffect(() => {
        if (index !== cursor.index) cursor.setIndex(index)
        anchor.current = { rows, path: selected?.node.path ?? null }
      })

      useEffect(() => {
        host.setSelected(selected?.node.kind === "file" ? selected.node.change : undefined)
        return () => host.setSelected(undefined)
      }, [selected])

      useEffect(() => {
        // Only while focused: the diff belongs to whichever list the user is driving.
        if (!focused) return
        diff.show(selected === undefined ? null : diffTarget(selected.node))
      }, [focused, selected])

      useCommand({
        id: "files.toggle-stage",
        title: "Stage / unstage file",
        hint: "stage",
        keys: "space",
        run: () => toggleRow(selected?.node),
      })
      useCommand({
        id: "files.stage-all",
        title: "Stage all files",
        hint: "stage all",
        keys: "a",
        run: () => stage("all"),
      })
      useCommand({
        id: "files.discard",
        title: "Discard changes to file",
        hint: "discard",
        keys: "d",
        run: () => {
          const node = selected?.node
          if (node === undefined) return undefined
          return node.kind === "file" ? discard(node.change) : discardDirectory(node)
        },
      })
      useCommand({
        id: "files.open",
        title: "Open file in default application",
        // `o` as in lazygit; `e` stays free for editing in `$EDITOR`, which needs the
        // full-screen suspend laziergit does not have yet.
        keys: "o",
        run: () => (selected === undefined ? undefined : openPath(selected.node.path)),
      })
      useCommand({
        id: "files.menu",
        title: "File actions",
        hint: "menu",
        keys: "x",
        run: () => openMenu(selected?.node),
      })

      // `return`, not `"enter"`: OpenTUI's name for the key, and core installs no aliases, so
      // `"enter"` would register, appear in the cheat sheet, and never fire.
      useCommand({
        id: "files.toggle-collapse",
        title: "Expand / collapse folder",
        keys: "return",
        run: () => {
          const node = selected?.node
          if (node === undefined || node.kind !== "directory") return
          setFolded(node, !isFolded(node, folds, threshold))
        },
      })
      useCommand({
        id: "files.collapse-all",
        title: "Collapse every folder",
        keys: "-",
        run: () => fold.set({ collapsed: new Set(directoryPaths(nodes)), expanded: new Set() }),
      })
      useCommand({
        id: "files.expand-all",
        title: "Expand every folder",
        // Names every directory rather than clearing both sets, or the fold threshold would
        // immediately re-fold the big ones.
        keys: "=",
        run: () => fold.set({ collapsed: new Set(), expanded: new Set(directoryPaths(nodes)) }),
      })
      useCommand({
        id: "files.toggle-view",
        title: "Switch between the tree and a flat list",
        keys: "`",
        run: () => viewMode.set(viewMode.get() === "tree" ? "flat" : "tree"),
      })

      if (!repository) return <text fg={theme.textMuted} content="no repository here" />

      // Measured on the file count, not the row count: they differ once something is folded.
      if (status.files.length === 0) return <text fg={theme.textMuted} content="working tree clean" />
      if (rows.length === 0) return <text fg={theme.textMuted} content="no matching files" />

      return (
        // Not focusable: OpenTUI has a single focus slot, and laziergit's own focus model
        // decides which Pane's keys are live — claiming it would starve the popup inputs.
        // `flexBasis={0}` sizes the box to the Pane rather than to its content, so a long list
        // scrolls instead of overflowing the frame.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {rows.map((row, rowIndex) =>
            row.node.kind === "file" ? (
              <FileLine
                key={row.node.path}
                id={cursor.rowId(rowIndex)}
                node={row.node}
                depth={row.depth}
                selected={rowIndex === index}
                focused={focused}
                onSelect={() => cursor.setIndex(rowIndex)}
              />
            ) : (
              <DirectoryLine
                key={row.node.path}
                id={cursor.rowId(rowIndex)}
                node={row.node}
                depth={row.depth}
                folded={isFolded(row.node, folds, threshold)}
                selected={rowIndex === index}
                focused={focused}
                onSelect={() => cursor.setIndex(rowIndex)}
              />
            ),
          )}
        </scrollbox>
      )
    }

    const pane = ctx.panes.register({
      id: "files",
      title: "Files",
      component: FilesPane,
      placement: { column: 0, order: 20 },
    })

    // Keyless: core binds `1`–`9` positionally over the Layout (§1.7).
    ctx.commands.register({
      id: "files.focus",
      title: "Focus the files pane",
      run: () => pane.focus(),
    })

    return host.api
  },
})
