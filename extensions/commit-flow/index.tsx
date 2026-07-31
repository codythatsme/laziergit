/** @jsxImportSource @opentui/react */
import {
  createCell,
  defineExtension,
  describeGitFailure,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  useGit,
  useTheme,
  type CommitFlowApi,
  type CommitFlowResult,
  type FileChange,
  type Head,
} from "laziergit"
import { useMemo } from "react"

function hasCommit(head: Head): boolean {
  return head.kind === "detached" || head.kind === "onBranch"
}

/** Staged paths the idle summary names before it falls back to a count. */
const listedPaths = 6

/** How much of a kept draft the idle summary quotes back. */
const draftPreview = 40

interface CommitDraft {
  readonly initial: string
  readonly amend: boolean
  readonly signoff: boolean
  readonly messageOnly: boolean
}

interface ActiveFlow {
  readonly draft: CommitDraft
  /** The popup reports every edit here, so displacement and Escape cannot lose the buffer. */
  message: string
  /** Settles the promise `begin` handed its caller. Idempotent: a flow closes exactly once. */
  readonly close: (result: CommitFlowResult) => void
}

interface OpenOptions {
  readonly message?: string
  readonly amend?: boolean
  readonly signoff?: boolean
  readonly messageOnly?: boolean
}

function countLabel(count: number): string {
  return `${count} staged ${count === 1 ? "file" : "files"}`
}

function describe(file: FileChange): string {
  return file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? ""
  return line.length > draftPreview ? `${line.slice(0, draftPreview - 1)}…` : line
}

function editingTitle(draft: CommitDraft, stagedCount: number): string {
  const parts = [draft.amend ? "Amend the last commit" : "Commit", countLabel(stagedCount)]
  if (draft.signoff) parts.push("signoff")
  return parts.join("  ·  ")
}

