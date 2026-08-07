/** @jsxImportSource @opentui/react */
import {
  createCell,
  defineExtension,
  describeGitFailure,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  type CommitFlowApi,
  type CommitFlowResult,
  type Head,
} from "laziergit"

function hasCommit(head: Head): boolean {
  return head.kind === "detached" || head.kind === "onBranch"
}

interface CommitDraft {
  readonly initial: string
  readonly amend: boolean
  readonly signoff: boolean
  readonly skipHooks: boolean
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
  readonly skipHooks?: boolean
  readonly messageOnly?: boolean
}

function countLabel(count: number): string {
  return `${count} staged ${count === 1 ? "file" : "files"}`
}

function editingTitle(draft: CommitDraft, stagedCount: number): string {
  const parts = [draft.amend ? "Amend the last commit" : "Commit", countLabel(stagedCount)]
  if (draft.signoff) parts.push("signoff")
  if (draft.skipHooks) parts.push("hooks skipped")
  return parts.join("  ·  ")
}

export default defineExtension({
  name: "commit-flow",
  description: "Commit message editor",

  activate(ctx): CommitFlowApi {
    /** The message the user typed and did not commit, so `escape` never destroys one. */
    const kept = createCell("")
    let refreshDraftAvailability = (): void => undefined
    let active: ActiveFlow | null = null

    function setKept(value: string): void {
      kept.set(value)
      refreshDraftAvailability()
    }

    /**
     * Remembers a message worth resuming. An untouched prefill is not one, and neither is a
     * message-only rewrite's: that text belongs to an existing commit, not to the next one.
     */
    function keep(draft: CommitDraft, text: string): boolean {
      if (draft.messageOnly || text.trim().length === 0 || text === draft.initial) return false
      setKept(text)
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
            skipHooks: flow.draft.skipHooks,
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
          setKept("")
          flow.close("committed")
          ctx.popups.notify(flow.draft.amend ? "Amended" : "Committed", "success")
        }
        return
      }
    }

    /** Opens the editor and resolves when it closes, whichever way it closes. */
    async function open(options: OpenOptions): Promise<CommitFlowResult> {
      const amend = options.amend === true
      // Files previews a stage immediately; an equally immediate `c` must wait for that write
      // and its refresh before the editor snapshots and validates the staged count.
      if (!amend && !ctx.git.state.status.files.some(isStaged)) await ctx.git.waitForIdle?.()
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
          skipHooks: options.skipHooks === true,
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

    /** `open` as a Command sees it: the flow's lifetime is the Command's. */
    function start(options: OpenOptions): Promise<void> {
      return open(options).then(() => undefined)
    }

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
      id: "commit-flow.commit-without-hooks",
      title: "Commit staged changes without hooks",
      keys: "w",
      pane: "files",
      run: () => start({ skipHooks: true }),
    })

    // The extra flow actions remain discoverable in the palette, but no longer need a
    // persistent Commit Pane just to provide them with a focused keybinding scope.
    ctx.commands.register({
      id: "commit-flow.commit-staged",
      title: "Commit staged changes",
      when: () => ctx.git.state.status.files.some(isStaged),
      run: () => start({}),
    })
    ctx.commands.register({
      id: "commit-flow.signoff",
      title: "Commit staged changes with signoff",
      when: () => ctx.git.state.status.files.some(isStaged),
      run: () => start({ signoff: true }),
    })
    ctx.commands.register({
      id: "commit-flow.stage-all",
      title: "Stage all changes and commit",
      when: () => {
        const status = ctx.git.state.status
        return !status.files.some(isConflicted) && status.files.some((file) => isUnstaged(file) || isUntracked(file))
      },
      run: async () => {
        try {
          await ctx.git.stage("all")
        } catch (error) {
          ctx.popups.notify(describeGitFailure(error), "error")
          return
        }
        await start({})
      },
    })
    ctx.commands.register({
      id: "commit-flow.amend-here",
      title: "Amend the last commit",
      when: () => hasCommit(ctx.git.state.head),
      run: () => start({ amend: true }),
    })
    const discardDraft = ctx.commands.register({
      id: "commit-flow.discard-draft",
      title: "Discard the kept commit draft",
      when: () => kept.get().length > 0,
      run: () => {
        setKept("")
        ctx.popups.notify("Draft discarded")
      },
    })
    refreshDraftAvailability = () => discardDraft.refresh()

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
          skipHooks: opts?.skipHooks,
          messageOnly: opts?.messageOnly,
        }),
    }
  },
})
