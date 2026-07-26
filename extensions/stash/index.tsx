/** @jsxImportSource @opentui/react */
import {
  createRowSource,
  defineExtension,
  describeGitFailure,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type PaneProps,
  type StashApi,
  type StashEntry,
} from "laziergit"
import { useEffect } from "react"

/** The only name git gives an entry, and the operand every stash verb takes. */
function stashRef(entry: StashEntry): string {
  return `stash@{${entry.index}}`
}

function branchNameProblem(value: string): string | null {
  const name = value.trim()
  if (name === "") return "Enter a branch name"
  // `git stash branch` has no `--` to end its options, so a leading dash would be read as
  // one and the ref behind it silently misinterpreted.
  if (name.startsWith("-")) return "A branch name cannot start with a dash"
  return null
}

export default defineExtension({
  name: "stash",
  description: "Stash entries",
  needs: ["diff"],

  activate(ctx): StashApi {
    // The index is the only name git gives a stash entry, and `stash@{n}` is that index
    // spelled out — so the number is the slot, renumbered along with the rows on a drop.
    const rows = createRowSource<StashEntry>({ key: (row) => String(row.index) })
    const diff = ctx.extensions.get("diff")

    /**
     * Every git write goes through here. A stash verb refuses for reasons this Extension
     * cannot predict — unmerged paths, a dirty tree an apply would clobber — and git's own
     * stderr is the only text that explains which one it was.
     */
    async function attempt(action: () => Promise<unknown>): Promise<void> {
      try {
        await action()
      } catch (error) {
        ctx.popups.notify(describeGitFailure(error), "error")
      }
    }

    /**
     * The entry as the store sees it *now*, or `undefined` once it is gone.
     *
     * Matched on `oid`, the one name a stash entry keeps across a renumber. The captured
     * index is tried first because it is exact where oids are not: identical content stashed
     * twice within the same second is literally one commit object, and then the slot the
     * user pointed at is a better answer than the first entry that happens to share it.
     */
    function current(entry: StashEntry): StashEntry | undefined {
      const entries = ctx.git.state.stash
      const atIndex = entries[entry.index]
      if (atIndex?.oid === entry.oid) return atIndex
      return entries.find((candidate) => candidate.oid === entry.oid)
    }

    // Every action takes the entry it is acting on rather than re-reading the selection —
    // but the index that entry carries is only ever a snapshot. `stash@{n}` is a slot, not a
    // name: any push or drop renumbers everything below it, and one can land while a confirm
    // or a prompt is on screen, from another window or a plain shell (which is the whole
    // reason the store polls). So a write is aimed with {@link current}, immediately before
    // it runs, and refuses rather than acting on whichever entry inherited the slot.
    async function write(entry: StashEntry, action: (target: StashEntry) => Promise<unknown>): Promise<void> {
      const target = current(entry)
      if (target === undefined) {
        ctx.popups.notify(`${entry.message} is no longer in the stash list`, "warning")
        return
      }
      await attempt(() => action(target))
    }

    const apply = (entry: StashEntry): Promise<void> => write(entry, (target) => ctx.git.stash.apply(target.index))
    const pop = (entry: StashEntry): Promise<void> => write(entry, (target) => ctx.git.stash.pop(target.index))

    async function drop(entry: StashEntry): Promise<void> {
      const confirmed = await ctx.popups.confirm({
        title: `Drop ${stashRef(entry)}?`,
        // The message as well as the ref: after the drop the refs renumber, so the text is
        // the only part of the row that still says what was thrown away.
        message: entry.message,
        confirmLabel: "drop",
        danger: true,
      })
      if (confirmed) await write(entry, (target) => ctx.git.stash.drop(target.index))
    }

    async function branchFrom(entry: StashEntry): Promise<void> {
      const name = await ctx.popups.prompt({
        title: `Branch from ${stashRef(entry)}`,
        placeholder: "branch name",
        validate: branchNameProblem,
      })
      if (name === undefined) return
      // One verb rather than branch-then-apply-then-drop: git drops the entry only once the
      // branch exists and the stash applied cleanly, so a conflict leaves it recoverable.
      // It does drop it, though, which is why this is aimed like every other write.
      await write(entry, (target) => ctx.git.raw(["stash", "branch", name.trim(), stashRef(target)]))
    }

    /** The `s` key in the files Pane: compose a message, then stash what is there. */
    async function save(): Promise<void> {
      const status = ctx.git.state.status
      // One entry per path, so a file staged *and* edited counts once — the old sum over
      // three arrays counted it twice and could claim there was something to stash from a
      // pair of arrays describing the same file.
      const tracked = status.files.filter((file) => isStaged(file) || isUnstaged(file) || isConflicted(file)).length
      const untrackedCount = status.files.filter(isUntracked).length
      if (tracked === 0 && untrackedCount === 0) {
        ctx.popups.notify("Nothing to stash — the working tree is clean", "warning")
        return
      }

      const message = await ctx.popups.prompt({ title: "Stash message", placeholder: "leave empty for git's default" })
      if (message === undefined) return

      // Untracked files are opt-in because `git stash` leaves them alone by default, and a
      // stash that swept away a file git was never told about is one the user has no reason
      // to think of looking in.
      const untracked = untrackedCount
      const includeUntracked =
        untracked > 0 &&
        (await ctx.popups.confirm({
          title: "Include untracked files?",
          message: `${untracked} untracked file${untracked === 1 ? "" : "s"} would be stashed too`,
          confirmLabel: "include",
        }))

      // Declining leaves git nothing to stash, and it would answer "No local changes to
      // save" — true, but a puzzle after two popups that implied otherwise.
      if (tracked === 0 && !includeUntracked) {
        ctx.popups.notify("Nothing to stash — the only changes are untracked files", "warning")
        return
      }

      const trimmed = message.trim()
      await attempt(() => ctx.git.stash.save({ message: trimmed === "" ? undefined : trimmed, includeUntracked }))
    }

    function StashRow({
      entry,
      id,
      selected,
      focused,
    }: {
      readonly entry: StashEntry
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(entry)
      const dim = decoration?.dim === true

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined}>
          {/* The marker, not the highlight, is what says where the cursor is while another
              Pane holds focus — the state in which the diff on screen is still this Pane's
              selection and the user needs to see which row that was. */}
          <span fg={theme.textMuted}>{selected ? "❯ " : "  "}</span>
          <span fg={dim ? theme.textMuted : theme.accent}>{stashRef(entry)}</span>
          <span fg={dim ? theme.textMuted : theme.text}>{` ${entry.message}`}</span>
          {/* Absent for a stash taken on a detached HEAD, where git recorded no branch. */}
          {entry.branch === null ? null : <span fg={theme.textMuted}>{` on ${entry.branch}`}</span>}
          {decoration?.badge === undefined ? null : (
            <span fg={toneColor(theme, decoration.tone)}>{` ${decoration.badge}`}</span>
          )}
        </text>
      )
    }

    function StashPane({ focused }: PaneProps) {
      const theme = useTheme()
      const entries = useGit((state) => state.stash)
      const cursor = useListCursor({ items: entries, idPrefix: "stash", noun: "stash" })
      const selected = cursor.selected

      useEffect(() => {
        rows.setSelected(selected)
        // Cleared on unmount, not merely replaced on the next move: a Pane the Layout has
        // hidden has no selection, and `StashApi.selected()` must not keep naming the row it
        // had when it went away — a consumer acting on that row would act on nothing the
        // user can see.
        return () => rows.setSelected(undefined)
      }, [selected])

      // Keyed on the entry, not the index: the store keeps an unchanged row referentially
      // stable, so the poll cannot make this re-push a target the diff Pane already shows.
      // Only while focused — two list Panes both pushing would fight over the diff.
      useEffect(() => {
        if (!focused) return
        // `null` once the last entry is dropped: the ref this Pane last named no longer
        // resolves, and a diff Pane still drawing it would be showing a stash that is gone.
        diff.show(selected === undefined ? null : { kind: "stash", ref: stashRef(selected), path: null })
      }, [focused, selected])

      // A selection is empty only when the list is, and the empty state below already says so
      // — a toast would repeat it, so every key with nothing to act on is a silent no-op. The
      // same rule in the files, branches and commits Panes.
      useCommand({
        id: "stash.apply",
        title: "Apply stash",
        hint: "apply",
        keys: "space",
        run: async () => {
          if (selected !== undefined) await apply(selected)
        },
      })
      useCommand({
        id: "stash.pop",
        title: "Pop stash",
        hint: "pop",
        // Pane-scoped `p` while `sync` binds a global `p` for pull. Not a collision to fix:
        // the Pane layer (priority 100) shadows the global one (0) exactly while this Pane
        // is focused, so `p` here is the stash you are looking at and `p` anywhere else is
        // still a pull.
        keys: "p",
        run: async () => {
          if (selected !== undefined) await pop(selected)
        },
      })
      useCommand({
        id: "stash.drop",
        title: "Drop stash",
        hint: "drop",
        keys: "d",
        run: async () => {
          if (selected !== undefined) await drop(selected)
        },
      })
      useCommand({
        id: "stash.menu",
        title: "Stash actions",
        hint: "menu",
        keys: "x",
        run: async () => {
          if (selected !== undefined) await ctx.menus.open("stash.actions", selected)
        },
      })

      if (entries.length === 0) return <text fg={theme.textMuted}>no stashes</text>

      return (
        // `flexBasis={0}` is not decoration: without it the box's flex size is its *content*
        // height, so a long stash list makes it taller than the Pane and it paints over the
        // Pane's own header instead of scrolling inside it. `scrollRef` is what keeps the
        // selected row — the row every key acts on — inside the viewport.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {entries.map((entry, index) => (
            // Keyed by ref rather than oid: two stashes of identical content on the same
            // second are the same commit object, and the index is unique by construction.
            <StashRow
              key={stashRef(entry)}
              id={cursor.rowId(index)}
              entry={entry}
              selected={index === cursor.index}
              focused={focused}
            />
          ))}
        </scrollbox>
      )
    }

    const pane = ctx.panes.register({
      id: "stash",
      title: "Stash",
      component: StashPane,
      placement: { column: 0, order: 50 },
    })

    ctx.commands.register({
      id: "stash.focus",
      title: "Focus stash",
      keys: "4",
      run: () => pane.focus(),
    })

    ctx.commands.register({
      id: "stash.save",
      title: "Stash changes",
      hint: "stash",
      keys: "s",
      // Bound inside a Pane another Extension owns. Bindings key on the Pane id rather than
      // on the registering Extension, so this needs no `needs` edge: with no files Pane
      // loaded the Command is simply never live (§5.8).
      pane: "files",
      run: save,
    })

    ctx.menus.register({
      id: "stash.actions",
      title: (entry) => `${stashRef(entry)} ${entry.message}`,
      groups: [
        {
          id: "stash",
          items: [
            { key: "a", label: "Apply", run: apply },
            { key: "p", label: "Pop", run: pop },
            { key: "d", label: "Drop", run: drop },
            { key: "b", label: "Create branch from this stash", run: branchFrom },
          ],
        },
      ],
    })

    return rows.api
  },
})