export default defineExtension({
  name: "commit-flow",
  description: "Commit message editor",

  activate(ctx): CommitFlowApi {
    /** The message the user typed and did not commit, so `escape` never destroys one. */
    const kept = createCell("")
    let active: ActiveFlow | null = null

    /**
     * Remembers a message worth resuming. An untouched prefill is not one, and neither is a
     * message-only rewrite's: that text belongs to an existing commit, not to the next one.
     */
    function keep(draft: CommitDraft, text: string): boolean {
      if (draft.messageOnly || text.trim().length === 0 || text === draft.initial) return false
      kept.set(text)
      return true
    }

    // `%B` rather than the store, which keeps subjects only: an amend must prefill the body too.
    async function lastCommitMessage(): Promise<string> {
      const output = await ctx.git.raw(["log", "-1", "--format=%B"], { allowFailure: true })
      // `%B` ends in a newline, which would park the cursor on a blank line below the text.
      return output.exitCode === 0 ? output.stdout.replace(/\n+$/, "") : ""
    }

    function validationProblem(draft: CommitDraft, message: string): string | null {
      const summary = message.split("\n", 1)[0] ?? ""
      if (summary.trim().length === 0) return "Write a commit message first"
      // An amend is the one case where an empty index does not mean an empty commit.
      if (!draft.amend && !ctx.git.state.status.files.some(isStaged)) return "Nothing staged to commit"
      return null
    }

    /** Owns the modal for one flow, reopening it with the same text if git rejects the commit. */
    async function edit(flow: ActiveFlow): Promise<void> {
      let initial = flow.draft.initial

      while (active === flow) {
        flow.message = initial
        const title = editingTitle(flow.draft, ctx.git.state.status.files.filter(isStaged).length)
        // Core itself does not hot-reload. During development a process started before
        // `compose` existed can load this newer bundled Extension, so keep `c` useful until
        // that process restarts instead of failing after the keypress with no editor.
        const message =
          typeof ctx.popups.compose === "function"
            ? await ctx.popups.compose({
                title,
                summaryTitle: "Commit summary",
                descriptionTitle: "Commit description",
                initial,
                validate: (value) => validationProblem(flow.draft, value),
                onChange: (value) => {
                  if (active === flow) flow.message = value
                },
              })
            : await ctx.popups.prompt({
                title,
                placeholder: "Commit summary",
                initial,
                validate: (value) => validationProblem(flow.draft, value),
              })

        // Another `begin` replaced this one and already settled its caller.
        if (active !== flow) return

        if (message === undefined) {
          active = null
          const retained = keep(flow.draft, flow.message)
          flow.close("abandoned")
          if (retained) ctx.popups.notify("Draft kept — c resumes it", "info")
          return
        }

        flow.message = message
        try {
          await ctx.git.commit(message, {
            amend: flow.draft.amend,
            signoff: flow.draft.signoff,
            messageOnly: flow.draft.messageOnly,
          })
        } catch (error) {
          if (active !== flow) return
          ctx.popups.notify(describeGitFailure(error), "error")
          initial = message
          continue
        }

        // A programmatic second flow can arrive while git is running. The completed write
        // must not dismiss its popup or consume the newer flow's draft.
        if (active === flow) {
          active = null
          kept.set("")
          flow.close("committed")
          ctx.popups.notify(flow.draft.amend ? "Amended" : "Committed", "success")
        }
        return
      }
    }

    /** Opens the editor and resolves when it closes, whichever way it closes. */
    async function open(options: OpenOptions): Promise<CommitFlowResult> {
      const amend = options.amend === true
      if (amend && !hasCommit(ctx.git.state.head)) {
        ctx.popups.notify("No commit to amend yet", "warning")
        return "abandoned"
      }

      // A second `begin` displaces the first. Preserve its live text before choosing the new
      // prefill, then let PopupHost replace the old modal when this flow starts composing.
      const displaced = active
      if (displaced !== null) {
        keep(displaced.draft, displaced.message)
        active = null
        displaced.close("abandoned")
      }

      // A kept draft outranks the amend prefill and yields to a caller's own message.
      const saved = kept.get()
      const initial = options.message ?? (saved.length > 0 ? saved : amend ? await lastCommitMessage() : "")
      const settled = Promise.withResolvers<CommitFlowResult>()
      let closed = false
      const flow: ActiveFlow = {
        draft: {
          initial,
          amend,
          signoff: options.signoff === true,
          messageOnly: options.messageOnly === true,
        },
        message: initial,
        close: (result) => {
          if (closed) return
          closed = true
          settled.resolve(result)
        },
      }
      active = flow
      void edit(flow).catch((error: unknown) => {
        if (active !== flow) return
        active = null
        flow.close("abandoned")
        ctx.popups.notify(describeGitFailure(error), "error")
      })
      return settled.promise
    }

    /** `open` as a Command or menu `run` sees it: the flow's lifetime is the Command's. */
    function start(options: OpenOptions): Promise<void> {
      return open(options).then(() => undefined)
    }

    function CommitFlowPane() {
      const theme = useTheme()
      const keptDraft = kept.use()
      // Filter outside the selector: `useGit((s) => s.…filter(…))` returns a fresh array every
      // snapshot, so the store's `Object.is` check never holds and the Pane re-renders forever.
      const files = useGit((state) => state.status.files)
      const staged = useMemo(() => files.filter(isStaged), [files])

      return (
        <box flexDirection="column">
          {staged.length === 0 ? (
            <text content="nothing staged" style={{ fg: theme.textMuted }} />
          ) : (
            <box flexDirection="column">
              <text content={countLabel(staged.length)} style={{ fg: theme.text }} />
              {staged.slice(0, listedPaths).map((file) => (
                <text key={file.path} wrapMode="none" content={`  ${describe(file)}`} style={{ fg: theme.textMuted }} />
              ))}
              {staged.length > listedPaths ? (
                <text content={`  +${staged.length - listedPaths} more`} style={{ fg: theme.textMuted }} />
              ) : null}
            </box>
          )}
          {keptDraft.length > 0 ? (
            <text wrapMode="none" content={`draft kept: ${firstLine(keptDraft)}`} style={{ fg: theme.warning }} />
          ) : null}
          {/* The hint bar shows the focused Pane's keys, and these two live on the files Pane. */}
          <text content="c commit  ·  shift+a amend" style={{ fg: theme.info }} />
          <text content="from the files pane" style={{ fg: theme.textMuted }} />
        </box>
      )
    }

    ctx.panes.register({
      id: "commit-flow",
      title: "Commit",
      component: CommitFlowPane,
      placement: { column: 1, order: 20, tabWith: "diff" },
    })

    ctx.commands.register({
      id: "commit-flow.commit",
      title: "Commit",
      hint: "commit",
      keys: "c",
      // A Pane id is a name, not a live object: this needs no `needs`, and is inert without it.
      pane: "files",
      run: () => start({}),
    })
    ctx.commands.register({
      id: "commit-flow.amend",
      title: "Amend the last commit",
      hint: "amend",
      // `shift+a`, not `A`: the parser lowercases a bare letter, colliding with files' `a`.
      keys: "shift+a",
      pane: "files",
      run: () => start({ amend: true }),
    })
    ctx.commands.register({
      id: "commit-flow.menu",
      title: "Commit actions",
      hint: "menu",
      keys: "x",
      pane: "commit-flow",
      run: () => ctx.menus.open("commit-flow.actions", ctx.git.state.status),
    })

    ctx.menus.register({
      id: "commit-flow.actions",
      title: (status) => {
        const staged = status.files.filter(isStaged).length
        return staged === 0 ? "Commit" : `Commit — ${countLabel(staged)}`
      },
      groups: [
        {
          // Explicit id: splices address this, so it must not move when a title changes.
          id: "commit",
          // Keys must differ in more than case — the menu lowercases the stroke it matches.
          items: [
            {
              key: "c",
              label: "Commit",
              when: (status) => status.files.some(isStaged),
              run: () => start({}),
            },
            {
              key: "s",
              label: "Commit with signoff",
              when: (status) => status.files.some(isStaged),
              run: () => start({ signoff: true }),
            },
            {
              key: "a",
              label: "Stage all and commit",
              // Withdrawn while anything is conflicted: `git add --all` would mark it resolved.
              when: (status) =>
                !status.files.some(isConflicted) && status.files.some((file) => isUnstaged(file) || isUntracked(file)),
              run: async () => {
                try {
                  await ctx.git.stage("all")
                } catch (error) {
                  ctx.popups.notify(describeGitFailure(error), "error")
                  return
                }
                await start({})
              },
            },
            {
              key: "m",
              label: "Amend the last commit",
              // From the store, not the target: the menu's target is the working tree.
              when: () => hasCommit(ctx.git.state.head),
              run: () => start({ amend: true }),
            },
            {
              key: "d",
              label: "Discard the kept draft",
              when: () => kept.get().length > 0,
              run: () => {
                kept.set("")
                ctx.popups.notify("Draft discarded")
              },
            },
          ],
        },
      ],
    })

    // A flow does not outlive its activation: a caller awaiting `begin` across a hot reload
    // would otherwise wait on a popup whose owner no longer exists.
    ctx.onDispose(() => {
      const current = active
      active = null
      current?.close("abandoned")
    })

    return {
      begin: (opts) =>
        open({
          message: opts?.message,
          amend: opts?.amend,
          signoff: opts?.signoff,
          messageOnly: opts?.messageOnly,
        }),
    }
  },
})
