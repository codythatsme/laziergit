/** @jsxImportSource @opentui/react */
import {
  createRowSource,
  defineExtension,
  describeGitFailure,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type ChangeKind,
  type FileChange,
  type FilesApi,
  type Head,
  type PaneProps,
  type Theme,
  type WorkingTreeStatus,
} from "laziergit"
import { useEffect, useMemo } from "react"

/**
 * The four groups, in the order they are drawn: conflicts first because nothing else can
 * proceed past them, untracked last because it is the noisiest and the least urgent.
 *
 * The names are exactly the {@link WorkingTreeStatus} keys holding each group's files, so
 * the flattening below indexes the status with them instead of re-listing four fields —
 * a group the model grew and this Pane forgot is a compile error rather than a blind spot.
 */
const groupOrder = ["conflicted", "staged", "unstaged", "untracked"] as const
type FileGroup = (typeof groupOrder)[number]

const groupTitles: { readonly [K in FileGroup]: string } = {
  conflicted: "Conflicted",
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
}

/**
 * One glyph and one theme token per {@link ChangeKind}, as total records rather than
 * switches: a kind added to the model is a compile error here instead of a row that draws
 * a blank status column in the default colour.
 */
const kindGlyphs: { readonly [K in ChangeKind]: string } = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "?",
  conflicted: "!",
}

const kindTokens: { readonly [K in ChangeKind]: keyof Theme } = {
  added: "success",
  modified: "warning",
  deleted: "danger",
  renamed: "info",
  copied: "info",
  typechange: "warning",
  untracked: "info",
  conflicted: "danger",
}

/**
 * A decoration slot per distinct change.
 *
 * `FilesApi` is a `RowSource<FileChange>`, so a decorating Extension — and therefore this
 * key — sees the change and never the group that drew it. Keying on all three of its
 * fields is what makes that safe: two rows share a slot exactly when they are the same
 * change, which is the `MM` case, a path modified in both index and worktree. Sharing is
 * then the right answer, because a provider handed either object would say the same thing.
 * A git path cannot contain NUL, so the join is unambiguous.
 */
function changeKey(change: FileChange): string {
  return `${change.kind}\0${change.previousPath ?? ""}\0${change.path}`
}

interface FileRow {
  readonly group: FileGroup
  readonly change: FileChange
  /** Position in the flattened, header-free list the cursor walks. */
  readonly index: number
}

interface FileSection {
  readonly group: FileGroup
  readonly rows: readonly FileRow[]
}

/**
 * The groups that have files, and every file's position in the single flat list the cursor
 * walks. Headers are derived from the sections and are deliberately not rows: a cursor
 * that could land on "Staged" would have nothing to stage.
 *
 * Rows carry the *first* change object seen for their key, so the two rows of an `MM` path
 * hand `useDecoration` one identical object. Two objects in one cache slot evict each
 * other on every render, and a `useSyncExternalStore` snapshot that never repeats itself
 * never converges.
 */
