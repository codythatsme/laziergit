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
  useGit,
  useListCursor,
  useTheme,
  type PaneProps,
  type StashSaveOptions,
  type StashApi,
  type StashEntry,
} from "laziergit"
import { useEffect } from "react"

function stashRef(entry: StashEntry): string {
  return `stash@{${entry.index}}`
}

function stashLabel(entry: StashEntry): string {
  return `${entry.message}${entry.branch === null ? "" : ` on ${entry.branch}`}`
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
    const rows = createRowSource<StashEntry>({ pane: "stash", key: (row) => String(row.index) })
    const diff = ctx.extensions.get("diff")

    async function attempt(action: () => Promise<unknown>): Promise<void> {
      try {
        await action()
      } catch (error) {
        ctx.popups.notify(describeGitFailure(error), "error")
      }
    }

    /**
     * The entry as the store sees it now, or `undefined` once it is gone. Matched on `oid`,
     * the one name that survives a renumber — but the captured index is tried first, since
     * identical content stashed twice in one second is a single commit object.
     */
    function current(entry: StashEntry): StashEntry | undefined {
      const entries = ctx.git.state.stash
      const atIndex = entries[entry.index]
      if (atIndex?.oid === entry.oid) return atIndex
      return entries.find((candidate) => candidate.oid === entry.oid)
    }

    // `stash@{n}` is a slot, not a name: any push or drop renumbers everything below it, and
    // one can land from another shell while a confirm is on screen. So a write is re-aimed
    // with {@link current} immediately before it runs, and refuses if the entry is gone.
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
        title: "Drop stash?",
        message: stashLabel(entry),
        confirmLabel: "drop",
        danger: true,
      })
      if (confirmed) await write(entry, (target) => ctx.git.stash.drop(target.index))
    }

    async function branchFrom(entry: StashEntry): Promise<void> {
      const name = await ctx.popups.prompt({
        title: `Branch from ${stashLabel(entry)}`,
        placeholder: "branch name",
        validate: branchNameProblem,
      })
      if (name === undefined) return
      // One verb rather than branch-then-apply-then-drop: git drops the entry only once the
      // branch exists and the stash applied cleanly, so a conflict leaves it recoverable.
      await write(entry, (target) => ctx.git.raw(["stash", "branch", name.trim(), stashRef(target)]))
    }

    /** The `s` key in the files Pane: compose a message, then stash what is there. */
    async function save(): Promise<void> {
      const status = ctx.git.state.status
      const tracked = status.files.filter((file) => isStaged(file) || isUnstaged(file) || isConflicted(file)).length
      const untrackedCount = status.files.filter(isUntracked).length
      if (tracked === 0 && untrackedCount === 0) {
        ctx.popups.notify("Nothing to stash — the working tree is clean", "warning")
        return
      }

      const message = await ctx.popups.prompt({ title: "Stash message", placeholder: "leave empty for git's default" })
      if (message === undefined) return

      // Opt-in, because `git stash` leaves untracked files alone by default.
      const untracked = untrackedCount
      const includeUntracked =
        untracked > 0 &&
        (await ctx.popups.confirm({
          title: "Include untracked files?",
          message: `${untracked} untracked file${untracked === 1 ? "" : "s"} would be stashed too`,
          confirmLabel: "include",
        }))

      // Declining leaves git nothing to stash, and its own wording would be a puzzle here.
      if (tracked === 0 && !includeUntracked) {
        ctx.popups.notify("Nothing to stash — the only changes are untracked files", "warning")
        return
      }

      const trimmed = message.trim()
      await attempt(() => ctx.git.stash.save({ message: trimmed === "" ? undefined : trimmed, includeUntracked }))
    }

    async function saveFromMenu(opts: StashSaveOptions): Promise<void> {
      const message = await ctx.popups.prompt({ title: "Stash changes", placeholder: "leave empty for git's default" })
      if (message === undefined) return
      const trimmed = message.trim()
      const entered = trimmed === "" ? undefined : trimmed
      await attempt(() =>
        opts.mode === "staged" || opts.mode === "unstaged"
          ? ctx.git.stash.save({ mode: opts.mode, message: entered })
          : ctx.git.stash.save({ ...opts, message: entered }),
      )
    }

    function hasTrackedChanges(): boolean {
      return ctx.git.state.status.files.some((file) => isStaged(file) || isUnstaged(file) || isConflicted(file))
    }

    async function saveTracked(opts: StashSaveOptions = {}): Promise<void> {
      if (!hasTrackedChanges()) {
        ctx.popups.notify("You have no files to stash", "warning")
        return
      }
      await saveFromMenu(opts)
    }

    async function saveStaged(): Promise<void> {
      if (!ctx.git.state.status.files.some(isStaged)) {
        ctx.popups.notify("You have no tracked/staged files to stash", "warning")
        return
      }
      await saveFromMenu({ mode: "staged" })
    }

    async function openSaveMenu(): Promise<void> {
      await ctx.popups.menu({
        title: "Stash options",
        groups: [
          {
            items: [
              { key: "a", label: "Stash all changes", run: () => saveTracked() },
              {
                key: "i",
                label: "Stash all changes and keep index",
                run: () => saveTracked({ keepIndex: true }),
              },
              {
                key: "shift+u",
                label: "Stash all changes including untracked files",
                run: () => saveFromMenu({ includeUntracked: true }),
              },
              { key: "s", label: "Stash staged changes", run: saveStaged },
              { key: "u", label: "Stash unstaged changes", run: () => saveTracked({ mode: "unstaged" }) },
            ],
          },
        ],
      })
    }

    ctx.commands.register({
      id: "stash.apply",
      source: rows.api,
      title: "Apply stash",
      hint: "apply",
      keys: "space",
      run: apply,
    })
    ctx.commands.register({
      id: "stash.pop",
      source: rows.api,
      title: "Pop stash",
      hint: "pop",
      keys: "p",
      run: pop,
    })
    ctx.commands.register({
      id: "stash.drop",
      source: rows.api,
      title: "Drop stash",
      hint: "drop",
      keys: "d",
      run: drop,
    })
    ctx.commands.register({
      id: "stash.branch",
      source: rows.api,
      title: "Create branch from this stash",
      keys: "b",
      run: branchFrom,
    })

    function StashRow({
      entry,
      id,
      selected,
      focused,
      onSelect,
    }: {
      readonly entry: StashEntry
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
      readonly onSelect: () => void
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(entry)
      const dim = decoration?.dim === true

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined} onMouseDown={onSelect}>
          <span fg={dim ? theme.textMuted : theme.text}>{entry.message}</span>
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
      const repository = useGit((state) => state.head.kind !== "noRepository")
      const cursor = useListCursor({
        items: entries,
        idPrefix: "stash",
        noun: "stash",
        query: {
          mode: "filter",
          fields: (entry) => [entry.message, entry.branch ?? ""],
        },
      })
      const visibleEntries = cursor.items
      const selected = cursor.selected

      useEffect(() => {
        rows.setSelected(selected)
        return () => rows.setSelected(undefined)
      }, [selected])

      // Keyed on the entry, which the store keeps referentially stable, so the poll cannot
      // re-push a target the diff Pane already shows. Only while focused.
      useEffect(() => {
        if (!focused) return
        diff.show(selected === undefined ? null : { kind: "stash", ref: stashRef(selected), path: null })
      }, [focused, selected])

      if (!repository) return <text fg={theme.textMuted}>no repository here</text>
      if (entries.length === 0) return <text fg={theme.textMuted}>no stashes yet — s in the files Pane saves one</text>
      if (visibleEntries.length === 0) return <text fg={theme.textMuted}>no matching stashes</text>

      return (
        // `flexBasis={0}` sizes the box to the Pane rather than to its content, so a long list
        // scrolls instead of overflowing the frame.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {visibleEntries.map((entry, index) => (
            // Keyed by ref rather than oid: identical content stashed twice is one object.
            <StashRow
              key={stashRef(entry)}
              id={cursor.rowId(index)}
              entry={entry}
              selected={index === cursor.index}
              focused={focused}
              onSelect={() => cursor.setIndex(index)}
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

    // Keyless: core binds `1`–`9` positionally over the Layout.
    ctx.commands.register({
      id: "stash.focus",
      title: "Focus stash",
      run: () => pane.focus(),
    })

    ctx.commands.register({
      id: "stash.save",
      title: "Stash changes",
      hint: "stash",
      keys: "s",
      // A Pane id is a name, not a live object: this needs no `needs`, and is inert without
      // the files Pane loaded.
      pane: "files",
      run: save,
    })
    ctx.commands.register({
      id: "stash.options",
      title: "View stash options",
      keys: "shift+s",
      pane: "files",
      run: openSaveMenu,
    })

    return rows.api
  },
})
