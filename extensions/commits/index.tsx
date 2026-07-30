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
type RewriteAction = "squash" | "drop" | "edit"

/** Why there is no log to draw. All three read as zero rows and mean different things. */
type EmptyReason = "noRepository" | "unborn" | "loaded"

function emptyReason(head: Head): EmptyReason {
  if (head.kind === "noRepository") return "noRepository"
  return head.kind === "unborn" ? "unborn" : "loaded"
}

/**
 * Git runs a sequence editor as a shell command and appends the todo path. Keeping the
 * transformer inside the Bun process avoids a platform-specific sed invocation.
 */
const sequenceEditorProgram = String.raw`
const [oid, action, path] = Bun.argv.slice(1)
const source = await Bun.file(path).text()
let changed = false
const lines = source.split("\n").map((line) => {
  const parsed = /^(\s*)(pick|p)(\s+)([0-9a-f]+)(.*)$/.exec(line)
  if (parsed === null || parsed[4] === undefined || !oid.startsWith(parsed[4])) return line
  if (changed) throw new Error("Commit " + oid + " appears more than once in the rebase todo")
  changed = true
  return (parsed[1] ?? "") + action + (parsed[3] ?? " ") + parsed[4] + (parsed[5] ?? "")
})
if (!changed) throw new Error("Commit " + oid + " was not found in the rebase todo")
await Bun.write(path, lines.join("\n"))
`

