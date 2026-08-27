/** @jsxImportSource @opentui/react */
import { stat } from "node:fs/promises"
import {
  createCell,
  createRowSource,
  defineExtension,
  describeGitFailure,
  isConflicted,
  isStaged,
  isUntracked,
  isUnstaged,
  remoteWebUrl,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type Commit,
  type CommitBrowserProps,
  type CommitsApi,
  type GitOperationKind,
  type Head,
  type PaneProps,
  type Theme,
} from "laziergit"
import { useEffect, useMemo, useState } from "react"

import { authorColor, authorInitials } from "./authors"
import { renderCommitGraph, type CommitGraphRow, type CommitGraphTone } from "./graph"

declare module "laziergit" {
  interface EventMap {
    "operations.completed": {
      readonly kind: GitOperationKind
      readonly resolution: "continue" | "abort" | "skip"
    }
  }
}

function isMerge(commit: Commit): boolean {
  return commit.parents.length > 1
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

function stripLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2)
  return value.endsWith("\n") ? value.slice(0, -1) : value
}

function validateRef(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return "Name the branch"
  if (/\s/.test(trimmed)) return "A ref name cannot contain spaces"
  return null
}

type ResetMode = "mixed" | "hard"
type RewriteAction = "squash" | "drop" | "edit"

interface CommitFile {
  /** `git diff --name-status`'s one-letter status after removing a rename score. */
  readonly status: string
  readonly path: string
  readonly previousPath: string | null
}

type CommitFilesLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly files: readonly CommitFile[] }
  | { readonly kind: "failed"; readonly message: string }

type CommitHistoryLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly commits: readonly Commit[] }
  | { readonly kind: "failed"; readonly message: string }

type CommitPaneView =
  | { readonly kind: "list"; readonly selectedOid: string | null }
  | { readonly kind: "files"; readonly commit: Commit }

interface AutoStash {
  readonly oid: string
}

interface PendingCherryPick {
  readonly autoStash: AutoStash | null
}

/** Why there is no log to draw. All three read as zero rows and mean different things. */
type EmptyReason = "noRepository" | "unborn" | "loaded"

function emptyReason(head: Head): EmptyReason {
  if (head.kind === "noRepository") return "noRepository"
  return head.kind === "unborn" ? "unborn" : "loaded"
}

/**
 * Parses `--name-status -z`: ordinary entries are status/path pairs, while renames and
 * copies carry status/old-path/new-path triples. NUL framing is what keeps tabs, spaces,
 * quotes, and backslashes in a repository path from becoming syntax.
 */
function parseCommitFiles(output: string): readonly CommitFile[] {
  if (output.length === 0) return []
  const fields = output.endsWith("\0") ? output.slice(0, -1).split("\0") : output.split("\0")
  const files: CommitFile[] = []

  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index]
    if (rawStatus === undefined || rawStatus.length === 0) {
      throw new Error("git returned a changed file without a status")
    }
    index += 1

    const status = rawStatus[0] ?? rawStatus
    if (status === "R" || status === "C") {
      const previousPath = fields[index]
      const path = fields[index + 1]
      if (previousPath === undefined || path === undefined) {
        throw new Error(`git returned an incomplete ${status === "R" ? "rename" : "copy"}`)
      }
      files.push({ status, path, previousPath })
      index += 2
      continue
    }

    const path = fields[index]
    if (path === undefined) throw new Error(`git returned an incomplete ${rawStatus} file change`)
    files.push({ status, path, previousPath: null })
    index += 1
  }

  return files
}

function commitFileColor(status: string, theme: Theme): string {
  if (status === "A") return theme.success
  if (status === "D") return theme.danger
  if (status === "R" || status === "C") return theme.info
  return theme.warning
}

