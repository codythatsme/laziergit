/** @jsxImportSource @opentui/react */
import type { TextRenderable } from "@opentui/core"
import {
  createCell,
  createRowSource,
  defineExtension,
  describeGitFailure,
  GitError,
  isConflicted,
  toneColor,
  useCommand,
  useGit,
  useGitActivity,
  useListCursor,
  useTheme,
  type Branch,
  type BranchesApi,
  type CommitBrowserProps,
  type Head,
  type PaneProps,
  type Theme,
  type Tone,
  type UpstreamInfo,
} from "laziergit"
import { useEffect, useRef, useState } from "react"
import stringWidth from "string-width"

import { mergeArgs, mergeChoices, squashCommitMessage, type MergeMode } from "./merge"
import {
  cleanableBranches,
  githubRepository,
  mergedPullRequestQueryArgs,
  parsePullRequestQuery,
  pullRequestQueryArgs,
  pullRequestsByBranch,
  pullRequestUrl,
  type PullRequest,
} from "./pull-request"
import { useSpinner } from "./spinner"

// Font Awesome's mark fills its cell more fully than the smaller Devicons GitHub glyph.
const githubGlyph = ""
const pullRequestRefreshIntervalMs = 60_000
const pullRequestQueryConcurrency = 5
const pullRequestQueryMinimumSize = 10
const ellipsis = "..."
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** OpenTUI's built-in truncation preserves both ends. Branches read like paths, so preserve the start. */
function truncateEnd(value: string, width: number): string {
  if (width <= 0) return ""
  if (stringWidth(value) <= width) return value
  if (width <= ellipsis.length) return ellipsis.slice(0, width)

  const contentWidth = width - ellipsis.length
  let visible = ""
  let used = 0
  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = stringWidth(segment)
    if (used + segmentWidth > contentWidth) break
    visible += segment
    used += segmentWidth
  }
  return `${visible}${ellipsis}`
}

function BranchName({ name, color }: { readonly name: string; readonly color: string }) {
  const text = useRef<TextRenderable>(null)

  const resize = (width: number): void => {
    const visible = truncateEnd(name, width)
    if (text.current !== null && text.current.plainText !== visible) text.current.content = visible
  }

  return (
    <box
      flexBasis={stringWidth(name)}
      flexShrink={1}
      minWidth={0}
      overflow="hidden"
      onSizeChange={function () {
        resize(this.width)
      }}
    >
      <text ref={text} width="100%" wrapMode="none" content={name} fg={color} />
    </box>
  )
}

function divergence(upstream: UpstreamInfo | null): string {
  if (upstream === null || upstream.gone) return ""
  const parts: string[] = []
  if (upstream.ahead > 0) parts.push(`↑${upstream.ahead}`)
  if (upstream.behind > 0) parts.push(`↓${upstream.behind}`)
  return parts.join(" ")
}

// A gone upstream reports `ahead === 0, behind === 0`, so only the name can carry it.
function nameColor(branch: Branch, theme: Theme, dim: boolean): string {
  if (dim) return theme.textMuted
  if (branch.upstream?.gone === true) return theme.danger
  return theme.text
}

function hasRepository(head: Head): boolean {
  return head.kind !== "noRepository"
}

// Every `git branch -d` refusal exits 1, so only the message tells them apart.
function isUnmerged(error: unknown): boolean {
  return error instanceof GitError && /not fully merged/i.test(error.stderr)
}

function canFastForward(branch: Branch): boolean {
  const upstream = branch.upstream
  return upstream !== null && !upstream.gone && upstream.behind > 0 && upstream.ahead === 0
}

function isUpToDate(branch: Branch): boolean {
  const upstream = branch.upstream
  return upstream !== null && !upstream.gone && upstream.ahead === 0 && upstream.behind === 0
}

function pullRequestTone(pullRequest: PullRequest): Tone {
  if (pullRequest.isDraft) return "muted"
  switch (pullRequest.state.toUpperCase()) {
    case "OPEN":
      return "success"
    case "MERGED":
      return "info"
    case "CLOSED":
      return "danger"
    default:
      return "neutral"
  }
}