function shellWord(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function bunCommand(program: string, args: readonly string[] = []): string {
  return [process.execPath, "-e", program, "--", ...args].map(shellWord).join(" ")
}

const noOpEditor = bunCommand("void 0")

export default defineExtension({
  name: "commits",
  description: "Commit log for the current branch",
  needs: ["diff", "commit-flow"],

  activate(ctx): CommitsApi {
    const diff = ctx.extensions.get("diff")
    const commitFlow = ctx.extensions.get("commit-flow")
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

    function firstParentChain(): readonly Commit[] {
      const head = ctx.git.state.head
      if (head.kind !== "onBranch") return []

      const byOid = new Map(ctx.git.state.commits.map((commit) => [commit.oid, commit]))
      const chain: Commit[] = []
      let oid: string | undefined = head.oid
      while (oid !== undefined) {
        const commit = byOid.get(oid)
        if (commit === undefined) break
        chain.push(commit)
        oid = commit.parents[0]
      }
      return chain
    }

    function canRewrite(commit: Commit): boolean {
      return !isMerge(commit) && firstParentChain().some((candidate) => candidate.oid === commit.oid)
    }

    function canSquash(commit: Commit): boolean {
      return canRewrite(commit) && commit.parents.length === 1
    }

    function canDrop(commit: Commit): boolean {
      if (!canRewrite(commit)) return false
      return commit.parents.length > 0 || firstParentChain().length > 1
    }

    async function refExists(ref: string): Promise<boolean> {
      const output = await ctx.git.raw(["rev-parse", "--verify", "--quiet", ref], { allowFailure: true })
      return output.exitCode === 0
    }

    async function rewriteReady(commit: Commit): Promise<boolean> {
      if (!canRewrite(commit)) {
        ctx.popups.notify("Only non-merge commits on the checked-out branch can be rewritten", "warning")
        return false
      }
      if (!ctx.git.state.status.isClean) {
        ctx.popups.notify("Commit rewrites need a clean working tree; stash or commit your changes first", "warning")
        return false
      }

      const refs = ["REBASE_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] as const
      if ((await Promise.all(refs.map(refExists))).some(Boolean)) {
        ctx.popups.notify("Finish or abort the current Git operation before rewriting commits", "warning")
        return false
      }
      return true
    }

    function editorEnv(commit: Commit, action: RewriteAction): Readonly<Record<string, string>> {
      return {
        GIT_EDITOR: noOpEditor,
        GIT_SEQUENCE_EDITOR: bunCommand(sequenceEditorProgram, [commit.oid, action]),
      }
    }

    function continueEnv(): Readonly<Record<string, string>> {
      return { GIT_EDITOR: noOpEditor, GIT_SEQUENCE_EDITOR: noOpEditor }
    }

    async function parentsOf(oid: string): Promise<readonly string[]> {
      const output = await ctx.git.raw(["show", "-s", "--format=%P", oid])
      const parents = output.stdout.trim()
      return parents.length === 0 ? [] : parents.split(" ")
    }

    async function rebaseBase(commit: Commit, action: RewriteAction): Promise<string | null> {
      if (action !== "squash") return commit.parents[0] ?? null
      const target = commit.parents[0]
      if (target === undefined) return null
      return (await parentsOf(target))[0] ?? null
    }

    async function beginRebase(commit: Commit, action: RewriteAction): Promise<void> {
      const base = await rebaseBase(commit, action)
      await ctx.git.raw(
        [
          "-c",
          "rebase.updateRefs=false",
          "rebase",
          "--interactive",
          "--keep-empty",
          "--no-autosquash",
          "--rebase-merges",
          ...(base === null ? ["--root"] : [base]),
        ],
        { env: editorEnv(commit, action) },
      )
    }

    async function headOid(): Promise<string | null> {
      const output = await ctx.git.raw(["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true })
      return output.exitCode === 0 ? output.stdout.trim() : null
    }

    async function reportRewriteFailure(error: unknown, originalHead: string): Promise<void> {
      const ownsRebase = (await refExists("REBASE_HEAD")) || (await headOid()) !== originalHead
      if (!ownsRebase) {
        report(error)
        return
      }

      const aborted = await ctx.git.raw(["rebase", "--abort"], {
        allowFailure: true,
        env: continueEnv(),
      })
      if (aborted.exitCode === 0) {
        ctx.popups.notify(`Rewrite failed; original history restored.\n${describeGitFailure(error)}`, "error")
        return
      }
      ctx.popups.notify(
        `${describeGitFailure(error)}\nAutomatic rollback failed: ${aborted.stderr.trim() || "git rebase --abort failed"}`,
        "error",
      )
    }

    async function runRewrite(commit: Commit, action: Exclude<RewriteAction, "edit">, done: string): Promise<void> {
      if (!(await rewriteReady(commit))) return
      const head = ctx.git.state.head
      if (head.kind !== "onBranch") return

      try {
        await beginRebase(commit, action)
      } catch (error) {
        await reportRewriteFailure(error, head.oid)
        return
      }
      ctx.popups.notify(`${done}. Pushed history now needs force-with-lease`, "success")
    }

    async function fullMessage(commit: Commit): Promise<string> {
      const output = await ctx.git.raw(["show", "-s", "--format=%B", commit.oid])
      return output.stdout.replace(/\n+$/, "")
    }

    async function reword(commit: Commit): Promise<void> {
      if (!(await rewriteReady(commit))) return
      const head = ctx.git.state.head
      if (head.kind !== "onBranch") return

      let message: string
      try {
        message = await fullMessage(commit)
      } catch (error) {
        report(error)
        return
      }

      const rebasing = commit.oid !== head.oid
      if (rebasing) {
        try {
          await beginRebase(commit, "edit")
        } catch (error) {
          await reportRewriteFailure(error, head.oid)
          return
        }
      }

      const result = await commitFlow.begin({ message, amend: true, messageOnly: true })
      if (result === "abandoned") {
        if (rebasing) {
          const aborted = await ctx.git.raw(["rebase", "--abort"], {
            allowFailure: true,
            env: continueEnv(),
          })
          ctx.popups.notify(
            aborted.exitCode === 0
              ? "Reword cancelled; original history restored"
              : `Reword cancelled. Automatic rollback failed: ${aborted.stderr.trim() || "git rebase --abort failed"}`,
            aborted.exitCode === 0 ? "info" : "error",
          )
        }
        return
      }

      if (rebasing) {
        try {
          await ctx.git.raw(["rebase", "--continue"], { env: continueEnv() })
        } catch (error) {
          await reportRewriteFailure(error, head.oid)
          return
        }
      }
      ctx.popups.notify(`Reworded ${commit.shortOid}. Pushed history now needs force-with-lease`, "success")
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
          id: "rewrite",
          title: "Rewrite history",
          items: [
            {
              key: "q",
              label: "Squash into the parent commit",
              when: canSquash,
              run: async (commit) => {
                const parent = commit.parents[0]
                if (parent === undefined || !(await rewriteReady(commit))) return
                if (
                  !(await ctx.popups.confirm({
                    title: "Squash commit",
                    message:
                      `${commit.shortOid} — ${commit.subject} will be folded into ${parent.slice(0, 7)}. ` +
                      "It and every newer commit will get a new oid.",
                    confirmLabel: "squash",
                  }))
                ) {
                  return
                }
                await runRewrite(commit, "squash", `Squashed ${commit.shortOid} into ${parent.slice(0, 7)}`)
              },
            },
            {
              key: "r",
              label: "Reword this commit",
              when: canRewrite,
              run: reword,
            },
            {
              key: "d",
              label: "Drop this commit",
              when: canDrop,
              run: async (commit) => {
                if (!(await rewriteReady(commit))) return
                if (
                  !(await ctx.popups.confirm({
                    title: "Drop commit",
                    message:
                      `${commit.shortOid} — ${commit.subject} will be removed and every newer commit replayed. ` +
                      "The original history remains recoverable from the reflog.",
                    confirmLabel: "drop",
                    danger: true,
                  }))
                ) {
                  return
                }
                await runRewrite(commit, "drop", `Dropped ${commit.shortOid}`)
              },
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
      onSelect,
    }: {
      readonly commit: Commit
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
      readonly onSelect: () => void
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(commit)
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined} onMouseDown={onSelect}>
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
                onSelect={() => cursor.setIndex(index)}
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

    // Keyless: core binds `1`–`9` positionally over the Layout.
    ctx.commands.register({
      id: "commits.focus",
      title: "Focus commits",
      run: () => pane.focus(),
    })

    return rows.api
  },
})