function commitFileLabel(file: CommitFile): string {
  return file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`
}

function commitGraphColor(tone: CommitGraphTone, theme: Theme): string {
  if (tone === "neutral") return theme.textMuted
  if (tone === "highlight") return theme.text
  if (tone === "accent" || tone === "success" || tone === "warning" || tone === "info" || tone === "danger") {
    return theme[tone]
  }
  return tone
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
    const rows = createRowSource<Commit>({ pane: "commits", key: (row) => row.oid })
    const cherryPickQueue = createCell<readonly Commit[]>([])
    let pendingCherryPick: PendingCherryPick | null = null

    function report(error: unknown): void {
      ctx.popups.notify(describeGitFailure(error), "error")
    }

    function queueCommit(commit: Commit): void {
      const current = cherryPickQueue.get()
      if (current.some((candidate) => candidate.oid === commit.oid)) {
        ctx.popups.notify(`${commit.shortOid} is already queued`, "info")
      } else {
        cherryPickQueue.set([...current, commit])
        ctx.popups.notify(`Queued ${commit.shortOid} for cherry-pick`, "success")
      }
      cherryPickPane.reveal()
    }

    function removeQueuedCommit(commit: Commit): void {
      cherryPickQueue.set(cherryPickQueue.get().filter((candidate) => candidate.oid !== commit.oid))
    }

    function autoStashNeeded(): boolean {
      return ctx.git.state.status.files.some((file) => isStaged(file) || isUnstaged(file) || isUntracked(file))
    }

    async function saveAutoStash(): Promise<AutoStash | null> {
      if (!autoStashNeeded()) return null
      const includeUntracked = ctx.git.state.status.files.some(isUntracked)
      await ctx.git.stash.save({ message: "[laziergit] auto-stash before cherry-pick", includeUntracked })
      const entry = ctx.git.state.stash[0]
      if (entry === undefined) throw new Error("Git did not create the cherry-pick auto-stash")
      return { oid: entry.oid }
    }

    async function restoreAutoStash(autoStash: AutoStash | null): Promise<boolean> {
      if (autoStash === null) return true
      const entry = ctx.git.state.stash.find((candidate) => candidate.oid === autoStash.oid)
      if (entry === undefined) {
        ctx.popups.notify("The cherry-pick auto-stash is no longer in the stash list", "warning")
        return false
      }
      try {
        await ctx.git.stash.pop(entry.index)
        return true
      } catch (error) {
        ctx.popups.notify(
          `Cherry-pick finished, but restoring its auto-stash failed: ${describeGitFailure(error)}`,
          "error",
        )
        return false
      }
    }

    async function focusConflicts(): Promise<void> {
      try {
        await ctx.commands.execute("files.focus-conflict")
      } catch {
        try {
          await ctx.commands.execute("files.focus")
        } catch {
          // The operations status and menu remain available when the files Extension is absent.
        }
      }
    }

    function destinationLabel(): string | null {
      const head = ctx.git.state.head
      if (head.kind === "onBranch") return head.branch
      return head.kind === "detached" ? "detached HEAD" : null
    }

    async function pasteCherryPicks(): Promise<void> {
      const queued = cherryPickQueue.get()
      if (queued.length === 0 || pendingCherryPick !== null) return
      const destination = destinationLabel()
      if (destination === null) {
        ctx.popups.notify("Cherry-picking needs an existing commit checked out", "warning")
        return
      }
      if (ctx.git.state.operation.effective !== null) {
        ctx.popups.notify("Finish or abort the current Git operation before cherry-picking", "warning")
        return
      }
      if (ctx.git.state.status.files.some(isConflicted)) {
        ctx.popups.notify("Resolve the current conflicts before cherry-picking", "warning")
        return
      }

      const confirmed = await ctx.popups.confirm({
        title: "Cherry-pick queued commits?",
        message: `${plural(queued.length, "commit")} will be applied to ${destination} in the order shown.`,
        confirmLabel: "cherry-pick",
      })
      if (!confirmed) return

      let autoStash: AutoStash | null = null
      try {
        autoStash = await saveAutoStash()
      } catch (error) {
        report(error)
        return
      }

      pendingCherryPick = { autoStash }
      const args = [
        "cherry-pick",
        "--allow-empty",
        "--keep-redundant-commits",
        ...(queued.some(isMerge) ? ["-m", "1"] : []),
        ...queued.map((commit) => commit.oid),
      ]
      try {
        await ctx.git.raw(args)
      } catch (error) {
        if (ctx.git.state.operation.effective === "cherryPick") {
          ctx.popups.notify(
            "Cherry-pick stopped with conflicts. Resolve them, then press m to continue or abort.",
            "warning",
          )
          await focusConflicts()
          return
        }
        pendingCherryPick = null
        await restoreAutoStash(autoStash)
        report(error)
        return
      }

      pendingCherryPick = null
      cherryPickQueue.set([])
      if (await restoreAutoStash(autoStash)) {
        ctx.popups.notify(`Cherry-picked ${plural(queued.length, "commit")}`, "success")
      }
    }

    ctx.events.on("operations.completed", async ({ kind, resolution }) => {
      if (kind !== "cherryPick" || pendingCherryPick === null) return
      const pending = pendingCherryPick
      pendingCherryPick = null
      if (resolution !== "abort") cherryPickQueue.set([])
      await restoreAutoStash(pending.autoStash)
    })

    async function attempt(done: string, action: () => Promise<unknown>): Promise<void> {
      try {
        await action()
        ctx.popups.notify(done, "success")
      } catch (error) {
        report(error)
      }
    }

    async function createBranchAt(commit: Commit): Promise<void> {
      const name = await ctx.popups.prompt({
        title: `New branch at ${commit.shortOid}`,
        placeholder: "feature/…",
        validate: validateRef,
      })
      if (name === undefined) return
      try {
        await ctx.git.createBranch(name.trim(), { at: commit.oid, checkout: true })
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

    async function filesIn(commit: Commit): Promise<readonly CommitFile[]> {
      // This is the same first-parent comparison lazygit uses for its transient commit-files
      // context. `diff-tree --root` is needed only for the initial commit, where no parent
      // exists to give ordinary `git diff`.
      const args =
        commit.parents[0] === undefined
          ? ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames", commit.oid, "--"]
          : ["diff", "--no-ext-diff", "--name-status", "-z", "--find-renames", commit.parents[0], commit.oid, "--"]
      return parseCommitFiles((await ctx.git.raw(args)).stdout)
    }

    async function refExists(ref: string): Promise<boolean> {
      const output = await ctx.git.raw(["rev-parse", "--verify", "--quiet", ref], { allowFailure: true })
      return output.exitCode === 0
    }

    async function gitPathExists(name: string): Promise<boolean> {
      const output = await ctx.git.raw(["rev-parse", "--path-format=absolute", "--git-path", name])
      return pathExists(stripLineEnding(output.stdout))
    }

    async function rebaseInProgress(): Promise<boolean> {
      const stateDirectories = ["rebase-merge", "rebase-apply"] as const
      return (await Promise.all(stateDirectories.map(gitPathExists))).some(Boolean)
    }

    async function rewriteReady(commit: Commit): Promise<boolean> {
      if (!canRewrite(commit)) {
        ctx.popups.notify("Only non-merge commits on the checked-out branch can be rewritten", "warning")
        return false
      }

      const refs = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] as const
      if ((await Promise.all([rebaseInProgress(), ...refs.map(refExists)])).some(Boolean)) {
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
          // Match lazygit: let Git protect tracked index and worktree changes for the rewrite,
          // then restore them when the rebase completes or is aborted.
          "--autostash",
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
      if ((await rebaseInProgress()) && ctx.git.state.status.files.some(isConflicted)) {
        ctx.popups.notify(`Rewrite stopped with conflicts. Resolve them, then press m to continue or abort.`, "warning")
        return
      }
      const ownsRebase = (await rebaseInProgress()) || (await headOid()) !== originalHead
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

    ctx.commands.register({
      id: "commits.create-branch",
      source: rows.api,
      title: "Create branch here",
      hint: "new branch",
      keys: "n",
      run: createBranchAt,
    })
    ctx.commands.register({
      id: "commits.checkout",
      source: rows.api,
      title: "Check out this commit",
      keys: "c",
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
    })
    ctx.commands.register({
      id: "commits.revert",
      source: rows.api,
      title: "Revert this commit",
      keys: "v",
      // `git revert` rejects a merge without `-m`, and this Pane draws no topology to choose a mainline.
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
    })
    ctx.commands.register({
      id: "commits.open-remote",
      source: rows.api,
      title: "Open this commit on the remote",
      keys: "o",
      when: () => remoteWebUrl(ctx.git.state.remotes) !== null,
      run: async (commit) => {
        const base = remoteWebUrl(ctx.git.state.remotes)
        if (base === null) return ctx.popups.notify("No web remote configured", "warning")
        await ctx.open(`${base}/commit/${commit.oid}`)
      },
    })
    ctx.commands.register({
      id: "commits.copy-oid",
      source: rows.api,
      title: "Copy the full commit oid",
      keys: "y",
      run: (commit) => attempt(`Copied ${commit.shortOid}`, () => ctx.copy(commit.oid)),
    })
    ctx.commands.register({
      id: "commits.squash",
      source: rows.api,
      title: "Squash into the parent commit",
      keys: "s",
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
    })
    ctx.commands.register({
      id: "commits.reword",
      source: rows.api,
      title: "Reword this commit",
      keys: "r",
      when: canRewrite,
      run: reword,
    })
    ctx.commands.register({
      id: "commits.drop",
      source: rows.api,
      title: "Drop this commit",
      keys: "d",
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
    })
    const mixedResetCommand = ctx.commands.register({
      id: "commits.reset-mixed",
      source: rows.api,
      title: "Reset mixed to this commit",
      keys: "m",
      when: () => ctx.git.state.operation.effective === null,
      run: (commit) => runReset(commit, "mixed"),
    })
    ctx.git.subscribe(
      (state) => state.operation,
      () => mixedResetCommand.refresh(),
    )
    ctx.commands.register({
      id: "commits.reset-hard",
      source: rows.api,
      title: "Reset hard to this commit",
      keys: "h",
      run: (commit) => runReset(commit, "hard"),
    })

    function CommitRow({
      commit,
      graph,
      id,
      selected,
      focused,
      queued,
      onSelect,
    }: {
      readonly commit: Commit
      readonly graph: CommitGraphRow
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
      readonly queued: boolean
      readonly onSelect: () => void
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(commit)
      const dim = decoration?.dim === true
      const badge = decoration?.badge
      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined} onMouseDown={onSelect}>
          <span fg={dim ? theme.textMuted : queued ? theme.info : theme.accent}>{`${commit.shortOid} `}</span>
          <span fg={dim ? theme.textMuted : authorColor(commit.author.name)}>
            {`${authorInitials(commit.author.name)} `}
          </span>
          {graph.map((span, index) => (
            <span key={index} fg={dim ? theme.textMuted : commitGraphColor(span.tone, theme)}>
              {span.text}
            </span>
          ))}
          <span fg={dim ? theme.textMuted : theme.text}>{commit.subject}</span>
          {queued ? <span fg={theme.info}> queued</span> : null}
          {badge === undefined ? null : <span fg={toneColor(theme, decoration?.tone)}>{`  ${badge}`}</span>}
        </text>
      )
    }

    function CommitList({
      commits,
      focused,
      selectedOid,
      emptyMessage,
      publishSelection,
      idPrefix,
      onOpen,
    }: {
      readonly commits: readonly Commit[]
      readonly focused: boolean
      readonly selectedOid: string | null
      readonly emptyMessage: string
      readonly publishSelection: boolean
      readonly idPrefix: string
      readonly onOpen: (commit: Commit) => void
    }) {
      const theme = useTheme()
      const cursor = useListCursor({
        items: commits,
        idPrefix,
        noun: "commit",
        query: {
          mode: "search",
          fields: (commit) => [commit.oid, commit.shortOid, commit.subject, commit.author.name, commit.author.email],
        },
      })
      const selected = cursor.selected
      const graph = useMemo(() => renderCommitGraph(commits, selected?.oid), [commits, selected?.oid])
      const queued = cherryPickQueue.use()
      const queuedOids = useMemo(() => new Set(queued.map((commit) => commit.oid)), [queued])

      useEffect(() => {
        if (selectedOid === null) return
        const index = commits.findIndex((commit) => commit.oid === selectedOid)
        if (index !== -1) cursor.setIndex(index)
      }, [commits, selectedOid])

      useEffect(() => {
        if (!publishSelection) return
        rows.setSelected(selected)
        return () => rows.setSelected(undefined)
      }, [publishSelection, selected])

      useEffect(() => {
        // Only while focused: the diff belongs to whichever list the user is driving.
        if (!focused || selected === undefined) return
        diff.show({ kind: "commit", ref: selected.oid, path: null })
      }, [focused, selected])

      // OpenTUI calls the key `return`; `enter` would appear in the cheat sheet but never run.
      useCommand({
        id: `${idPrefix}.view-files`,
        title: "View files changed by commit",
        hint: "files",
        keys: "return",
        run: () => {
          if (selected !== undefined) onOpen(selected)
        },
      })
      useCommand({
        id: `${idPrefix}.queue-cherry-pick`,
        title: "Queue commit for cherry-pick",
        hint: "queue",
        keys: "shift+c",
        when: () => pendingCherryPick === null,
        run: () => {
          if (selected !== undefined) queueCommit(selected)
        },
      })
      useCommand({
        id: `${idPrefix}.paste-cherry-picks`,
        title: "Paste queued cherry-picks",
        hint: "paste",
        keys: "shift+v",
        when: () => queued.length > 0 && pendingCherryPick === null,
        run: pasteCherryPicks,
      })

      if (commits.length === 0) {
        return <text fg={theme.textMuted} content={emptyMessage} />
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
                graph={graph[index] ?? []}
                selected={index === cursor.index}
                focused={focused}
                queued={queuedOids.has(commit.oid)}
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

    function CommitFiles({
      commit,
      focused,
      idPrefix,
      onBack,
    }: {
      readonly commit: Commit
      readonly focused: boolean
      readonly idPrefix: string
      readonly onBack: () => void
    }) {
      const theme = useTheme()
      const [load, setLoad] = useState<CommitFilesLoad>({ kind: "loading" })
      const files = load.kind === "ready" ? load.files : []
      const cursor = useListCursor({
        items: files,
        idPrefix: `${idPrefix}.files`,
        noun: "changed file",
        query: {
          mode: "filter",
          fields: (file) =>
            file.previousPath === null ? [file.status, file.path] : [file.status, file.previousPath, file.path],
        },
      })
      const selected = cursor.selected

      useEffect(() => {
        let current = true
        setLoad({ kind: "loading" })
        void filesIn(commit).then(
          (next) => {
            if (current) setLoad({ kind: "ready", files: next })
          },
          (error) => {
            if (current) setLoad({ kind: "failed", message: describeGitFailure(error) })
          },
        )
        return () => {
          current = false
        }
      }, [commit])

      useEffect(() => {
        if (!focused) return
        diff.show({ kind: "commit", ref: commit.oid, path: selected?.path ?? null })
      }, [commit, focused, selected])

      useCommand({
        id: `${idPrefix}.files.back`,
        title: "Back to commits",
        hint: "back",
        keys: "escape",
        run: onBack,
      })

      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <text wrapMode="none">
            <span fg={theme.accent}>{`${commit.shortOid}  `}</span>
            <span fg={theme.text}>{commit.subject}</span>
          </text>
          {load.kind === "loading" ? (
            <text fg={theme.textMuted} content="loading changed files…" />
          ) : load.kind === "failed" ? (
            <text fg={theme.danger} content={load.message} />
          ) : files.length === 0 ? (
            <text fg={theme.textMuted} content="no files changed" />
          ) : cursor.items.length === 0 ? (
            <text fg={theme.textMuted} content="no matching files" />
          ) : (
            <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
              {cursor.items.map((file, index) => (
                <text
                  key={`${file.previousPath ?? ""}\0${file.path}`}
                  id={cursor.rowId(index)}
                  wrapMode="none"
                  bg={index === cursor.index && focused ? theme.selection : undefined}
                  onMouseDown={() => cursor.setIndex(index)}
                >
                  <span fg={commitFileColor(file.status, theme)}>{`${file.status}  `}</span>
                  <span fg={theme.text}>{commitFileLabel(file)}</span>
                </text>
              ))}
            </scrollbox>
          )}
        </box>
      )
    }

    function CommitsPane({ focused }: PaneProps) {
      const [view, setView] = useState<CommitPaneView>({ kind: "list", selectedOid: null })
      const commits = useGit((state) => state.commits)
      const empty = useGit((state) => emptyReason(state.head))
      const emptyMessage =
        empty === "noRepository"
          ? "no repository here"
          : empty === "unborn"
            ? "no commits yet — your first commit will appear here"
            : "no commits to show"

      return view.kind === "list" ? (
        <CommitList
          commits={commits}
          focused={focused}
          selectedOid={view.selectedOid}
          emptyMessage={emptyMessage}
          publishSelection={true}
          idPrefix="commits"
          onOpen={(commit) => setView({ kind: "files", commit })}
        />
      ) : (
        <CommitFiles
          commit={view.commit}
          focused={focused}
          idPrefix="commits"
          onBack={() => setView({ kind: "list", selectedOid: view.commit.oid })}
        />
      )
    }

    function CommitBrowserList({
      load,
      title,
      focused,
      selectedOid,
      idPrefix,
      onOpen,
      onBack,
    }: Omit<CommitBrowserProps, "revision"> & {
      readonly load: CommitHistoryLoad
      readonly selectedOid: string | null
      readonly onOpen: (commit: Commit) => void
    }) {
      const theme = useTheme()

      useCommand({
        id: `${idPrefix}.back`,
        title: "Back to branches",
        hint: "back",
        keys: "escape",
        run: onBack,
      })

      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <text wrapMode="none">
            <span fg={theme.accent}>{title}</span>
            <span fg={theme.textMuted}> commits</span>
          </text>
          {load.kind === "loading" ? (
            <text fg={theme.textMuted} content="loading commits…" />
          ) : load.kind === "failed" ? (
            <text fg={theme.danger} content={load.message} />
          ) : (
            <CommitList
              commits={load.commits}
              focused={focused}
              selectedOid={selectedOid}
              emptyMessage="no commits for this branch"
              publishSelection={false}
              idPrefix={idPrefix}
              onOpen={onOpen}
            />
          )}
        </box>
      )
    }

    /** The lazygit-style transient history used by branches and any other ref-owning Pane. */
    function CommitBrowser({ revision, title, focused, idPrefix, onBack }: CommitBrowserProps) {
      const [load, setLoad] = useState<CommitHistoryLoad>({ kind: "loading" })
      const [view, setView] = useState<CommitPaneView>({ kind: "list", selectedOid: null })

      useEffect(() => {
        let current = true
        setLoad({ kind: "loading" })
        void ctx.git.commits(revision).then(
          (commits) => {
            if (current) setLoad({ kind: "ready", commits })
          },
          (error) => {
            if (current) setLoad({ kind: "failed", message: describeGitFailure(error) })
          },
        )
        return () => {
          current = false
        }
      }, [revision])

      if (view.kind === "files") {
        return (
          <CommitFiles
            commit={view.commit}
            focused={focused}
            idPrefix={idPrefix}
            onBack={() => setView({ kind: "list", selectedOid: view.commit.oid })}
          />
        )
      }

      return (
        <CommitBrowserList
          load={load}
          title={title}
          focused={focused}
          selectedOid={view.selectedOid}
          idPrefix={idPrefix}
          onOpen={(commit) => setView({ kind: "files", commit })}
          onBack={onBack}
        />
      )
    }

    function CherryPickPane({ focused }: PaneProps) {
      const theme = useTheme()
      const queued = cherryPickQueue.use()
      const cursor = useListCursor({
        items: queued,
        idPrefix: "commits.cherry-pick",
        noun: "queued commit",
        query: {
          mode: "filter",
          fields: (commit) => [commit.oid, commit.shortOid, commit.subject, commit.author.name],
        },
      })
      const selected = cursor.selected

      useEffect(() => {
        if (!focused || selected === undefined) return
        diff.show({ kind: "commit", ref: selected.oid, path: null })
      }, [focused, selected])

      useCommand({
        id: "commits.cherry-pick.drop",
        title: "Drop queued cherry-pick",
        hint: "drop",
        keys: "d",
        when: () => selected !== undefined && pendingCherryPick === null,
        run: () => {
          if (selected !== undefined) removeQueuedCommit(selected)
        },
      })
      useCommand({
        id: "commits.cherry-pick.paste",
        title: "Paste queued cherry-picks",
        hint: "paste",
        keys: "shift+v",
        when: () => queued.length > 0 && pendingCherryPick === null,
        run: pasteCherryPicks,
      })

      if (queued.length === 0) {
        return <text fg={theme.textMuted}>no commits queued — C in a commit list adds one</text>
      }
      if (cursor.items.length === 0) return <text fg={theme.textMuted}>no matching queued commits</text>

      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <text fg={theme.textMuted}> paste order</text>
          <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
            {cursor.items.map((commit, index) => (
              <text
                key={commit.oid}
                id={cursor.rowId(index)}
                wrapMode="none"
                bg={index === cursor.index && focused ? theme.selection : undefined}
                onMouseDown={() => cursor.setIndex(index)}
              >
                <span fg={theme.textMuted}>{`${queued.indexOf(commit) + 1}. `}</span>
                <span fg={theme.info}>{`${commit.shortOid} `}</span>
                <span fg={theme.text}>{commit.subject}</span>
              </text>
            ))}
          </scrollbox>
        </box>
      )
    }

    const pane = ctx.panes.register({
      id: "commits",
      title: "Commits",
      component: CommitsPane,
      placement: { column: 0, order: 40 },
    })
    const cherryPickPane = ctx.panes.register({
      id: "commits.cherry-pick",
      title: "Cherry Pick",
      component: CherryPickPane,
      placement: { tabWith: "stash" },
    })

    // Keyless: core binds `1`–`9` positionally over the Layout.
    ctx.commands.register({
      id: "commits.focus",
      title: "Focus commits",
      run: () => pane.focus(),
    })
    ctx.commands.register({
      id: "commits.cherry-pick.focus",
      title: "Focus cherry-pick queue",
      run: () => cherryPickPane.focus(),
    })

    return { ...rows.api, renderBrowser: CommitBrowser }
  },
})