function validateRef(value: string, empty: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return empty
  if (/\s/.test(trimmed)) return "A ref name cannot contain spaces"
  return null
}

function pullRequestBranchChunks(branches: readonly string[]): readonly (readonly string[])[] {
  const branchesPerQuery = Math.max(
    Math.ceil(branches.length / pullRequestQueryConcurrency),
    pullRequestQueryMinimumSize,
  )
  return Array.from({ length: Math.ceil(branches.length / branchesPerQuery) }, (_, index) =>
    branches.slice(index * branchesPerQuery, (index + 1) * branchesPerQuery),
  )
}

type BranchPaneView =
  | { readonly kind: "list"; readonly selectedName: string | null }
  | { readonly kind: "commits"; readonly branchName: string }

export default defineExtension({
  name: "branches",
  description: "Local branches with their upstream divergence",
  needs: ["diff", "commits"],

  activate(ctx): BranchesApi {
    const rows = createRowSource<Branch>({ pane: "branches", key: (row) => row.name })
    const diff = ctx.extensions.get("diff")
    const pullRequests = createCell<ReadonlyMap<string, PullRequest>>(new Map())
    let pullRequestTicket = 0
    let pullRequestFingerprint = ""
    let pullRequestLastAttemptAt = 0
    let pullRequestInFlight:
      | {
          readonly fingerprint: string
          readonly result: Promise<ReadonlyMap<string, PullRequest> | null>
        }
      | undefined
    const renderCommitBrowser = ctx.extensions.get("commits").renderBrowser

    // The shared renderer owns hooks, so it gets a stable component boundary in this Pane.
    function CommitBrowser(props: CommitBrowserProps) {
      return renderCommitBrowser(props)
    }

    const fail = (error: unknown): void => ctx.popups.notify(describeGitFailure(error), "error")

    /**
     * GitHub metadata is optional: a repository without `gh`, authentication, or a GitHub
     * remote keeps the ordinary git-only branch UI. Identical snapshots share one request;
     * the ticket prevents an older repository snapshot from replacing a newer one.
     */
    async function refreshPullRequests(force = false): Promise<ReadonlyMap<string, PullRequest> | null> {
      const { branches, remotes } = ctx.git.state
      const repository = githubRepository(remotes)
      const trackedBranches = [
        ...new Set(branches.flatMap((branch) => (branch.upstream === null ? [] : [branch.upstream.branch]))),
      ]
      if (repository === null || trackedBranches.length === 0) {
        const issued = (pullRequestTicket += 1)
        const empty = new Map<string, PullRequest>()
        if (issued === pullRequestTicket) pullRequests.set(empty)
        return empty
      }

      const fingerprint = JSON.stringify([
        repository,
        trackedBranches,
        remotes.map((remote) => [remote.name, remote.fetchUrl]),
      ])
      if (pullRequestInFlight?.fingerprint === fingerprint) return pullRequestInFlight.result
      if (!force && pullRequestFingerprint === fingerprint) return pullRequests.get()

      const issued = (pullRequestTicket += 1)
      const chunks = pullRequestBranchChunks(trackedBranches)
      pullRequestLastAttemptAt = Date.now()
      const result = (async (): Promise<ReadonlyMap<string, PullRequest> | null> => {
        try {
          const outputs = await Promise.all(
            chunks.map((chunk) => ctx.exec("gh", pullRequestQueryArgs(repository, chunk))),
          )
          if (outputs.some((output) => output.exitCode !== 0)) return null
          const prs = outputs.flatMap((output) => parsePullRequestQuery(output.stdout))
          const mapped = pullRequestsByBranch(prs, branches, remotes)
          if (issued === pullRequestTicket) {
            pullRequestFingerprint = fingerprint
            pullRequests.set(mapped)
          }
          return mapped
        } catch {
          return null
        }
      })()
      pullRequestInFlight = { fingerprint, result }
      void result.finally(() => {
        if (pullRequestInFlight?.result === result) pullRequestInFlight = undefined
      })
      return result
    }

    void refreshPullRequests()
    ctx.events.on("git.branches.changed", () => void refreshPullRequests())
    ctx.events.on("git.remotes.changed", () => void refreshPullRequests())
    ctx.events.on("git.refreshed", () => {
      if (Date.now() - pullRequestLastAttemptAt >= pullRequestRefreshIntervalMs) void refreshPullRequests(true)
    })

    function currentBranch(): string | null {
      const head = ctx.git.state.head
      return head.kind === "onBranch" ? head.branch : null
    }

    function hasConflicts(): boolean {
      return ctx.git.state.status.files.some(isConflicted)
    }

    async function mergeInProgress(): Promise<boolean> {
      const result = await ctx.git.raw(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], {
        allowFailure: true,
      })
      return result.exitCode === 0
    }

    async function canMergeFastForward(branch: Branch): Promise<boolean> {
      const args = ["merge-base", "--is-ancestor", "HEAD", branch.oid] as const
      const result = await ctx.git.raw(args, { allowFailure: true })
      if (result.exitCode === 0) return true
      if (result.exitCode === 1) return false
      throw new GitError(args, result)
    }

    async function abortMerge(): Promise<void> {
      try {
        await ctx.git.raw(["merge", "--abort"])
        ctx.popups.notify("Merge aborted", "success")
      } catch (error) {
        fail(error)
      }
    }

    async function abortSquashMerge(): Promise<void> {
      try {
        await ctx.git.raw(["reset", "--merge", "ORIG_HEAD"])
        ctx.popups.notify("Squash merge aborted", "success")
      } catch (error) {
        fail(error)
      }
    }

    async function continueMerge(): Promise<void> {
      try {
        if (!(await mergeInProgress())) {
          ctx.popups.notify("No merge is in progress", "warning")
          return
        }
        if (hasConflicts()) {
          ctx.popups.notify("Resolve and stage every conflict before continuing", "warning")
          return
        }
        // `merge --continue` opens an editor on piped stdio. `commit --no-edit` consumes the
        // same MERGE_MSG without asking for terminal input.
        await ctx.git.raw(["commit", "--no-edit"])
        ctx.popups.notify("Merge completed", "success")
      } catch (error) {
        fail(error)
      }
    }

    async function openMergeRecovery(): Promise<void> {
      const branch = currentBranch()
      const choice = await ctx.popups.select({
        title: branch === null ? "Merge in progress" : `Merge in progress on ${branch}`,
        items: [
          { label: "Continue merge", value: "continue" as const },
          { label: "Abort merge", value: "abort" as const },
          { label: "View files", value: "view" as const },
        ],
      })
      if (choice === "continue") await continueMerge()
      else if (choice === "abort") await abortMerge()
      else if (choice === "view") await ctx.commands.execute("files.focus")
    }

    async function handleMergeConflict(branch: Branch, mode: MergeMode): Promise<void> {
      const squash = mode === "squash" || mode === "squash-commit"
      const choice = await ctx.popups.select({
        title: `Merge ${branch.name} stopped with conflicts`,
        items: [
          { label: "View conflicted files", value: "view" as const },
          { label: squash ? "Abort squash merge" : "Abort merge", value: "abort" as const },
        ],
      })
      if (choice === "view") await ctx.commands.execute("files.focus")
      else if (choice === "abort") await (squash ? abortSquashMerge() : abortMerge())
    }

    async function mergeBranch(branch: Branch, mode: MergeMode): Promise<void> {
      const into = currentBranch()
      if (into === null) {
        ctx.popups.notify("Check out a local branch before merging", "warning")
        return
      }
      if (branch.name === into) {
        ctx.popups.notify(`Cannot merge ${branch.name} into itself`, "warning")
        return
      }

      try {
        await ctx.git.raw(mergeArgs(branch.name, mode))
        if (mode === "squash-commit") {
          await ctx.git.commit(squashCommitMessage(branch.name, into))
          ctx.popups.notify(`Squash-merged ${branch.name} into ${into}`, "success")
        } else if (mode === "squash") {
          ctx.popups.notify(`Squash-merged ${branch.name}; the changes are staged`, "success")
        } else {
          ctx.popups.notify(`Merged ${branch.name} into ${into}`, "success")
        }
      } catch (error) {
        if (error instanceof GitError && hasConflicts()) {
          await handleMergeConflict(branch, mode)
          return
        }
        fail(error)
      }
    }

    async function openMergeMenu(branch: Branch): Promise<void> {
      try {
        if (await mergeInProgress()) {
          await openMergeRecovery()
          return
        }

        const into = currentBranch()
        if (into === null) {
          ctx.popups.notify("Check out a local branch before merging", "warning")
          return
        }
        if (branch.name === into) {
          ctx.popups.notify(`Cannot merge ${branch.name} into itself`, "warning")
          return
        }
        if (hasConflicts()) {
          ctx.popups.notify("Resolve the current conflicts before starting a merge", "warning")
          return
        }

        const choices = mergeChoices(await canMergeFastForward(branch))
        const mode = await ctx.popups.select({
          title: `Merge ${branch.name} into ${into}`,
          items: choices.map((choice) => ({ label: choice.label, value: choice.mode })),
        })
        if (mode !== undefined) await mergeBranch(branch, mode)
      } catch (error) {
        fail(error)
      }
    }

    async function checkout(branch: Branch): Promise<void> {
      // `git checkout` on the current branch is a silent no-op.
      if (branch.isHead) return ctx.popups.notify(`Already on ${branch.name}`, "info")
      try {
        await ctx.git.checkout(branch.name)
      } catch (error) {
        fail(error)
      }
    }

    async function createBranchAt(base: Branch | undefined): Promise<void> {
      const name = await ctx.popups.prompt({
        title: base === undefined ? "New branch" : `New branch at ${base.name}`,
        placeholder: "feature/…",
        validate: (value) => validateRef(value, "Name the branch"),
      })
      if (name === undefined) return
      try {
        await ctx.git.createBranch(name.trim(), { at: base?.name, checkout: true })
      } catch (error) {
        fail(error)
      }
    }

    async function renameBranch(branch: Branch): Promise<void> {
      if (
        branch.upstream !== null &&
        !(await ctx.popups.confirm({
          title: `Rename ${branch.name}?`,
          message: "Only the local branch will be renamed; its remote branch keeps its current name.",
          confirmLabel: "continue",
        }))
      ) {
        return
      }

      const name = await ctx.popups.prompt({
        title: "Rename branch",
        initial: branch.name,
        validate: (value) => validateRef(value, "Name the branch"),
      })
      const renamed = name?.trim()
      if (renamed === undefined || renamed === branch.name) return

      try {
        await ctx.git.raw(["branch", "--move", branch.name, renamed])
        ctx.popups.notify(`Renamed ${branch.name} to ${renamed}`, "success")
      } catch (error) {
        fail(error)
      }
    }

    async function copyBranchName(branch: Branch): Promise<void> {
      try {
        await ctx.copy(branch.name)
        ctx.popups.notify(`Copied ${branch.name}`, "success")
      } catch (error) {
        fail(error)
      }
    }

    async function forceDelete(branch: Branch, message: string): Promise<void> {
      const confirmed = await ctx.popups.confirm({
        title: `Force delete ${branch.name}?`,
        message,
        confirmLabel: "Force delete",
        danger: true,
      })
      if (!confirmed) return
      try {
        await ctx.git.deleteBranch(branch.name, { force: true })
      } catch (error) {
        fail(error)
      }
    }

    async function deleteBranch(branch: Branch): Promise<void> {
      if (branch.isHead) return ctx.popups.notify(`Cannot delete ${branch.name}: you are on it`, "warning")
      const confirmed = await ctx.popups.confirm({
        title: `Delete ${branch.name}?`,
        message: "Deletes the local branch only.",
        danger: true,
      })
      if (!confirmed) return
      try {
        await ctx.git.deleteBranch(branch.name)
      } catch (error) {
        if (!isUnmerged(error)) return fail(error)
        await forceDelete(branch, `${branch.name} has commits no other branch has. They become unreachable.`)
      }
    }

    async function cleanBranches(): Promise<void> {
      if (!hasRepository(ctx.git.state.head)) {
        ctx.popups.notify("No repository here to clean", "warning")
        return
      }
      if (githubRepository(ctx.git.state.remotes) === null) {
        ctx.popups.notify("Cleaning branches requires a GitHub remote", "warning")
        return
      }

      try {
        // A branch only becomes `gone` after its remote-tracking ref is pruned. Refresh that
        // evidence before proposing any destructive local operation.
        await ctx.git.raw(["fetch", "--all", "--prune"])
        const { branches, remotes } = ctx.git.state
        const gone = branches.filter((branch) => !branch.isHead && branch.upstream?.gone === true)
        if (gone.length === 0) {
          ctx.popups.notify("No local branches have a deleted upstream to clean", "info")
          return
        }

        const repository = githubRepository(remotes)
        if (repository === null) {
          ctx.popups.notify("Cleaning branches requires a GitHub remote", "warning")
          return
        }
        const trackedBranches = [...new Set(gone.map((branch) => branch.upstream?.branch ?? branch.name))]
        const mergedPullRequests: PullRequest[] = []
        for (let index = 0; index < trackedBranches.length; index += pullRequestQueryConcurrency) {
          const outputs = await Promise.all(
            trackedBranches
              .slice(index, index + pullRequestQueryConcurrency)
              .map((branch) => ctx.exec("gh", mergedPullRequestQueryArgs(repository, branch))),
          )
          const failed = outputs.find((output) => output.exitCode !== 0)
          if (failed !== undefined) {
            throw new Error(failed.stderr.trim() || "GitHub could not inspect merged pull requests")
          }
          mergedPullRequests.push(...outputs.flatMap((output) => parsePullRequestQuery(output.stdout)))
        }

        const candidates = cleanableBranches(mergedPullRequests, branches, remotes)
        if (candidates.length === 0) {
          ctx.popups.notify("No deleted-upstream branches have a merged PR at their current head", "info")
          return
        }

        const noun = candidates.length === 1 ? "branch" : "branches"
        const confirmed = await ctx.popups.confirm({
          title: `Delete ${candidates.length} local ${noun}?`,
          message: [
            `Permanently delete the following local ${noun}:`,
            "",
            ...candidates.map((branch) => `• ${branch.name}`),
            "",
            "Each upstream is gone and a merged pull request has the same head commit.",
          ].join("\n"),
          confirmLabel: candidates.length === 1 ? "Delete branch" : `Delete ${candidates.length} branches`,
          danger: true,
        })
        if (!confirmed) return

        const deleted: string[] = []
        const failures: { readonly name: string; readonly error: unknown }[] = []
        for (const branch of candidates) {
          try {
            const current = await ctx.git.raw(["rev-parse", "--verify", `refs/heads/${branch.name}^{commit}`], {
              allowFailure: true,
            })
            if (current.exitCode !== 0 || current.stdout.trim() !== branch.oid) {
              throw new Error("branch moved after the confirmation was prepared")
            }
            // Merged PRs may have been squash- or rebase-merged, so ordinary `branch -d`
            // cannot prove them merged into the current HEAD. The exact-oid check above is
            // the safety proof for this deliberate force deletion.
            await ctx.git.deleteBranch(branch.name, { force: true })
            deleted.push(branch.name)
          } catch (error) {
            failures.push({ name: branch.name, error })
          }
        }

        if (failures.length === 0) {
          ctx.popups.notify(
            deleted.length === 1 ? `Deleted local branch ${deleted[0]}` : `Deleted ${deleted.length} local branches`,
            "success",
          )
          return
        }

        const deletedSummary = deleted.length === 0 ? "No branches were deleted." : `Deleted: ${deleted.join(", ")}.`
        ctx.popups.notify(
          `${deletedSummary}\nCould not delete:\n${failures
            .map(({ name, error }) => `${name}: ${describeGitFailure(error)}`)
            .join("\n")}`,
          "error",
        )
      } catch (error) {
        fail(error)
      }
    }

    async function setUpstream(branch: Branch): Promise<void> {
      const remotes = ctx.git.state.remotes.map((remote) => remote.name)
      const remote = branch.upstream?.remote ?? (remotes.includes("origin") ? "origin" : remotes[0])
      const value = await ctx.popups.prompt({
        title: `Upstream for ${branch.name}`,
        placeholder: "remote/branch",
        initial: `${remote ?? "origin"}/${branch.upstream?.branch ?? branch.name}`,
        validate: (input) => validateRef(input, "Name the upstream ref"),
      })
      if (value === undefined) return
      try {
        await ctx.git.raw(["branch", "--set-upstream-to", value.trim(), "--", branch.name])
      } catch (error) {
        fail(error)
      }
    }

    async function pushSettingUpstream(branch: Branch): Promise<void> {
      try {
        await ctx.git.push({ ref: branch.name, setUpstream: true })
      } catch (error) {
        fail(error)
      }
    }

    async function fastForward(branch: Branch): Promise<void> {
      const upstream = branch.upstream
      if (upstream === null) return
      try {
        if (branch.isHead) await ctx.git.raw(["merge", "--ff-only", `${upstream.remote}/${upstream.branch}`])
        // A branch you are not on cannot be merged into; fetching into its ref moves it, and
        // git refuses there if it would not be a fast-forward.
        else await ctx.git.raw(["fetch", upstream.remote, `${upstream.branch}:${branch.name}`])
      } catch (error) {
        fail(error)
      }
    }

    // Not gated on the branch having an upstream: a branch can be on the remote without one
    // configured, and an unpushed branch gets a 404 from the host.
    async function openPullRequest(branch: Branch): Promise<void> {
      let existing = pullRequests.get().get(branch.name)
      if (existing?.state.toUpperCase() === "OPEN") {
        const refreshed = await refreshPullRequests(true)
        if (refreshed !== null) existing = refreshed.get(branch.name)
      }
      const createUrl = pullRequestUrl(ctx.git.state.remotes, branch.name)
      const url = existing?.state.toUpperCase() === "CLOSED" ? createUrl : (existing?.url ?? createUrl)
      if (url === null) return ctx.popups.notify("No web remote to open a pull request on", "warning")
      try {
        await ctx.open(url)
      } catch (error) {
        fail(error)
      }
    }

    ctx.commands.register({
      id: "branches.checkout",
      source: rows.api,
      title: "Check out branch",
      hint: "checkout",
      keys: "space",
      when: (branch) => !branch.isHead,
      run: checkout,
    })
    ctx.commands.register({
      id: "branches.clean",
      title: "Clean branches",
      run: cleanBranches,
    })
    ctx.commands.register({
      id: "branches.create",
      title: "Create branch here",
      hint: "new branch",
      keys: "n",
      pane: "branches",
      run: () =>
        hasRepository(ctx.git.state.head)
          ? createBranchAt(rows.api.selected())
          : ctx.popups.notify("No repository here to branch from", "warning"),
    })
    ctx.commands.register({
      id: "branches.rename",
      source: rows.api,
      title: "Rename branch",
      keys: "shift+r",
      run: renameBranch,
    })
    ctx.commands.register({
      id: "branches.copy-name",
      source: rows.api,
      title: "Copy branch name",
      keys: "y",
      run: copyBranchName,
    })
    ctx.commands.register({
      id: "branches.delete",
      source: rows.api,
      title: "Delete branch",
      hint: "delete",
      keys: "d",
      when: (branch) => !branch.isHead,
      run: deleteBranch,
    })
    ctx.commands.register({
      id: "branches.force-delete",
      source: rows.api,
      title: "Force delete branch",
      keys: "shift+d",
      when: (branch) => !branch.isHead,
      run: (branch) => forceDelete(branch, `${branch.name} may have commits no other branch has.`),
    })
    ctx.commands.register({
      id: "branches.merge",
      source: rows.api,
      title: "Merge branch into the current branch",
      hint: "merge",
      keys: "shift+m",
      when: (branch) => !branch.isHead,
      run: openMergeMenu,
    })
    ctx.commands.register({
      id: "branches.set-upstream",
      source: rows.api,
      title: "Set branch upstream",
      keys: "u",
      run: setUpstream,
    })
    ctx.commands.register({
      id: "branches.push-upstream",
      source: rows.api,
      title: "Push branch and set upstream",
      keys: "shift+p",
      when: (branch) => branch.upstream === null,
      run: pushSettingUpstream,
    })
    ctx.commands.register({
      id: "branches.fast-forward",
      source: rows.api,
      title: "Fast-forward branch to its upstream",
      keys: "f",
      when: canFastForward,
      run: fastForward,
    })
    ctx.commands.register({
      id: "branches.pull-request",
      source: rows.api,
      title: "Open a pull request for this branch",
      keys: "o",
      when: (branch) => pullRequestUrl(ctx.git.state.remotes, branch.name) !== null,
      run: openPullRequest,
    })

    /**
     * Substantial repository writes animate beside the checked-out branch, except fetches,
     * whose complete loading state belongs in the app-wide status line. The action text lives
     * there for every operation. Kept in a child component so only HEAD owns an animation timer;
     * repositories with hundreds of branches still have one spinner.
     */
    function BranchActivity() {
      const theme = useTheme()
      // Staging is the files Pane's immediate state transition, not a long-running repository
      // operation. Keep an older substantial write visible if one overlaps a stage/unstage.
      const busy =
        useGitActivity().findLast((entry) => entry.label !== "staging" && entry.label !== "unstaging") ?? null
      const inline = busy !== null && !busy.label.startsWith("fetching")
      const wave = useSpinner(inline)
      if (wave === null) return null

      return (
        <text wrapMode="none" flexShrink={0}>
          <span fg={theme.accent}>{`  ${wave}`}</span>
        </text>
      )
    }

    function BranchRow({
      branch,
      pullRequest,
      id,
      selected,
      focused,
      onSelect,
    }: {
      readonly branch: Branch
      readonly pullRequest: PullRequest | undefined
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
      readonly onSelect: () => void
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(branch)
      const ahead = divergence(branch.upstream)
      const dim = decoration?.dim === true
      const badge = decoration?.badge
      const status =
        pullRequest !== undefined
          ? { glyph: githubGlyph, tone: pullRequestTone(pullRequest) }
          : isUpToDate(branch)
            ? { glyph: "✓", tone: "success" as const }
            : null

      return (
        <box
          id={id}
          width="100%"
          flexDirection="row"
          justifyContent="space-between"
          backgroundColor={selected && focused ? theme.selection : undefined}
          onMouseDown={onSelect}
        >
          {/* Keep every status outside the one shrinkable cell. Like LazyGit's width budget,
              a narrow row spends its last columns on state and takes them from the name. */}
          <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <text wrapMode="none" flexShrink={0}>
              <span fg={dim ? theme.textMuted : theme.accent}>{branch.isHead ? "* " : "  "}</span>
            </text>
            <BranchName name={branch.name} color={nameColor(branch, theme, dim)} />
            <text wrapMode="none" flexShrink={0}>
              {status === null ? null : (
                <span fg={dim ? theme.textMuted : toneColor(theme, status.tone)}>{` ${status.glyph}`}</span>
              )}
              {ahead === "" ? null : <span fg={dim ? theme.textMuted : theme.info}>{`  ${ahead}`}</span>}
              {badge === undefined ? null : <span fg={toneColor(theme, decoration?.tone)}>{`  ${badge}`}</span>}
            </text>
          </box>
          {branch.isHead ? <BranchActivity /> : null}
        </box>
      )
    }

    function BranchList({
      focused,
      selectedName: restoredName,
      onOpen,
    }: Pick<PaneProps, "focused"> & {
      readonly selectedName: string | null
      readonly onOpen: (branch: Branch) => void
    }) {
      const theme = useTheme()
      const branches = useGit((state) => state.branches)
      const branchPullRequests = pullRequests.use()
      const repository = useGit((state) => hasRepository(state.head))
      const cursor = useListCursor({
        items: branches,
        idPrefix: "branches",
        noun: "branch",
        query: {
          mode: "filter",
          fields: (branch) => [
            branch.name,
            branch.upstream === null ? "" : `${branch.upstream.remote}/${branch.upstream.branch}`,
          ],
        },
      })
      const visibleBranches = cursor.items
      const headName = branches.find((branch) => branch.isHead)?.name ?? null

      /**
       * A checkout moves the new HEAD to the first row. Follow that branch by name instead of
       * leaving the cursor at its old numeric position, which now belongs to another branch.
       * Resolve during render so no frame highlights the wrong row while the cursor catches up.
       */
      const previousHeadName = useRef(headName)
      const headChanged = previousHeadName.current !== headName
      const checkedOutIndex =
        headChanged && headName !== null ? visibleBranches.findIndex((branch) => branch.name === headName) : -1
      const selectedIndex = checkedOutIndex === -1 ? cursor.index : checkedOutIndex
      const selected = visibleBranches[selectedIndex]
      // Keyed on the name, not the object: a refresh rebuilds every Branch, and re-issuing an
      // unchanged target would refetch the diff on every poll.
      const selectedName = selected?.name

      useEffect(() => {
        // Keep a filtered-out HEAD pending until clearing the filter makes its row visible.
        if (!headChanged || headName === null || checkedOutIndex !== -1) previousHeadName.current = headName
        if (selectedIndex !== cursor.index) cursor.setIndex(selectedIndex)
      })

      useEffect(() => {
        rows.setSelected(selected)
        return () => rows.setSelected(undefined)
      }, [selected])

      useEffect(() => {
        // Only while focused: the diff belongs to whichever list the user is driving.
        if (!focused || selectedName === undefined) return
        diff.show({ kind: "branch", ref: selectedName, path: null })
      }, [focused, selectedName])

      useEffect(() => {
        if (restoredName === null) return
        const index = visibleBranches.findIndex((branch) => branch.name === restoredName)
        if (index !== -1) cursor.setIndex(index)
      }, [restoredName])

      // OpenTUI reports the enter key as `return`, the same spelling the commits Pane uses.
      useCommand({
        id: "branches.view-commits",
        title: "View commits",
        hint: "commits",
        keys: "return",
        when: () => selected !== undefined,
        run: () => {
          if (selected !== undefined) onOpen(selected)
        },
      })

      if (branches.length === 0) {
        const message = repository ? "no branches yet — n creates one" : "no repository here"
        return <text fg={theme.textMuted} content={message} />
      }
      if (visibleBranches.length === 0) return <text fg={theme.textMuted} content="no matching branches" />

      return (
        // `flexBasis={0}` sizes the box to the Pane rather than to its content, so a long list
        // scrolls instead of overflowing the frame.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {visibleBranches.map((branch, rowIndex) => (
            <BranchRow
              key={branch.name}
              id={cursor.rowId(rowIndex)}
              branch={branch}
              pullRequest={branchPullRequests.get(branch.name)}
              selected={rowIndex === selectedIndex}
              focused={focused}
              onSelect={() => cursor.setIndex(rowIndex)}
            />
          ))}
        </scrollbox>
      )
    }

    function BranchesPane({ focused }: PaneProps) {
      const [view, setView] = useState<BranchPaneView>({ kind: "list", selectedName: null })

      return view.kind === "list" ? (
        <BranchList
          focused={focused}
          selectedName={view.selectedName}
          onOpen={(branch) => setView({ kind: "commits", branchName: branch.name })}
        />
      ) : (
        <CommitBrowser
          key={view.branchName}
          revision={`refs/heads/${view.branchName}`}
          title={view.branchName}
          focused={focused}
          idPrefix="branches.history"
          onBack={() => setView({ kind: "list", selectedName: view.branchName })}
        />
      )
    }

    const pane = ctx.panes.register({
      id: "branches",
      title: "Local",
      component: BranchesPane,
      placement: { column: 0, order: 30 },
    })

    // Keyless: core binds `1`–`9` positionally over the Layout.
    ctx.commands.register({
      id: "branches.focus",
      title: "Focus branches",
      run: () => pane.focus(),
    })

    return rows.api
  },
})