function sectionsOf(status: WorkingTreeStatus): readonly FileSection[] {
  const identities = new Map<string, FileChange>()
  const sections: FileSection[] = []
  let index = 0

  for (const group of groupOrder) {
    const changes = status[group]
    if (changes.length === 0) continue

    const rows: FileRow[] = []
    for (const change of changes) {
      const key = changeKey(change)
      const identity = identities.get(key) ?? change
      identities.set(key, identity)
      rows.push({ group, change: identity, index })
      index += 1
    }
    sections.push({ group, rows })
  }
  return sections
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

function discardPlan(change: FileChange, status: WorkingTreeStatus): DiscardPlan {
  const own = pathsOf(change)
  if (change.kind === "untracked") return { outcome: "delete", paths: own }

  const owned = new Set(own)
  const staged = status.staged.find((entry) => pathsOf(entry).some((path) => owned.has(path)))
  if (staged === undefined) return { outcome: "restore", paths: own }

  // The staged entry's own paths join the plan: unstaging one half of a staged rename would
  // leave the other half in the index and the file looking half-moved.
  const paths = [...new Set([...own, ...pathsOf(staged)])]
  return { outcome: staged.kind === "added" ? "unstageAndDelete" : "unstageAndRestore", paths }
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

const isConflicted = (change: FileChange): boolean => change.kind === "conflicted"
const isNotConflicted = (change: FileChange): boolean => !isConflicted(change)

/** "1 file" / "3 files", so a confirmation reads as a sentence rather than as `1 file(s)`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

export default defineExtension({
  name: "files",
  description: "Working-tree, staged, untracked, and conflicted file changes",
  needs: ["diff"],

  activate(ctx): FilesApi {
    const host = createRowSource<FileChange>({ key: changeKey })
    const diff = ctx.extensions.get("diff")

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
     * `space` reads the group, not the kind: one `modified` change appears in both the
     * staged and the unstaged group, and only the group it was drawn under says which way
     * this keypress moves it. Staging a conflicted file is how git records a resolution,
     * which is the whole of v1's conflict write path (§5.12).
     */
    async function toggleStage(row: FileRow | undefined): Promise<void> {
      if (row === undefined) return
      if (row.group === "staged") await unstage(row.change)
      else await stage([row.change.path])
    }

    async function discard(change: FileChange): Promise<void> {
      const plan = discardPlan(change, ctx.git.state.status)
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
     * Working-tree changes only. `ctx.git.discard` restores a tracked file *from the
     * index*, so staged content is exactly what survives; unstaging first would be a
     * bigger and differently destructive operation than the label promises. Conflicted
     * paths are left out because resolving them belongs to the user's editor (§5.12).
     */
    async function discardAll(): Promise<void> {
      const status = ctx.git.state.status
      const paths = [...status.unstaged, ...status.untracked].map((change) => change.path)
      if (paths.length === 0) {
        ctx.popups.notify("No working-tree changes to discard")
        return
      }

      const untracked = status.untracked.length
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
    async function openFile(change: FileChange): Promise<void> {
      try {
        await ctx.open(`${ctx.git.root}/${change.path}`)
      } catch (error) {
        fail("Open", error)
      }
    }

    async function openMenu(row: FileRow | undefined): Promise<void> {
      if (row === undefined) {
        ctx.popups.notify("No file selected")
        return
      }
      await ctx.menus.open("files.actions", row.change)
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
              // An untracked file is not in the index, so there is nothing to take out of it.
              when: (change) => isNotConflicted(change) && change.kind !== "untracked",
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

    function FileLine({
      row,
      id,
      selected,
      focused,
    }: {
      readonly row: FileRow
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
    }) {
      const theme = useTheme()
      const decoration = host.useDecoration(row.change)
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} bg={selected && focused ? theme.selection : undefined}>
          {/* The marker, not the highlight, is what says where the cursor is while another
              Pane holds focus — the state in which the diff on screen is still this Pane's
              selection and the user needs to see which row that was. */}
          <span fg={theme.textMuted}>{selected ? "❯ " : "  "}</span>
          <span fg={dim ? theme.textMuted : theme[kindTokens[row.change.kind]]}>{kindGlyphs[row.change.kind]}</span>
          <span fg={dim ? theme.textMuted : theme.text}>{` ${labelOf(row.change)}`}</span>
          <span fg={toneColor(theme, decoration?.tone)}>{badge === undefined ? "" : ` ${badge}`}</span>
        </text>
      )
    }

    function FilesPane({ focused }: PaneProps) {
      const theme = useTheme()
      const status = useGit((state) => state.status)
      const repository = useGit((state) => inRepository(state.head))
      // Memoised on the store slice's own identity: a refresh that changed nothing hands
      // back the same object, so the rows — and with them every decoration cache hit and
      // the effects below — survive the poll untouched.
      const sections = useMemo(() => sectionsOf(status), [status])
      const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections])
      const cursor = useListCursor({ items: rows, idPrefix: "files", noun: "file" })
      const selected = cursor.selected

      useEffect(() => {
        host.setSelected(selected?.change)
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
        diff.show(
          selected === undefined
            ? null
            : { kind: selected.group === "staged" ? "staged" : "workingTree", path: selected.change.path },
        )
      }, [focused, selected])

      useCommand({
        id: "files.toggle-stage",
        title: "Stage / unstage file",
        keys: "space",
        run: () => toggleStage(selected),
      })
      useCommand({ id: "files.stage-all", title: "Stage all files", keys: "a", run: () => stage("all") })
      useCommand({
        id: "files.discard",
        title: "Discard changes to file",
        keys: "d",
        run: () => (selected === undefined ? undefined : discard(selected.change)),
      })
      useCommand({
        id: "files.open",
        title: "Open file in default application",
        keys: "e",
        run: () => (selected === undefined ? undefined : openFile(selected.change)),
      })
      useCommand({ id: "files.menu", title: "File actions", keys: "x", run: () => openMenu(selected) })

      // Outside a repository there is no working tree to be clean, and saying it is clean
      // would report a healthy, fully committed repository where there is none at all.
      if (!repository) return <text fg={theme.textMuted} content="no repository" />

      // A clean tree is an answer, not an absence: an empty box would read as a Pane that
      // failed to load.
      if (rows.length === 0) return <text fg={theme.textMuted} content="working tree clean" />

      return (
        // Not focusable: OpenTUI has a single focus slot, and laziergit's own focus model
        // decides which Pane's keys are live, so a Pane claiming the renderer's focus would
        // only take it away from the popup layer's inputs.
        //
        // `flexBasis={0}` alongside `flexGrow`, or the box's flex size is its *content*
        // height: a list longer than the Pane makes the box taller than the Pane, which
        // paints over the Pane above it instead of scrolling inside its own frame.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {sections.map((section) => (
            <box key={section.group} flexDirection="column">
              <text fg={theme.textMuted} content={groupTitles[section.group]} />
              {section.rows.map((row) => (
                <FileLine
                  key={`${row.group}\0${row.change.path}`}
                  id={cursor.rowId(row.index)}
                  row={row}
                  selected={row.index === cursor.index}
                  focused={focused}
                />
              ))}
            </box>
          ))}
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
      keys: "2",
      run: () => pane.focus(),
    })

    return host.api
  },
})
