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

/**
 * One glyph per state a side of the index can be in, as a total record rather than a switch:
 * a kind added to the model is a compile error here instead of a row that draws a blank
 * status column.
 *
 * There is no matching colour table any more. Colour now comes from the *column* a letter
 * sits in — green for the index, red for the working tree — which is lazygit's scheme and
 * the reason the pair reads at a glance: `M ` and ` M` are different colours as well as
 * different positions.
 */
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

/**
 * A row's two status columns: `X` then `Y`, exactly as git spells them.
 *
 * This is what replaced the group headings. A heading could only say one thing about a row,
 * so an `MM` file had to be drawn twice under two of them; two columns say both things in
 * one row, and the pair is the same `XY` a user already reads in `git status`.
 */
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
  // Untracked fills both columns, because git does: porcelain spells it `??`, and a lone
  // `?` in the working-tree column would read as "something happened to the index" — the
  // one thing that has not happened to a file git has never been told about.
  if (change.index === null && change.worktree === "untracked") {
    return { index: "?", worktree: "?", indexToken: "info", worktreeToken: "info" }
  }
  return {
    index: change.index === null ? " " : kindGlyphs[change.index],
    worktree: change.worktree === null ? " " : kindGlyphs[change.worktree],
    // Staged content is green and unstaged content is red on the side it lives on, so the
    // column a letter sits in carries as much meaning as the letter.
    indexToken: change.index === null ? "text" : "success",
    worktreeToken: change.worktree === null ? "text" : change.worktree === "untracked" ? "info" : "danger",
  }
}

/**
 * A directory's own two columns: the expand marker, then one character summarising what is
 * underneath it.
 *
 * A character as well as a colour, because a folded directory is the only row whose whole
 * content is its subtree — and in a no-colour terminal a colour-only summary says nothing
 * at all. First match wins, worst news first.
 */
function directoryCell(node: DirectoryNode, folded: boolean): StatusCell {
  const marker = folded ? "\u25b8" : "\u25be"
  const mark = node.conflicted
    ? { text: "!", token: "danger" as keyof Theme }
    : node.staged && !node.unstaged && !node.untracked
      ? { text: "+", token: "success" as keyof Theme }
      : node.staged
        ? { text: "~", token: "warning" as keyof Theme }
        : { text: " ", token: "text" as keyof Theme }
  return { index: marker, worktree: mark.text, indexToken: "textMuted", worktreeToken: mark.token }
}

/**
 * A decoration slot per path.
 *
 * The model gives a path exactly one entry (ADR-0005), so the path *is* the identity and
 * there is nothing else to join into the key. Keying on the state as well would move the
 * slot every time a row's status changed \u2014 staging a file would evict a decoration its
 * provider would only recompute to the same answer.
 */
function changeKey(change: FileChange): string {
  return change.path
}

/** Renames read as the move they are; every other kind is just its path. */
function labelOf(change: FileChange): string {
  return change.previousPath === null ? change.path : `${change.previousPath} → ${change.path}`
}

/** Every path one row owns: a rename is two index entries, and they only ever move together. */
function pathsOf(change: FileChange): readonly string[] {
  return change.previousPath === null ? [change.path] : [change.path, change.previousPath]
}

/**
 * Whether there is a repository at all. Without this check an empty status reads as "working
 * tree clean", which claims a healthy, fully committed repository in the one place where
 * there is no repository to be clean.
 */
function inRepository(head: Head): boolean {
  return head.kind !== "noRepository"
}

/**
 * What discarding a row has to undo — decided against the status the store is serving
 * rather than against the group the row was drawn under, because the action menu hands its
 * items a {@link FileChange} and no group, and one key must not mean two things.
 *
 * `ctx.git.discard` is `git restore --worktree` (plus `clean` for an untracked path), so on
 * a path whose change lives only in the index it restores the file from the index onto
 * itself: a danger confirmation followed by nothing at all. Staged content therefore has to
 * leave the index first, after which `d` means what a lazygit user reads it to mean — this
 * file goes back to what HEAD has.
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

/**
 * No `status` argument any more, and that is the whole point of the model change: the
 * entry itself says which side of the index holds it, so this reads the row it was handed
 * instead of searching the staged array for a path that might also be in it. The old
 * version had to, because the row carried one `kind` and the group it came from was not
 * available here.
 *
 * Null on a conflicted path: resolving one belongs to the user's editor (§5.12), and
 * "discard" has no meaning for a file with two recorded sides and neither chosen.
 */
