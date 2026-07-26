/** @jsxImportSource @opentui/react */
import {
  createRowSource,
  defineExtension,
  describeGitFailure,
  remoteWebUrl,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type Commit,
  type CommitsApi,
  type Head,
  type PaneProps,
} from "laziergit"
import { useEffect } from "react"

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const week = 7 * day
/** Calendar months and years vary; a log row wants a stable ruler more than an exact one. */
const month = 30 * day
const year = 365 * day

/**
 * One unit, no "ago" — a log row has room for two or three columns and the age is the
 * least of them. A commit dated in the future (clock skew, or a rebase that kept an author
 * date) is clamped rather than rendered as "-3m", which reads as a bug in laziergit.
 */
function relativeAge(authoredAt: number, now: number): string {
  const elapsed = Math.max(0, now - authoredAt)
  if (elapsed < minute) return "now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  if (elapsed < week) return `${Math.floor(elapsed / day)}d`
  if (elapsed < month) return `${Math.floor(elapsed / week)}w`
  if (elapsed < year) return `${Math.floor(elapsed / month)}mo`
  return `${Math.floor(elapsed / year)}y`
}

/** Git's own definition of a merge, and the only one the store carries. */
function isMerge(commit: Commit): boolean {
  return commit.parents.length > 1
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** The three ways `git reset` treats the index and the working tree it leaves behind. */
type ResetMode = "soft" | "mixed" | "hard"

/**
 * Why there is no log to draw. The three read identically as "zero rows" and mean entirely
 * different things — telling an unborn HEAD from no repository is what keeps the empty
 * state from promising a first commit in a directory git has never heard of.
 */
type EmptyReason = "noRepository" | "unborn" | "loaded"

function emptyReason(head: Head): EmptyReason {
  if (head.kind === "noRepository") return "noRepository"
  return head.kind === "unborn" ? "unborn" : "loaded"
}

export default defineExtension({
  name: "commits",
  description: "Commit log for the current branch",
  needs: ["diff"],

  activate(ctx): CommitsApi {
    const diff = ctx.extensions.get("diff")
    // The full oid, not the short one: abbreviation length varies with repository size, so
    // the short form is a rendering choice rather than an identity.
    const rows = createRowSource<Commit>({ key: (row) => row.oid })

    /** `GitError` carries git's own words, and they beat anything this Extension could invent. */
    function report(error: unknown): void {
      ctx.popups.notify(describeGitFailure(error), "error")
    }

    async function attempt(done: string, action: () => Promise<unknown>): Promise<void> {
      try {
        await action()
        ctx.popups.notify(done, "success")
      } catch (error) {
        report(error)
      }
    }

    async function confirmThen(
      ask: { title: string; message: string; confirmLabel?: string; danger?: boolean },
      done: string,
      action: () => Promise<unknown>,
    ): Promise<void> {
      if (!(await ctx.popups.confirm(ask))) return
      await attempt(done, action)
    }

    /**
     * `--no-edit` because laziergit owns the terminal: without it git spawns the user's
     * editor onto a screen this process is drawing, and neither survives the encounter.
     *
     * `revert` has no porcelain helper, so it goes through `ctx.git.raw` — §1.5's sanctioned
     * escape hatch, not a privilege a Bundled Extension holds. `raw` is public API, it
     * classifies the subcommand as mutating, and so it refreshes the store afterwards exactly
     * as a helper would. `reset` reaches for it for the same reason.
     */
    function revert(commit: Commit): Promise<unknown> {
      return ctx.git.raw(["revert", "--no-edit", commit.oid])
    }

    /**
     * Names what a reset costs, in the currencies the chosen mode actually spends. They are
     * listed separately because they are not equally recoverable — the commits survive in the
     * reflog, the working-tree changes only a hard reset takes are simply gone — and each is
     * omitted when it is zero, so the warning never inflates itself with losses that are not
     * on the table.
     *
     * Soft and mixed have a warning at all because all three modes move the branch ref, and
     * so all three drop every commit between HEAD and the target onto the reflog and nothing
     * else. That the working tree survives makes soft and mixed *quieter*, not safe.
     */
    function resetLoss(commit: Commit, mode: ResetMode): string {
      const { status, commits } = ctx.git.state
      // Untracked files survive every reset, so counting them here would overstate the loss.
      const dirty = status.staged.length + status.unstaged.length
      const dropped = Math.max(
        0,
        commits.findIndex((candidate) => candidate.oid === commit.oid),
      )

      const losses: string[] = []
      if (mode === "hard" && dirty > 0) losses.push(`${plural(dirty, "uncommitted change")} destroyed for good`)
      // Mixed rewrites the index but not the files, so this line names a nuisance rather than
      // a loss — and naming it as one is the point: a user who staged a hunk by hand is about
      // to lose that arrangement, and nothing else on this list would have told them.
      if (mode === "mixed" && status.staged.length > 0) {
        losses.push(`${plural(status.staged.length, "staged change")} unstaged, though kept in the working tree`)
      }
      if (dropped > 0) losses.push(`${plural(dropped, "commit")} off this branch, left only in the reflog`)
      if (losses.length === 0) return `HEAD is already at ${commit.shortOid}, so nothing is lost.`
      return `${losses.join(". ")}.`
    }

    function runReset(commit: Commit, mode: ResetMode): Promise<void> {
      const done = `Reset ${mode} to ${commit.shortOid}`
      return confirmThen(
        {
          title: done,
          message: resetLoss(commit, mode),
          // `danger` stays the hard reset's alone. It is the only mode that spends something
          // the reflog cannot hand back, and painting all three red would leave the styling
          // saying nothing about which one is which.
          danger: mode === "hard",
        },
        done,
        () => ctx.git.raw(["reset", `--${mode}`, commit.oid]),
      )
    }

    ctx.menus.register({
      id: "commits.actions",
      title: (commit) => `Commit ${commit.shortOid}`,
      groups: [
        {
          id: "commit",
          title: "Commit",
          items: [
            {
              key: "c",
              label: "Check out this commit",
              run: (commit) =>
                confirmThen(
                  {
                    title: "Check out commit",
                    message:
                      `HEAD will be detached at ${commit.shortOid}. Commits made from there belong to no ` +
                      `branch until you create one.`,
                    confirmLabel: "detach HEAD",
                  },
                  `HEAD detached at ${commit.shortOid}`,
                  () => ctx.git.checkout(commit.oid),
                ),
            },
            {
              key: "v",
              label: "Revert this commit",
              // Merges are hidden rather than offered and then refused: `git revert` rejects a
              // merge outright without `-m`, so without this the confirmation promises an undo
              // that git will never perform. The alternative — asking which parent is the
              // mainline — is declined for v1: the answer is unreadable from a flat log (the
              // Pane draws no topology), and picking the wrong side produces a commit whose
              // effect is the opposite of the one asked for, on top of the standing trap that
              // a reverted merge blocks the branch from ever merging again until the revert is
              // itself reverted. §1.9 hides what cannot apply, the same rule the remote item
              // below uses.
              when: (commit) => !isMerge(commit),
              run: (commit) =>
                confirmThen(
                  {
                    title: "Revert commit",
                    message: `A new commit on top of HEAD will undo ${commit.shortOid} — ${commit.subject}.`,
                    confirmLabel: "revert",
                  },
                  `Reverted ${commit.shortOid}`,
                  () => revert(commit),
                ),
            },
            {
              key: "o",
              label: "Open this commit on the remote",
              // Hidden rather than inert when there is nothing to open: a `file://` remote
              // or a sibling clone has no web page, and §1.9 hides what cannot apply.
              when: () => remoteWebUrl(ctx.git.state.remotes) !== null,
              run: async (commit) => {
                const base = remoteWebUrl(ctx.git.state.remotes)
                // `when` already hid the item; re-reading keeps a null out of the URL if the
                // remote went away between opening the menu and pressing the key.
                if (base === null) return ctx.popups.notify("No web remote configured", "warning")
                // GitHub's path, which GitLab and Gitea share — the same bet §0 makes for
                // the repository root.
                await ctx.open(`${base}/commit/${commit.oid}`)
              },
            },
            {
              key: "y",
              label: "Copy the full oid",
              // The full oid, not the short one: what you paste into another tool has to
              // still resolve when the repository grows and the abbreviation lengthens.
              run: (commit) => attempt(`Copied ${commit.shortOid}`, () => ctx.copy(commit.oid)),
            },
          ],
        },
        {
          id: "reset",
          title: "Move this branch here",
          items: [
            {
              key: "s",
              label: "Reset soft — keep the index and the working tree",
              run: (commit) => runReset(commit, "soft"),
            },
            {
              key: "m",
              label: "Reset mixed — keep the working tree, clear the index",
              run: (commit) => runReset(commit, "mixed"),
            },
            {
              key: "h",
              label: "Reset hard — discard everything since",
              run: (commit) => runReset(commit, "hard"),
            },
          ],
        },
      ],
    })

    function CommitRow({
      commit,
      id,
      now,
      selected,
      focused,
    }: {
      readonly commit: Commit
      readonly id: string
      readonly now: number
      readonly selected: boolean
      readonly focused: boolean
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(commit)
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} bg={selected && focused ? theme.selection : undefined}>
          {/* The marker, not the highlight, is what says where the cursor is while another
              Pane holds focus — the state in which the diff on screen is still this Pane's
              selection and the user needs to see which row that was. */}
          <span fg={theme.textMuted}>{selected ? "❯ " : "  "}</span>
          <span fg={dim ? theme.textMuted : theme.accent}>{commit.shortOid}</span>
          {/* A fixed-width gutter, so the merge marker reads as a column instead of shifting
              every merge row's subject one place right. */}
          <span fg={dim ? theme.textMuted : theme.info}>{isMerge(commit) ? " ⑂ " : "   "}</span>
          <span fg={dim ? theme.textMuted : theme.text}>{commit.subject}</span>
          <span fg={theme.textMuted}>{`  ${commit.author.name}  ${relativeAge(commit.authoredAt, now)}`}</span>
          {badge === undefined ? null : <span fg={toneColor(theme, decoration?.tone)}>{`  ${badge}`}</span>}
        </text>
      )
    }

    function CommitsPane({ focused }: PaneProps) {
      const theme = useTheme()
      const commits = useGit((state) => state.commits)
      const empty = useGit((state) => emptyReason(state.head))
      const cursor = useListCursor({ items: commits, idPrefix: "commits", noun: "commit" })
      const selected = cursor.selected
      // One clock for the whole render, so two rows a millisecond apart never disagree.
      const now = Date.now()

      useEffect(() => {
        rows.setSelected(selected)
        // Cleared on unmount, not only replaced on the next move: a Pane the Layout has
        // hidden has no selection, and `CommitsApi.selected()` must not keep naming the row
        // it had when it went away.
        return () => rows.setSelected(undefined)
      }, [selected])

      useEffect(() => {
        // Only while focused: the diff follows the Pane you are looking at, so an unfocused
        // list must not yank it away from the one that is.
        if (!focused || selected === undefined) return
        diff.show({ kind: "commit", ref: selected.oid, path: null })
      }, [focused, selected])

      // A selection is empty only when the list is, and the empty state below already says so
      // — a toast would repeat it, so a key with nothing to act on is a silent no-op. The same
      // rule in the files, branches and stash Panes.
      useCommand({
        id: "commits.menu",
        title: "Commit actions",
        hint: "menu",
        keys: "x",
        run: async () => {
          if (selected === undefined) return
          await ctx.menus.open("commits.actions", selected)
        },
      })

      if (commits.length === 0) {
        // Neither an error nor a slow load — but which of the three it is decides whether the
        // user is being told to make a commit or told that there is nowhere to make one. The
        // no-repository wording is the status Pane's, word for word, because the two sit in
        // the same column and disagreeing about it would read as one of them being wrong.
        const message =
          empty === "noRepository"
            ? "no repository"
            : empty === "unborn"
              ? "no commits yet — your first commit will appear here"
              : "no commits to show"
        return <text fg={theme.textMuted} content={message} />
      }

      const last = commits[commits.length - 1]
      // The store's window is bounded by `git.commitLimit`, and the last row still having a
      // parent is the only honest evidence that history continues past it — a root commit
      // there means the log really did end. Paging deeper is `ctx.git.raw(["log", ...])`,
      // and deliberately not this Pane's job.
      const truncated = last !== undefined && last.parents.length > 0

      return (
        // `flexBasis={0}` on both, or the box is sized by its *content*: 200 rows make a
        // 200-row-tall scrollbox that overflows the Pane and paints across the Pane above it,
        // instead of a Pane-tall window that scrolls. `scrollRef` is what keeps the cursor —
        // which every key acts on — inside that window.
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
            {commits.map((commit, index) => (
              <CommitRow
                key={commit.oid}
                id={cursor.rowId(index)}
                commit={commit}
                now={now}
                selected={index === cursor.index}
                focused={focused}
              />
            ))}
          </scrollbox>
          {truncated && cursor.index === commits.length - 1 ? (
            <text fg={theme.textMuted} content={`${commits.length} shown; raise git.commitLimit for more`} />
          ) : null}
        </box>
      )
    }

    const pane = ctx.panes.register({
      id: "commits",
      title: "Commits",
      component: CommitsPane,
      placement: { column: 0, order: 40 },
    })

    ctx.commands.register({
      id: "commits.focus",
      title: "Focus commits",
      keys: "4",
      run: () => pane.focus(),
    })

    return rows.api
  },
})
