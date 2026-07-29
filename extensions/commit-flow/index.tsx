/** @jsxImportSource @opentui/react */
import {
  createCell,
  defineExtension,
  describeGitFailure,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  useCommand,
  useGit,
  useKeyCapture,
  useTheme,
  type CommitFlowApi,
  type CommitFlowResult,
  type FileChange,
  type Head,
  type PaneProps,
} from "laziergit"
import { useEffect, useMemo, useRef } from "react"

function hasCommit(head: Head): boolean {
  return head.kind === "detached" || head.kind === "onBranch"
}

/** Staged paths the idle summary names before it falls back to a count. */
const listedPaths = 6

/** How much of a kept draft the idle summary quotes back. */
const draftPreview = 40

/**
 * The slice of OpenTUI's textarea this Pane reads. Declared structurally because an Extension
 * may not import `@opentui/core`, where `TextareaRenderable` lives (ADR-0001).
 */
interface MessageEditor {
  /** The whole buffer. The textarea is uncontrolled, so the renderable is the message. */
  readonly plainText: string
  cursorOffset: number
}

interface CommitDraft {
  /** A textarea applies `initialValue` once per renderable, so this is its React `key`. */
  readonly id: number
  readonly initial: string
  readonly amend: boolean
  readonly signoff: boolean
  readonly messageOnly: boolean
  /** Settles the promise `begin` handed its caller. Idempotent: a flow closes exactly once. */
  readonly close: (result: CommitFlowResult) => void
}

type FlowState = { readonly kind: "idle" } | { readonly kind: "editing"; readonly draft: CommitDraft }

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

function editingHeader(draft: CommitDraft, stagedCount: number): string {
  const parts = draft.amend ? ["amending the last commit", countLabel(stagedCount)] : [countLabel(stagedCount)]
  if (draft.signoff) parts.push("signoff")
  return parts.join("  ·  ")
}