function discardPlan(change: FileChange): DiscardPlan | null {
  if (change.kind === "conflicted") return null
  if (change.index === null) {
    return change.worktree === "untracked"
      ? { outcome: "delete", paths: [change.path] }
      : { outcome: "restore", paths: pathsOf(change) }
  }
  // `pathsOf` carries the previous path too: unstaging one half of a staged rename would
  // leave the other half in the index and the file looking half-moved.
  return { outcome: change.index === "added" ? "unstageAndDelete" : "unstageAndRestore", paths: pathsOf(change) }
}

interface Confirmation {
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
}

/**
 * Spelled out per outcome rather than shared, because the four are not comparable: one loses
 * edits to a file that still exists, two remove the file from the disk, and one drops work
 * that was already staged. A danger confirmation whose text does not match what happens is
 * worse than none — it teaches the user to trust a sentence that is not true.
 */
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

/** "1 file" / "3 files", so a confirmation reads as a sentence rather than as `1 file(s)`. */
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

    /**
     * Which folders are folded, and which layout is on screen.
     *
     * Cells in `activate`, not `useState` in the Pane: the Layout unmounts a Pane it has
     * tabbed away, and a tree that forgot every fold each time the user glanced at another
     * tab would be worse than no tree at all. Neither survives a hot reload — the same
     * lifetime the diff Pane's view cell has, and the same reason: reload rebuilds the
     * Extension's whole scope.
     *
     * `viewMode` is seeded from config and never written back. `ctx.config` is an
     * activation-constant snapshot, so a session toggle is a layer over the configured
     * default rather than an edit to it.
     */
    const fold = createCell<FoldState>(noFolds)
    const viewMode = createCell<"tree" | "flat">(ctx.config.view)
    const threshold = ctx.config.collapseThreshold

    /**
     * Folds or unfolds one directory, writing to *both* sets.
     *
     * A single collapsed set cannot express "keep this open": the fold threshold folds a
     * big directory on first draw, and without an explicit `expanded` entry the ~2s poll
     * would re-fold it under the user every time the status object changed.
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
     * What the diff Pane should show for a row.
     *
     * The side used to come from the group heading the row was drawn under. It comes from
     * the entry now: a change that lives only in the index has nothing in the working tree
     * to diff, so `staged` is the only reading that shows anything at all. A directory
     * diffs as a pathspec, which git answers against the index — so a folder of purely
     * untracked files renders an empty patch, and the diff Pane already says "no changes".
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

    /**
     * A staged rename is two index entries — the new path added and the old one deleted —
     * and `unstage` resets exactly the paths it is handed, so dropping the previous path
     * would leave the deletion staged and the file still looking half-renamed.
     */
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
     * `space` on a file: stage it unless there is nothing left to stage, in which case
     * unstage it.
     *
     * The old version read the group the row was drawn under, which no longer exists — and
     * the entry says it better anyway. A path with anything on the working-tree side is a
     * path with something to stage, so the same key walks `M` → `M ` → ` M` without ever
     * needing to know which heading the row came from. Staging a conflicted file is how git
     * records a resolution, which is the whole of v1's conflict write path (§5.12).
     */
    async function toggleFile(change: FileChange): Promise<void> {
      if (isUnstaged(change) || isUntracked(change) || isConflicted(change)) await stage([change.path])
      else await unstage(change)
    }

    /**
     * `space` on a directory: the same rule, read over the subtree.
     *
     * Staging passes the **directory pathspec** rather than a file list — git recurses, and
     * a pathspec is one argv no matter how many files are under it. Unstaging additionally
     * names every descendant's previous path, or a rename *into* this directory from
     * outside leaves its other half staged and the file looking half-moved.
     */
    async function toggleDirectory(node: DirectoryNode): Promise<void> {
      // Refused rather than staged: `git add` on a directory holding an unmerged file marks
      // that conflict resolved on the way past, with the markers still in the file. Doing
      // that as a side effect of a keypress aimed at a folder is not a decision the user
      // made — the same reasoning §5.12 gives for keeping resolution explicit.
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
        // Unstaging first is the whole of it: `ctx.git.discard` restores the working tree
        // *from the index*, so anything still in the index is exactly what survives, and a
        // change that lives only there survives untouched.
        if (plan.outcome === "unstageAndRestore" || plan.outcome === "unstageAndDelete") {
          await ctx.git.unstage(plan.paths)
        }
        await ctx.git.discard(plan.paths)
      } catch (error) {
        fail("Discard", error)
      }
    }

    /**
     * `d` on a directory, expanded to the files underneath it.
     *
     * Deliberately **not** the directory pathspec, unlike staging. `ctx.git.discard`
     * partitions the paths it is given by exact membership in the untracked set, so a
     * directory always lands in `git restore --worktree` — which fails outright on a folder
     * holding only untracked files, and silently skips them when it holds a tracked one.
     * Expanding to leaves is what makes the confirmation's promise true.
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
     * Working-tree changes only. `ctx.git.discard` restores a tracked file *from the
     * index*, so staged content is exactly what survives; unstaging first would be a
     * bigger and differently destructive operation than the label promises. Conflicted
     * paths are left out because resolving them belongs to the user's editor (§5.12).
     */
    async function discardAll(): Promise<void> {
      const status = ctx.git.state.status
      // One pass, one entry per path: a file both edited and untracked-in-part cannot be
      // named twice here, so the count in the confirmation is the number of files.
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
     * `ctx.open`, not `ctx.exec`: `exec` pipes the child's stdio, so a terminal editor —
     * or `git mergetool` — has no terminal to draw on and cannot run inside the TUI at
     * all. The full-screen suspend/resume that would give it one is post-v1 (PLAN.md risk
     * table), so handing the file to the OS opener is the version that works today.
     *
     * The root is joined by hand because an Extension may import only `"laziergit"`,
     * `"react"` and `"@opentui/react"` (ADR-0001) — there is no `node:path` here. Git
     * reports paths relative to the root with `/` separators, which is the separator used.
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
     * `x` on a file opens the registered `files.actions` menu; on a directory it opens an
     * ad-hoc one.
     *
     * A directory row is not a `FileChange`, and `files.actions` is declared as taking one.
     * Widening that payload to a union would make every third-party splice into the menu
     * handle a case it never asked for, so the folder menu is built here instead. The cost
     * is real and named in §5.12: nothing can splice into it. The fix, when something needs
     * to, is a row-type union in the public API — and that belongs with its first consumer.
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
              { key: "e", label: "Open folder", run: () => openPath(node.path) },
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
              // Exactly the rows with something in the index to take out — which now hides
              // it on a purely-unstaged row too, not just an untracked one.
              when: isStaged,
              run: unstage,
            },
            { key: "d", label: "Discard changes", when: isNotConflicted, run: discard },
            { key: "e", label: "Open in default application", when: isNotConflicted, run: openFile },
          ],
        },
        {
          /**
           * Shown and delegated (§5.12): a conflicted row is offered the editor and a way
           * to record the result, and nothing else — no pick-ours/pick-theirs, which needs
           * both the conflict-kind variant `FileChange` does not carry and the patch-level
           * staging v1 leaves out. `when` hides these rather than greying them, so on an
           * ordinary row the keys are inert instead of disappointing.
           */
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
              // `shift+d`, not `D`: the binding parser lowercases a bare letter, so `D`
              // would claim the same stroke as the `d` above and one of them would
              // silently never fire.
              key: "shift+d",
              label: "Discard all working-tree changes",
              run: discardAll,
            },
          ],
        },
      ],
    })

    /**
     * The shared shape of every row: marker, indent, two status columns, label, badge.
     *
     * Split from the two wrappers below because `useDecoration` is a hook and a directory
     * has no `FileChange` to look one up by — a single component would have to call it
     * conditionally. The split is also what keeps `decorateRows`' contract honest: a
     * provider is only ever handed a file.
     */
    function Line({
      id,
      depth,
      cell,
      label,
      decoration,
      selected,
      focused,
    }: {
      readonly id: string
      readonly depth: number
      readonly cell: StatusCell
      readonly label: string
      readonly decoration: RowDecoration | undefined
      readonly selected: boolean
      readonly focused: boolean
    }) {
      const theme = useTheme()
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined}>
          {/* The marker, not the highlight, is what says where the cursor is while another
              Pane holds focus — the state in which the diff on screen is still this Pane's
              selection and the user needs to see which row that was. */}
          <span fg={theme.textMuted}>{selected ? "\u276f " : "  "}</span>
          {/* Indent is spaces inside the one `<text>`, not nested boxes: `scrollChildIntoView`
              finds a row by id, and a per-depth box tree would put every row at a different
              place in the layout for no gain. */}
          <span>{"  ".repeat(depth)}</span>
          <span fg={dim ? theme.textMuted : theme[cell.indexToken]}>{cell.index}</span>
          <span fg={dim ? theme.textMuted : theme[cell.worktreeToken]}>{cell.worktree}</span>
          <span fg={dim ? theme.textMuted : theme.text}>{` ${label}`}</span>
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
        />
      )
    }

    function FilesPane({ focused }: PaneProps) {
      const theme = useTheme()
      const status = useGit((state) => state.status)
      const repository = useGit((state) => inRepository(state.head))
      const view = viewMode.use()
      const folds = fold.use()

      // Memoised on the store slice's own identity: a refresh that changed nothing hands
      // back the same object, so the tree — and with it every decoration cache hit — survives
      // the poll untouched. Build and flatten are separate memos so expanding a directory
      // re-walks the tree without rebuilding it.
      const nodes = useMemo(
        () => (view === "tree" ? buildTree(status.files) : buildFlatList(status.files)),
        [status.files, view],
      )
      const rows = useMemo(() => visibleRows(nodes, folds, threshold), [nodes, folds, threshold])
      const cursor = useListCursor({ items: rows, idPrefix: "files", noun: "file" })

      /**
       * The cursor follows the *node* it was on, not the index.
       *
       * `useListCursor` clamps only against the end of the list, which is the right rule for
       * a flat list that only ever grows and shrinks at the bottom. A tree moves rows out
       * from under the cursor: collapsing a directory above it deletes several rows at once,
       * and the index that used to name the selected file silently comes to name a different
       * one. Anchoring on the path fixes that, and `rowIndexFor`'s deepest-visible-ancestor
       * fallback decides where to land when the anchored row is the one that just went away.
       *
       * Resolved during render rather than in an effect, the same discipline
       * `useListCursor` uses for its own clamp: the render that draws the collapse already
       * draws the corrected highlight, so there is no frame where the wrong row is lit.
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
        // Cleared on unmount, not merely replaced on the next move: a Pane the Layout has
        // tabbed away has no selection, and `FilesApi.selected()` must not keep naming the
        // row it had when it went off screen — least of all in the window between unmount
        // and scope disposal during a hot reload.
        return () => host.setSelected(undefined)
      }, [selected])

      /**
       * The diff follows this Pane only while it is focused: every list Pane pushes its
       * selection into the one diff Pane, and the focused one is the only one whose
       * selection the user is actually moving.
       */
      useEffect(() => {
        if (!focused) return
        // A tree that just went clean has nothing to diff, and saying so is the whole point
        // of `show(null)`: leaving the last file's patch up would claim it is still there.
        diff.show(selected === undefined ? null : diffTarget(selected.node))
      }, [focused, selected])

      // A selection is empty only when the list is, and the empty state below already says so
      // — a toast would repeat it, so every key with nothing to act on is a silent no-op. The
      // same rule in the branches, commits and stash Panes.
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
        keys: "e",
        run: () => (selected === undefined ? undefined : openPath(selected.node.path)),
      })
      useCommand({
        id: "files.menu",
        title: "File actions",
        hint: "menu",
        keys: "x",
        run: () => openMenu(selected?.node),
      })

      // `return`, not `"enter"`: OpenTUI names the Enter key `return`, and core does not
      // install the keymap's alias field, so `"enter"` would parse, register, appear in the
      // cheat sheet, and never fire.
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
        // Expanding has to name every directory too, rather than clearing both sets: an
        // empty `expanded` would let the fold threshold immediately re-fold the big ones,
        // and "expand all" that leaves something folded is a lie.
        keys: "=",
        run: () => fold.set({ collapsed: new Set(), expanded: new Set(directoryPaths(nodes)) }),
      })
      useCommand({
        id: "files.toggle-view",
        title: "Switch between the tree and a flat list",
        keys: "`",
        run: () => viewMode.set(viewMode.get() === "tree" ? "flat" : "tree"),
      })

      // Outside a repository there is no working tree to be clean, and saying it is clean
      // would report a healthy, fully committed repository where there is none at all.
      if (!repository) return <text fg={theme.textMuted} content="no repository" />

      // A clean tree is an answer, not an absence: an empty box would read as a Pane that
      // failed to load. Measured on the file count rather than the row count, which is the
      // same number only when nothing is folded.
      if (status.files.length === 0) return <text fg={theme.textMuted} content="working tree clean" />

      return (
        // Not focusable: OpenTUI has a single focus slot, and laziergit's own focus model
        // decides which Pane's keys are live, so a Pane claiming the renderer's focus would
        // only take it away from the popup layer's inputs.
        //
        // `flexBasis={0}` alongside `flexGrow`, or the box's flex size is its *content*
        // height: a list longer than the Pane makes the box taller than the Pane, which
        // paints over the Pane above it instead of scrolling inside its own frame.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {rows.map((row) =>
            row.node.kind === "file" ? (
              <FileLine
                key={row.node.path}
                id={cursor.rowId(row.index)}
                node={row.node}
                depth={row.depth}
                selected={row.index === index}
                focused={focused}
              />
            ) : (
              <DirectoryLine
                key={row.node.path}
                id={cursor.rowId(row.index)}
                node={row.node}
                depth={row.depth}
                folded={isFolded(row.node, folds, threshold)}
                selected={row.index === index}
                focused={focused}
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

    ctx.commands.register({
      id: "files.focus",
      title: "Focus the files pane",
      keys: "1",
      run: () => pane.focus(),
    })

    return host.api
  },
})
