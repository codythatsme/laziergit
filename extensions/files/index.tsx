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

import { previewStage, previewUnstage } from "./optimistic"
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

/** A total record: a new kind is a compile error, not a blank column. */
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
  // U+25B6 / U+25BC, both one column wide.
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

/** A path holds exactly one entry, so the path alone identifies a decoration slot. */
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

/** Null on a conflicted path: resolving one belongs to the user's editor. */
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
    scrollOffMargin: option.number({
      default: 2,
      min: 0,
      max: 100,
      description: "Keep this many files visible in the direction of cursor travel",
    }),
  },

  activate(ctx): FilesApi {
    const host = createRowSource<FileChange>({ pane: "files", key: changeKey })
    const diff = ctx.extensions.get("diff")

    // Cells in `activate`, not `useState`: the Layout unmounts a Pane it has tabbed away, and
    // the folds have to outlive that. `viewMode` is seeded from the activation-constant config
    // snapshot and never written back, so a toggle is a session layer over the default.
    const fold = createCell<FoldState>(noFolds)
    const viewMode = createCell<"tree" | "flat">(ctx.config.view)
    const previewFiles = createCell<readonly FileChange[] | null>(null)
    const threshold = ctx.config.collapseThreshold
    const scrollOffMargin = ctx.config.scrollOffMargin
    let previewsInFlight = 0

    /**
     * Lazygit makes this same trade-off: staging is common enough that the known status pairs
     * move immediately, then the real status refresh corrects anything the preview could not
     * derive. Overlapping commands retain the combined preview until all have reconciled.
     */
    function beginPreview(
      paths: readonly string[] | "all",
      transform: (files: readonly FileChange[], selection: readonly string[] | "all") => readonly FileChange[],
    ): () => void {
      const current = previewFiles.get() ?? ctx.git.state.status.files
      const next = transform(current, paths)
      if (next === current) return () => undefined

      previewsInFlight += 1
      previewFiles.set(next)
      let ended = false
      return () => {
        if (ended) return
        ended = true
        previewsInFlight -= 1
        if (previewsInFlight === 0) previewFiles.set(null)
      }
    }

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
      const endPreview = beginPreview(paths, previewStage)
      try {
        await ctx.git.stage(paths)
      } catch (error) {
        fail("Stage", error)
      } finally {
        endPreview()
      }
    }

    // A staged rename is two index entries, and `unstage` resets exactly the paths it is
    // handed: dropping the previous path would leave the file looking half-renamed.
    async function unstage(change: FileChange): Promise<void> {
      const paths = pathsOf(change)
      const endPreview = beginPreview(paths, previewUnstage)
      try {
        await ctx.git.unstage(paths)
      } catch (error) {
        fail("Unstage", error)
      } finally {
        endPreview()
      }
    }

    async function unstageDirectory(node: DirectoryNode): Promise<void> {
      const previous = filesUnder(node).flatMap((change) => (change.previousPath === null ? [] : [change.previousPath]))
      const paths = [node.path, ...previous]
      const endPreview = beginPreview(paths, previewUnstage)
      try {
        await ctx.git.unstage(paths)
      } catch (error) {
        fail("Unstage", error)
      } finally {
        endPreview()
      }
    }

    async function unstageAll(): Promise<void> {
      const endPreview = beginPreview("all", previewUnstage)
      try {
        await ctx.git.unstage("all")
      } catch (error) {
        fail("Unstage all", error)
      } finally {
        endPreview()
      }
    }

    /**
     * `space` on a file: stage it unless there is nothing left to stage. Staging a conflicted
     * file is how git records a resolution.
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
      await unstageDirectory(node)
    }

    async function toggleRow(node: TreeNode | undefined): Promise<void> {
      if (node === undefined) return
      if (node.kind === "file") await toggleFile(node.change)
      else await toggleDirectory(node)
    }

    async function unstageRow(node: TreeNode | undefined): Promise<void> {
      if (node === undefined) return
      if (node.kind === "file") await unstage(node.change)
      else await unstageDirectory(node)
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
     * index. Conflicted paths are left out — resolving them belongs to the editor.
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
     * `node:path`; git reports paths relative to the root with `/` separators.
     */
    async function openPath(path: string): Promise<void> {
      try {
        await ctx.open(`${ctx.git.root}/${path}`)
      } catch (error) {
        fail("Open", error)
      }
    }

    async function copyPath(path: string): Promise<void> {
      try {
        await ctx.copy(path)
        ctx.popups.notify(`Copied ${path}`, "success")
      } catch (error) {
        fail("Copy", error)
      }
    }

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
        // The row owns the full width, so its selection background and mouse target do too.
        // Keeping the cursor id here lets `scrollChildIntoView` follow the same visual row.
        <box
          id={id}
          width="100%"
          flexDirection="row"
          backgroundColor={selected && focused ? theme.selection : undefined}
          onMouseDown={onSelect}
        >
          <text wrapMode="none" flexShrink={1}>
            {/* Indent the whole row marker with its node, matching lazygit's file tree: status
                letters and folder chevrons should stay beside the name they describe. */}
            <span>{"  ".repeat(depth)}</span>
            <span fg={dim ? theme.textMuted : theme[cell.indexToken]}>{cell.index}</span>
            <span fg={dim ? theme.textMuted : theme[cell.worktreeToken]}>{cell.worktree}</span>
            <span fg={dim ? theme.textMuted : theme.text}>{` ${label}`}</span>
            <span fg={toneColor(theme, decoration?.tone)}>{badge === undefined ? "" : ` ${badge}`}</span>
          </text>
        </box>
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
      const storedFiles = useGit((state) => state.status.files)
      const files = previewFiles.use() ?? storedFiles
      const repository = useGit((state) => inRepository(state.head))
      const view = viewMode.use()
      const folds = fold.use()

      // Memoised on the store slice's identity: a refresh that changed nothing hands back the
      // same object, so the tree survives the poll. Separate memos so expanding a directory
      // re-walks the tree without rebuilding it.
      const nodes = useMemo(() => (view === "tree" ? buildTree(files) : buildFlatList(files)), [files, view])
      const sourceRows = useMemo(() => visibleRows(nodes, folds, threshold), [nodes, folds, threshold])
      const cursor = useListCursor({
        items: sourceRows,
        idPrefix: "files",
        noun: "file",
        scrollOffMargin,
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
        title: "Stage / unstage selected path",
        hint: "stage",
        keys: "space",
        run: () => toggleRow(selected?.node),
      })
      useCommand({
        id: "files.unstage-selected",
        title: "Unstage selected path",
        hint: "unstage",
        keys: "u",
        when: () => {
          const node = selected?.node
          return node?.kind === "directory" ? node.staged : node !== undefined && isStaged(node.change)
        },
        run: () => unstageRow(selected?.node),
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
        when: () => {
          const node = selected?.node
          return node?.kind === "directory" || (node !== undefined && !isConflicted(node.change))
        },
        run: () => {
          const node = selected?.node
          if (node === undefined) return undefined
          return node.kind === "file" ? discard(node.change) : discardDirectory(node)
        },
      })
      useCommand({
        id: "files.open",
        title: "Open selected path in default application",
        keys: "o",
        run: () => (selected === undefined ? undefined : openPath(selected.node.path)),
      })
      useCommand({
        id: "files.copy-path",
        title: "Copy relative file path",
        keys: "y",
        when: () => selected?.node.kind === "file",
        run: () => {
          const node = selected?.node
          return node?.kind === "file" ? copyPath(node.path) : undefined
        },
      })
      useCommand({
        id: "files.unstage-all",
        title: "Unstage all files",
        keys: "r",
        run: unstageAll,
      })
      useCommand({
        id: "files.discard-all",
        title: "Discard all working-tree changes",
        keys: "shift+d",
        run: discardAll,
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
      if (files.length === 0) return <text fg={theme.textMuted} content="working tree clean" />
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

    // Keyless: core binds `1`–`9` positionally over the Layout.
    ctx.commands.register({
      id: "files.focus",
      title: "Focus the files pane",
      run: () => pane.focus(),
    })

    return host.api
  },
})