export default defineExtension({
  name: "commit-flow",
  description: "Commit message editor",

  activate(ctx): CommitFlowApi {
    const flow = createCell<FlowState>({ kind: "idle" })
    /** The message the user typed and did not commit, so `escape` never destroys one. */
    const kept = createCell("")
    let nextDraftId = 1

    /**
     * Reads the open editor's buffer, published by the Pane while it is mounted. Null while
     * nothing is mounted; every path that abandons a flow runs outside the component.
     */
    let readDraft: (() => string) | null = null

    // `PaneHandle.focus()` has no inverse, so the Pane remembers what it displaced.
    let focusedPane: string | null = null
    let returnTo: string | null = null
    ctx.events.on("app.pane.focused", ({ paneId, previous }) => {
      focusedPane = paneId
      if (paneId === "commit-flow" && previous !== null && previous !== "commit-flow") returnTo = previous
    })

    /**
     * Remembers a message worth resuming. An untouched prefill is not one, and neither is a
     * message-only rewrite's: that text belongs to an existing commit, not to the next one.
     */
    function keep(draft: CommitDraft, text: string): boolean {
      if (draft.messageOnly || text.trim().length === 0 || text === draft.initial) return false
      kept.set(text)
      return true
    }

    /**
     * Ends the open flow, settling its promise and keeping whatever was typed. Returns whether
     * a draft was kept. Leaves the screen alone — see {@link closeFlow} for the other half.
     */
    function endFlow(result: CommitFlowResult): boolean {
      const current = flow.get()
      if (current.kind === "idle") return false
      // Read before going idle, which unmounts the textarea the draft lives in.
      const retained = result === "abandoned" && keep(current.draft, readDraft?.() ?? "")
      if (result === "committed") kept.set("")
      // Idle first, so anything resuming on the settled promise already sees a closed Pane.
      flow.set({ kind: "idle" })
      current.draft.close(result)
      return retained
    }

    /**
     * Puts the keyboard on `paneId`. There is no public verb for focusing someone else's Pane,
     * but executing a Pane-scoped Command focuses its Pane first (§1.7) — so a no-op Command
     * registered against `paneId` reaches it.
     */
    async function focusPane(paneId: string): Promise<void> {
      const handle = ctx.commands.register({
        id: "commit-flow.return-focus",
        title: "Return focus to the pane the commit came from",
        hidden: true,
        pane: paneId,
        run: () => undefined,
      })
      try {
        await ctx.commands.execute("commit-flow.return-focus")
      } catch {
        // That Pane is gone, so there is nothing to hand the keyboard to.
      } finally {
        handle.dispose()
      }
    }

    /**
     * Gives the screen back the way `open` found it. `focus()` latches this Pane as its cell's
     * visible tab and nothing un-latches it, so `app.tab.next` hands the cell to its neighbour
     * — a no-op when this Pane has the cell to itself.
     */
    async function handBack(): Promise<void> {
      // Only while this Pane still owns the keyboard: the user may have tabbed away mid-edit.
      if (focusedPane !== "commit-flow") return
      const target = returnTo
      returnTo = null
      await ctx.commands.execute("app.tab.next")
      if (target !== null && target !== "commit-flow") await focusPane(target)
    }

    /** Ends the open flow and hands the screen back. */
    async function closeFlow(result: CommitFlowResult): Promise<boolean> {
      const wasOpen = flow.get().kind === "editing"
      const retained = endFlow(result)
      if (wasOpen) await handBack()
      return retained
    }

    // `%B` rather than the store, which keeps subjects only: an amend must prefill the body too.
    async function lastCommitMessage(): Promise<string> {
      const output = await ctx.git.raw(["log", "-1", "--format=%B"], { allowFailure: true })
      // `%B` ends in a newline, which would park the cursor on a blank line below the text.
      return output.exitCode === 0 ? output.stdout.replace(/\n+$/, "") : ""
    }

    /** Opens the editor and resolves when it closes, whichever way it closes. */
    async function open(options: OpenOptions): Promise<CommitFlowResult> {
      const amend = options.amend === true
      if (amend && !hasCommit(ctx.git.state.head)) {
        ctx.popups.notify("No commit to amend yet", "warning")
        return "abandoned"
      }

      // A kept draft outranks the amend prefill and yields to a caller's own message.
      const draft = kept.get()
      const initial = options.message ?? (draft.length > 0 ? draft : amend ? await lastCommitMessage() : "")
      const settled = Promise.withResolvers<CommitFlowResult>()
      let closed = false

      // One Pane holds one message: a second `begin` displaces the first and settles its
      // caller now. `endFlow`, not `closeFlow` — the screen belongs to the flow opening below.
      endFlow("abandoned")
      flow.set({
        kind: "editing",
        draft: {
          id: nextDraftId++,
          initial,
          amend,
          signoff: options.signoff === true,
          messageOnly: options.messageOnly === true,
          close: (result) => {
            if (closed) return
            closed = true
            settled.resolve(result)
          },
        },
      })

      try {
        pane.focus()
      } catch (error) {
        // A Layout that leaves this Pane out gives the editor no keyboard at all.
        endFlow("abandoned")
        ctx.popups.notify(describeGitFailure(error), "error")
      }
      return settled.promise
    }

    /** `open` as a Command or menu `run` sees it: the flow's lifetime is the Command's. */
    function start(options: OpenOptions): Promise<void> {
      return open(options).then(() => undefined)
    }

    /** Commits, or explains why it did not. Only success closes the flow. */
    async function commit(draft: CommitDraft, message: string): Promise<void> {
      if (message.trim().length === 0) {
        ctx.popups.notify("Write a commit message first", "warning")
        return
      }
      // An amend is the one case where an empty index does not mean an empty commit.
      if (!draft.amend && !ctx.git.state.status.files.some(isStaged)) {
        ctx.popups.notify("Nothing staged to commit", "warning")
        return
      }

      try {
        await ctx.git.commit(message, {
          amend: draft.amend,
          signoff: draft.signoff,
          messageOnly: draft.messageOnly,
        })
      } catch (error) {
        ctx.popups.notify(describeGitFailure(error), "error")
        return
      }
      await closeFlow("committed")
      ctx.popups.notify(draft.amend ? "Amended" : "Committed", "success")
    }

    function CommitFlowPane({ focused }: PaneProps) {
      const theme = useTheme()
      const current = flow.use()
      const keptDraft = kept.use()
      // Filter outside the selector: `useGit((s) => s.…filter(…))` returns a fresh array every
      // snapshot, so the store's `Object.is` check never holds and the Pane re-renders forever.
      const files = useGit((state) => state.status.files)
      const staged = useMemo(() => files.filter(isStaged), [files])
      const editor = useRef<MessageEditor | null>(null)

      // Publishes the buffer to the flow, which closes from places this component cannot see.
      useEffect(() => {
        const read = () => editor.current?.plainText ?? ""
        readDraft = read
        return () => {
          if (readDraft === read) readDraft = null
        }
      }, [])

      // The textarea parks a prefilled caret at offset 0, so typing would prepend onto the
      // prefill. Keyed on the draft id: moving the caret on every render would fight the user.
      const editingId = current.kind === "editing" ? current.draft.id : null
      useEffect(() => {
        const node = editor.current
        if (node !== null && editingId !== null) node.cursorOffset = node.plainText.length
      }, [editingId])

      // Without this a typed message fires every binding it spells: `q` quits, `?` helps.
      useKeyCapture(current.kind === "editing")

      useCommand({
        id: "commit-flow.submit",
        title: "Commit the message",
        hint: "commit",
        // `ctrl+s` first: the hint bar prints the first key, and it is the one no terminal can
        // take away (ADR-0004). Raw mode clears IXON, so it is not flow control here.
        keys: ["ctrl+s", "mod+s"],
        capture: true,
        run: () => (current.kind === "editing" ? commit(current.draft, editor.current?.plainText ?? "") : undefined),
      })
      useCommand({
        id: "commit-flow.cancel",
        title: "Close the editor, keeping the message",
        hint: "keep draft",
        keys: "escape",
        capture: true,
        run: async () => {
          if (await closeFlow("abandoned")) ctx.popups.notify("Draft kept — c resumes it", "info")
        },
      })

      if (current.kind === "editing") {
        const draft = current.draft
        return (
          <box flexDirection="column" flexGrow={1}>
            <text wrapMode="none" content={editingHeader(draft, staged.length)} style={{ fg: theme.textMuted }} />
            <textarea
              key={draft.id}
              ref={(node) => {
                editor.current = node
              }}
              // Tabbing away releases the capture, so the editor releases the cursor with it.
              focused={focused}
              initialValue={draft.initial}
              flexGrow={1}
            />
          </box>
        )
      }

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

    const pane = ctx.panes.register({
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
    // would otherwise wait on a Pane that no longer exists.
    ctx.onDispose(() => {
      endFlow("abandoned")
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
