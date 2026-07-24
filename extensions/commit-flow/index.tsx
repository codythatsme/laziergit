/** @jsxImportSource @opentui/react */
import {
  createCell,
  defineExtension,
  GitError,
  useCommand,
  useGit,
  useKeyCapture,
  useTheme,
  type CommitFlowApi,
  type CommitFlowResult,
  type FileChange,
  type PaneProps,
} from "laziergit"
import { useEffect, useRef } from "react"

/** Staged paths the idle summary names before it falls back to a count. */
const listedPaths = 6

/** How much of a kept draft the idle summary quotes back. */
const draftPreview = 40

/**
 * The slice of OpenTUI's textarea this Pane reads.
 *
 * Declared structurally rather than imported: an Extension may import only `"laziergit"`,
 * `"react"` and `"@opentui/react"` (ADR-0001), and `TextareaRenderable` lives in
 * `@opentui/core`. A callback ref still checks the shape against the real renderable on
 * assignment, so this cannot drift into a lie.
 */
interface MessageEditor {
  /**
   * The whole buffer. Read on submit rather than mirrored into React state: the textarea is
   * uncontrolled — its content event carries no value, and its `initialValue` applies once —
   * so the renderable, not a `useState`, is the message.
   */
  readonly plainText: string
  /**
   * Where the caret sits, as an offset into {@link plainText}. Writable, because the
   * textarea parks a prefilled `initialValue`'s caret at offset 0 — so an amend or a
   * resumed draft would prepend what the user types onto the message it opened with. The
   * Pane moves it to the end once, the moment a prefilled editor mounts.
   */
  cursorOffset: number
}

/** An open editor: what it was opened with, and how it ends. */
interface CommitDraft {
  /**
   * Distinct per flow. A textarea takes `initialValue` exactly once per renderable, so the
   * second flow only shows its prefill if React builds a new one — this is the `key` that
   * makes it.
   */
  readonly id: number
  readonly initial: string
  readonly amend: boolean
  readonly signoff: boolean
  /**
   * Settles the promise `begin` handed its caller. Idempotent, because a flow closes
   * exactly once — committed, cancelled, displaced by a later `begin`, or dropped at
   * deactivation, whichever gets there first. §4.3's conventional-commit awaits this to
   * know its composed message landed, so never settling and settling twice are both bugs
   * in the same contract, and everything that is not a commit is `"abandoned"`.
   */
  readonly close: (result: CommitFlowResult) => void
}

type FlowState = { readonly kind: "idle" } | { readonly kind: "editing"; readonly draft: CommitDraft }

/** `begin`'s options plus the one the menu needs and the public API has no word for. */
interface OpenOptions {
  readonly message?: string
  readonly amend?: boolean
  readonly signoff?: boolean
}

/**
 * What git said, verbatim.
 *
 * `GitError.stderr` is where a rejected `pre-commit` hook or a bad pathspec actually
 * explains itself; the message is a summary built from it, so stderr is preferred and the
 * message is the fallback for the failures that produce none. Line structure survives: a
 * rejected hook prints its complaint across several lines and the toast renders them.
 */
function reason(error: unknown): string {
  const text =
    error instanceof GitError && error.stderr.trim().length > 0
      ? error.stderr
      : error instanceof Error
        ? error.message
        : String(error)
  return text.trim()
}

function countLabel(count: number): string {
  return `${count} staged ${count === 1 ? "file" : "files"}`
}

