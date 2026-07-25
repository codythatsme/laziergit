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
  type PaneProps,
  type StashApi,
  type StashEntry,
} from "laziergit"
import { useEffect } from "react"

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const week = 7 * day
/** Calendar months and years vary; a list row wants a stable ruler more than an exact one. */
const month = 30 * day
/** Git's own relative dates round a year to 365 days; matching it keeps the two agreeing. */
const year = 365 * day

/**
 * An entry's age in the width a list row can spare: one unit, no "ago". Anything under a
 * minute is "now" rather than "0m", because a stash taken seconds ago reading as zero
 * looks like a missing value.
 *
 * The same ladder as the commits and branches Panes, deliberately: ADR-0001 gives these
 * three no package to share it through, so the copies are kept identical by hand instead —
 * they sit in adjacent Panes, and one saying `13w` where another says `3mo` for the same
 * elapsed time is laziergit contradicting itself on one screen.
 */
function relativeAge(createdAt: number, now: number): string {
  const elapsed = Math.max(0, now - createdAt)
  if (elapsed < minute) return "now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  if (elapsed < week) return `${Math.floor(elapsed / day)}d`
  if (elapsed < month) return `${Math.floor(elapsed / week)}w`
  if (elapsed < year) return `${Math.floor(elapsed / month)}mo`
  return `${Math.floor(elapsed / year)}y`
}

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
      const tracked = status.staged.length + status.unstaged.length + status.conflicted.length
      if (tracked === 0 && status.untracked.length === 0) {
        ctx.popups.notify("Nothing to stash — the working tree is clean", "warning")
        return
      }

      const message = await ctx.popups.prompt({ title: "Stash message", placeholder: "leave empty for git's default" })
      if (message === undefined) return

      // Untracked files are opt-in because `git stash` leaves them alone by default, and a
      // stash that swept away a file git was never told about is one the user has no reason
      // to think of looking in.
      const untracked = status.untracked.length
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
      now,
      selected,
    }: {
      readonly entry: StashEntry
      readonly id: string
      readonly now: number
      readonly selected: boolean
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(entry)

      return (
        <text id={id} bg={selected ? theme.selection : undefined}>
          <span fg={theme.accent}>{stashRef(entry)}</span>
          <span fg={decoration?.dim === true ? theme.textMuted : theme.text}>{` ${entry.message}`}</span>
          {/* Absent for a stash taken on a detached HEAD, where git recorded no branch. */}
          {entry.branch === null ? null : <span fg={theme.textMuted}>{` on ${entry.branch}`}</span>}
          <span fg={theme.textMuted}>{` ${relativeAge(entry.createdAt, now)}`}</span>
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
      // One clock read per frame, so every row in it agrees on what "now" is.
      const now = Date.now()

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

      useCommand({
        id: "stash.apply",
        title: "Apply stash",
        keys: "space",
        run: async () => {
          if (selected !== undefined) await apply(selected)
        },
      })
      useCommand({
        id: "stash.pop",
        title: "Pop stash",
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
        keys: "d",
        run: async () => {
          if (selected !== undefined) await drop(selected)
        },
      })
      useCommand({
        id: "stash.menu",
        title: "Stash actions",
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
              now={now}
              selected={index === cursor.index && focused}
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
      keys: "5",
      run: () => pane.focus(),
    })

    ctx.commands.register({
      id: "stash.save",
      title: "Stash changes",
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
