/** @jsxImportSource @opentui/react */
import {
  createRowSource,
  defineExtension,
  describeGitFailure,
  isStaged,
  isUnstaged,
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

function isMerge(commit: Commit): boolean {
  return commit.parents.length > 1
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

type ResetMode = "soft" | "mixed" | "hard"

/** Why there is no log to draw. All three read as zero rows and mean different things. */
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
    const rows = createRowSource<Commit>({ key: (row) => row.oid })

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

    // `--no-edit`: laziergit owns the terminal, and git would spawn an editor onto it.
    function revert(commit: Commit): Promise<unknown> {
      return ctx.git.raw(["revert", "--no-edit", commit.oid])
    }

    /** What a reset costs, naming only the losses the chosen mode actually spends. */
    function resetLoss(commit: Commit, mode: ResetMode): string {
      const { status, commits } = ctx.git.state
      // Untracked files survive every reset, so counting them would overstate the loss.
      const dirty = status.files.filter((file) => isStaged(file) || isUnstaged(file)).length
      const dropped = Math.max(
        0,
        commits.findIndex((candidate) => candidate.oid === commit.oid),
      )

      const losses: string[] = []
      if (mode === "hard" && dirty > 0) losses.push(`${plural(dirty, "uncommitted change")} destroyed for good`)
      // Mixed keeps the files but clears the index, losing a hand-staged arrangement.
      const stagedCount = status.files.filter(isStaged).length
      if (mode === "mixed" && stagedCount > 0) {
        losses.push(`${plural(stagedCount, "staged change")} unstaged, though kept in the working tree`)
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
          // Hard alone: the only mode that spends something the reflog cannot hand back.
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
              // Merges are hidden: `git revert` rejects one without `-m`, and this Pane draws
              // no topology to choose a mainline from.
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
              when: () => remoteWebUrl(ctx.git.state.remotes) !== null,
              run: async (commit) => {
                const base = remoteWebUrl(ctx.git.state.remotes)
                if (base === null) return ctx.popups.notify("No web remote configured", "warning")
                // GitHub's path, which GitLab and Gitea share.
                await ctx.open(`${base}/commit/${commit.oid}`)
              },
            },
            {
              key: "y",
              label: "Copy the full oid",
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
      selected,
      focused,
    }: {
      readonly commit: Commit
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(commit)
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined}>
          <span fg={dim ? theme.textMuted : theme.accent}>{commit.shortOid}</span>
          {/* A fixed-width gutter, so the merge marker does not shift the subject right. */}
          <span fg={dim ? theme.textMuted : theme.info}>{isMerge(commit) ? "⑂ " : "  "}</span>
          <span fg={dim ? theme.textMuted : theme.text}>{commit.subject}</span>
          {/* Last, because the row clips from the right and the author is the loseable half. */}
          <span fg={theme.textMuted}>{`  ${commit.author.name}`}</span>
          {badge === undefined ? null : <span fg={toneColor(theme, decoration?.tone)}>{`  ${badge}`}</span>}
        </text>
      )
    }

    function CommitsPane({ focused }: PaneProps) {
      const theme = useTheme()
      const commits = useGit((state) => state.commits)
      const empty = useGit((state) => emptyReason(state.head))
      const cursor = useListCursor({
        items: commits,
        idPrefix: "commits",
        noun: "commit",
        query: {
          mode: "search",
          fields: (commit) => [commit.oid, commit.shortOid, commit.subject, commit.author.name, commit.author.email],
        },
      })
      const selected = cursor.selected

      useEffect(() => {
        rows.setSelected(selected)
        return () => rows.setSelected(undefined)
      }, [selected])

      useEffect(() => {
        // Only while focused: the diff belongs to whichever list the user is driving.
        if (!focused || selected === undefined) return
        diff.show({ kind: "commit", ref: selected.oid, path: null })
      }, [focused, selected])

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
        const message =
          empty === "noRepository"
            ? "no repository here"
            : empty === "unborn"
              ? "no commits yet — your first commit will appear here"
              : "no commits to show"
        return <text fg={theme.textMuted} content={message} />
      }

      const last = commits[commits.length - 1]
      // The store's window is bounded by `git.commitLimit`; a last row that still has a parent
      // is the only evidence history continues past it.
      const truncated = last !== undefined && last.parents.length > 0

      return (
        // `flexBasis={0}` on both, or the boxes are sized by their content and overflow the
        // Pane instead of scrolling inside it.
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
            {cursor.items.map((commit, index) => (
              <CommitRow
                key={commit.oid}
                id={cursor.rowId(index)}
                commit={commit}
                selected={index === cursor.index}
                focused={focused}
              />
            ))}
          </scrollbox>
          {truncated && cursor.index === commits.length - 1 ? (
            <text
              wrapMode="none"
              fg={theme.textMuted}
              content={`${commits.length} shown; raise git.commitLimit for more`}
            />
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

    // Keyless: core binds `1`–`9` positionally over the Layout (§1.7).
    ctx.commands.register({
      id: "commits.focus",
      title: "Focus commits",
      run: () => pane.focus(),
    })

    return rows.api
  },
})