/** A rename is two paths, and the old one is why the row is not simply "added". */
function describe(file: FileChange): string {
  return file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`
}

/** A kept draft is quoted back by its subject, because that is the line the user recognises. */
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
    /**
     * The message the user typed and did not commit.
     *
     * `escape` is the most reflexive key in a TUI, and abandoning a flow used to throw a
     * long commit message away with no confirmation and no way back. Keeping the draft
     * rather than confirming the discard: a confirm costs a keystroke on every back-out and
     * *still* loses the text the moment the user answers it wrong, while a kept draft makes
     * `escape` harmless — the next `c` resumes where they left off. A Cell rather than a
     * plain variable, because the idle summary says so on screen.
     */
    const kept = createCell("")
    let nextDraftId = 1

    /**
     * Reads the open editor's buffer, published by the Pane while it is mounted.
     *
     * The buffer lives in the renderable (the textarea is uncontrolled), and every path that
     * abandons a flow — `escape`, a second `begin`, a hot reload — runs outside the
     * component, so the component hands out a reader instead of each of them reaching for a
     * ref they cannot see. Null while nothing is mounted, which is also when there is no
     * buffer to keep.
     */
    let readDraft: (() => string) | null = null

    /**
     * Where the keyboard is, and where it was before this Pane took it.
     *
     * `PaneHandle.focus()` is the only lever an Extension has over the Layout and it has no
     * inverse, so the Pane has to remember what it displaced — otherwise closing the editor
     * leaves the cell latched to the idle summary and the keyboard on a Pane the user is
     * done with.
     */
    let focusedPane: string | null = null
    let returnTo: string | null = null
    ctx.events.on("app.pane.focused", ({ paneId, previous }) => {
      focusedPane = paneId
      if (paneId === "commit-flow" && previous !== null && previous !== "commit-flow") returnTo = previous
    })

    /** Remembers a message worth resuming. An untouched prefill is not one. */
    function keep(draft: CommitDraft, text: string): boolean {
      if (text.trim().length === 0 || text === draft.initial) return false
      kept.set(text)
      return true
    }

    /**
     * Ends the open flow, if there is one, settling the promise it was opened with and
     * keeping whatever was typed. Returns whether there was a draft worth keeping, which is
     * what the difference between "abandoned" and "lost" is worth saying out loud.
     *
     * Leaves the screen alone: the two callers that must not touch it are a second `begin`
     * (which focuses this Pane again on the next line) and deactivation (where the Pane is
     * going away and the Layout re-lays-out on its own).
     */
    function endFlow(result: CommitFlowResult): boolean {
      const current = flow.get()
      if (current.kind === "idle") return false
      // Read before the Pane goes idle: going idle unmounts the textarea the draft lives in.
      const retained = result === "abandoned" && keep(current.draft, readDraft?.() ?? "")
      if (result === "committed") kept.set("")
      // Idle first, so anything resuming on the settled promise already sees a closed Pane.
      flow.set({ kind: "idle" })
      current.draft.close(result)
      return retained
    }

    /**
     * Puts the keyboard on `paneId`.
     *
     * Focus-then-run is the whole mechanism (§1.7): executing a Pane-scoped Command focuses
     * its Pane first, a Command may name any Pane id — another Extension's included, with no
     * `needs` declaration — and a Command that does nothing therefore focuses and nothing
     * else. There is no public verb for "focus someone else's Pane", and this is the seam
     * that already reaches it; the alternative was inventing one.
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
        // That Pane is gone, which is exactly when there is nothing to hand the keyboard to.
      } finally {
        handle.dispose()
      }
    }

    /**
     * Gives the screen back the way `open` found it.
     *
     * `focus()` latches this Pane as its cell's visible tab and nothing un-latches it, so a
     * committed flow used to leave the right-hand column showing the idle summary forever
     * while the diff Pane it is tabbed with updated out of sight. `]` — the Command the user
     * would otherwise press — hands the cell on to its neighbour without this Pane having to
     * name it, and does nothing at all when this Pane has the cell to itself.
     */
    async function handBack(): Promise<void> {
      // Only while this Pane still owns the keyboard: the user may have tabbed away
      // mid-edit, and yanking focus off the Pane they moved to is worse than the strand.
      if (focusedPane !== "commit-flow") return
      const target = returnTo
      returnTo = null
      await ctx.commands.execute("app.tab.next")
      if (target !== null && target !== "commit-flow") await focusPane(target)
    }

    /** Ends the open flow and hands the screen back. Returns what {@link endFlow} returns. */
    async function closeFlow(result: CommitFlowResult): Promise<boolean> {
      const wasOpen = flow.get().kind === "editing"
      const retained = endFlow(result)
      if (wasOpen) await handBack()
      return retained
    }

    /**
     * What `--amend` starts from. Read with `%B` rather than taken from the store, which
     * keeps subject lines: prefilling an amend from the subject alone would silently drop
     * the body of the commit being rewritten.
     */
    async function lastCommitMessage(): Promise<string> {
      const output = await ctx.git.raw(["log", "-1", "--format=%B"], { allowFailure: true })
      // `%B` ends in a newline, which would park the cursor on a blank line below the text.
      return output.exitCode === 0 ? output.stdout.replace(/\n+$/, "") : ""
    }

    /** Opens the editor and resolves when it closes, whichever way it closes. */
    async function open(options: OpenOptions): Promise<CommitFlowResult> {
      const amend = options.amend === true
      // The Head union answers this before git has to: there is no commit to rewrite.
      if (amend && ctx.git.state.head.kind === "unborn") {
        ctx.popups.notify("No commit to amend yet", "warning")
        return "abandoned"
      }

      // A kept draft outranks the amend prefill and yields to a message a caller composed:
      // it is the user's own unfinished words, and the point of keeping it is that `c`
      // brings it back.
      const draft = kept.get()
      const initial = options.message ?? (draft.length > 0 ? draft : amend ? await lastCommitMessage() : "")
      const settled = Promise.withResolvers<CommitFlowResult>()
      let closed = false

      // One Pane holds one message, so a second `begin` replaces the first rather than
      // stacking behind it — and the displaced caller settles now instead of waiting on an
      // editor that is no longer on screen. `endFlow`, not `closeFlow`: the displaced draft
      // is kept, but the screen belongs to the flow being opened on the next line.
      endFlow("abandoned")
      flow.set({
        kind: "editing",
        draft: {
          id: nextDraftId++,
          initial,
          amend,
          signoff: options.signoff === true,
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
        // The Layout is the user's to write, and one that leaves this Pane out gives the
        // editor no keyboard at all. Say so, rather than opening one nobody can type into.
        // Nothing to hand back, either: focus never moved.
        endFlow("abandoned")
        ctx.popups.notify(reason(error), "error")
      }
      return settled.promise
    }

    /**
     * `open` as a Command or menu `run` sees it. Still returns the promise, so the flow's
     * lifetime is the Command's and a throw lands in core's own Command error reporting
     * (§5.9); only the result is dropped, because nothing there has a caller to tell.
     */
    function start(options: OpenOptions): Promise<void> {
      return open(options).then(() => undefined)
    }

    /**
     * Commits, or explains why it did not. Only success closes the flow: a typed message is
     * the one thing in this Pane that cannot be recovered, so a rejected hook, a failing
     * `commit-msg`, or a locked index leaves the editor exactly as the user left it.
     */
    async function commit(draft: CommitDraft, message: string): Promise<void> {
      if (message.trim().length === 0) {
        ctx.popups.notify("Write a commit message first", "warning")
        return
      }
      // An amend rewrites a commit that already has content, so it is the one case where an
      // empty index does not mean an empty commit.
      if (!draft.amend && ctx.git.state.status.staged.length === 0) {
        ctx.popups.notify("Nothing staged to commit", "warning")
        return
      }

      try {
        await ctx.git.commit(message, { amend: draft.amend, signoff: draft.signoff })
      } catch (error) {
        ctx.popups.notify(reason(error), "error")
        return
      }
      await closeFlow("committed")
      ctx.popups.notify(draft.amend ? "Amended" : "Committed", "success")
    }

    function CommitFlowPane({ focused }: PaneProps) {
      const theme = useTheme()
      const current = flow.use()
      const keptDraft = kept.use()
      const staged = useGit((state) => state.status.staged)
      const editor = useRef<MessageEditor | null>(null)

      // Publishes the buffer to the flow, which closes from places this component cannot
      // see. The reader reads the ref when it is called, so it never goes stale and this
      // runs once; the identity check keeps a remount's cleanup from unpublishing the
      // instance that replaced it.
      useEffect(() => {
        const read = () => editor.current?.plainText ?? ""
        readDraft = read
        return () => {
          if (readDraft === read) readDraft = null
        }
      }, [])

      // The textarea lands a prefilled `initialValue`'s caret at offset 0, so typing into an
      // amend prefill or a resumed draft would prepend onto it ("amended" + "add feature" →
      // "amendedadd feature"). Move it to the end once, keyed on the draft id so it runs when
      // an editor mounts and never again — resetting it on every render would yank the caret
      // out from under the user mid-word. An effect, not the ref, because `initialValue` is
      // applied during commit and the buffer is only whole once the effect runs.
      const editingId = current.kind === "editing" ? current.draft.id : null
      useEffect(() => {
        const node = editor.current
        if (node !== null && editingId !== null) node.cursorOffset = node.plainText.length
      }, [editingId])

      // Without this a typed message fires every binding it happens to spell — `q` quits,
      // `?` opens the cheat sheet, `[` walks tabs. Only the two Commands below survive it.
      useKeyCapture(current.kind === "editing")

      useCommand({
        id: "commit-flow.submit",
        title: "Commit the message",
        keys: "mod+s",
        capture: true,
        run: () => (current.kind === "editing" ? commit(current.draft, editor.current?.plainText ?? "") : undefined),
      })
      useCommand({
        id: "commit-flow.cancel",
        title: "Close the editor, keeping the message",
        keys: "escape",
        capture: true,
        // Said out loud, because a key that used to destroy the message no longer does and
        // the Pane it would have said so on is not the one on screen afterwards.
        run: async () => {
          if (await closeFlow("abandoned")) ctx.popups.notify("Draft kept — c resumes it", "info")
        },
      })

      if (current.kind === "editing") {
        const draft = current.draft
        return (
          <box flexDirection="column" flexGrow={1}>
            <text content={editingHeader(draft, staged.length)} style={{ fg: theme.textMuted }} />
            <textarea
              key={draft.id}
              ref={(node) => {
                editor.current = node
              }}
              // Tabbing away releases the capture, so the editor must release the terminal's
              // cursor with it — otherwise a background Pane would keep swallowing keystrokes.
              focused={focused}
              initialValue={draft.initial}
              flexGrow={1}
            />
            {/* `?` is inert while capturing, so the two keys that still work name themselves. */}
            <text content="mod+s commit  ·  escape keeps the draft" style={{ fg: theme.textMuted }} />
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
                <text key={file.path} content={`  ${describe(file)}`} style={{ fg: theme.textMuted }} />
              ))}
              {staged.length > listedPaths ? (
                <text content={`  +${staged.length - listedPaths} more`} style={{ fg: theme.textMuted }} />
              ) : null}
            </box>
          )}
          {keptDraft.length > 0 ? (
            <text content={`draft kept: ${firstLine(keptDraft)}`} style={{ fg: theme.warning }} />
          ) : null}
          {/* Named, because an editor nobody can find is an editor nobody uses. Two short
              lines rather than one sentence: a sidebar column is narrower than the prose.
              Spelled the way the Commands below are bound and the cheat sheet prints them —
              `shift+a`, not `A` — so the hint and the keybinding cannot disagree. A user who
              rebinds either in config still out-dates this line; the cheat sheet is where
              the truth is, and a Pane cannot ask for a Command's resolved keys (§1.7). */}
          <text content="c commit  ·  shift+a amend" style={{ fg: theme.info }} />
          <text content="from the files pane" style={{ fg: theme.textMuted }} />
        </box>
      )
    }

    const pane = ctx.panes.register({
      id: "commit-flow",
      title: "Commit",
      component: CommitFlowPane,
      // Tabbed with `diff`: both want the whole right-hand column, and you are never
      // reading a diff and typing a message in the same instant.
      placement: { column: 1, order: 20, tabWith: "diff" },
    })

    ctx.commands.register({
      id: "commit-flow.commit",
      title: "Commit",
      keys: "c",
      // Bound inside the files Pane, where staging happens. A Pane id is a name, not a live
      // object, so this needs no `needs`: it is simply inert while nothing owns that Pane.
      pane: "files",
      run: () => start({}),
    })
    ctx.commands.register({
      id: "commit-flow.amend",
      title: "Amend the last commit",
      // `shift+a`, not `A`: the binding parser lowercases a bare letter, so `"A"` would
      // claim the same stroke as the files Pane's own `a` and one of them would go silent.
      keys: "shift+a",
      pane: "files",
      run: () => start({ amend: true }),
    })
    ctx.commands.register({
      id: "commit-flow.menu",
      title: "Commit actions",
      keys: "x",
      pane: "commit-flow",
      run: () => ctx.menus.open("commit-flow.actions", ctx.git.state.status),
    })

    ctx.menus.register({
      id: "commit-flow.actions",
      title: (status) => (status.staged.length === 0 ? "Commit" : `Commit — ${countLabel(status.staged.length)}`),
      groups: [
        {
          // An explicit id, not a defaulted one: this menu is the premier splice target
          // (§1.11), and a group whose identity is its title would silently reroute other
          // Extensions' items the day this one is retitled.
          id: "commit",
          // Every key is distinct in more than case: the menu matches a single stroke, and
          // the parser lowercases it, so `a` and `A` would be the same entry.
          items: [
            {
              key: "c",
              label: "Commit",
              when: (status) => status.staged.length > 0,
              run: () => start({}),
            },
            {
              key: "s",
              label: "Commit with signoff",
              when: (status) => status.staged.length > 0,
              run: () => start({ signoff: true }),
            },
            {
              key: "a",
              label: "Stage all and commit",
              // Withdrawn entirely while anything is conflicted: `git add --all` would mark
              // those files resolved on the way past, and declaring a conflict resolved is
              // the files Pane's decision to offer, not a side effect of committing (§5.12).
              when: (status) => status.conflicted.length === 0 && status.unstaged.length + status.untracked.length > 0,
              run: async () => {
                try {
                  await ctx.git.stage("all")
                } catch (error) {
                  ctx.popups.notify(reason(error), "error")
                  return
                }
                await start({})
              },
            },
            {
              key: "m",
              label: "Amend the last commit",
              // Read from the store rather than the target: the menu's target is the working
              // tree, and whether there is a commit to amend is a fact about HEAD.
              when: () => ctx.git.state.head.kind !== "unborn",
              run: () => start({ amend: true }),
            },
            {
              key: "d",
              label: "Discard the kept draft",
              // The way out of a draft that is kept forever: `escape` never destroys a
              // message, so throwing one away has to be something the user asks for.
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

    // A flow outlives neither its editor nor this activation. Without this, an Extension
    // awaiting `begin` when a hot reload lands would wait on a Pane that no longer exists.
    // `endFlow`: the Layout re-lays-out around the departing Pane by itself, and a disposing
    // scope must not be reaching back into the Command registry to move focus.
    ctx.onDispose(() => {
      endFlow("abandoned")
    })

    return {
      begin: (opts) => open({ message: opts?.message, amend: opts?.amend, signoff: opts?.signoff }),
    }
  },
})
