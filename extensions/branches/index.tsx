/** @jsxImportSource @opentui/react */
import {
  createRowSource,
  defineExtension,
  describeGitFailure,
  GitError,
  isConflicted,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type Branch,
  type BranchesApi,
  type Head,
  type PaneProps,
  type Theme,
  type UpstreamInfo,
} from "laziergit"
import { useEffect } from "react"

import { mergeArgs, mergeChoices, squashCommitMessage, type MergeMode } from "./merge"
import { pullRequestUrl } from "./pull-request"

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

function validateRef(value: string, empty: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return empty
  if (/\s/.test(trimmed)) return "A ref name cannot contain spaces"
  return null
}

export default defineExtension({
  name: "branches",
  description: "Local branches with their upstream divergence",
  needs: ["diff"],

  activate(ctx): BranchesApi {
    const rows = createRowSource<Branch>({ key: (row) => row.name })
    const diff = ctx.extensions.get("diff")

    const fail = (error: unknown): void => ctx.popups.notify(describeGitFailure(error), "error")

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

    async function abortMerge(confirm: boolean): Promise<void> {
      if (confirm) {
        const accepted = await ctx.popups.confirm({
          title: "Abort the current merge?",
          message: "Restore the index and working tree to their pre-merge state.",
          confirmLabel: "Abort merge",
          danger: true,
        })
        if (!accepted) return
      }

      try {
        await ctx.git.raw(["merge", "--abort"])
        ctx.popups.notify("Merge aborted", "success")
      } catch (error) {
        fail(error)
      }
    }

    async function abortSquashMerge(): Promise<void> {
      const accepted = await ctx.popups.confirm({
        title: "Abort the squash merge?",
        message: "Restore the index and working tree to their pre-merge state.",
        confirmLabel: "Abort squash",
        danger: true,
      })
      if (!accepted) return

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
      await ctx.popups.menu({
        title: branch === null ? "Merge in progress" : `Merge in progress on ${branch}`,
        groups: [
          {
            id: "merge",
            items: [
              { key: "c", label: "Continue merge", run: continueMerge },
              { key: "a", label: "Abort merge…", run: () => abortMerge(true) },
              { key: "v", label: "View files", run: () => ctx.commands.execute("files.focus") },
            ],
          },
        ],
      })
    }

    async function handleMergeConflict(branch: Branch, mode: MergeMode): Promise<void> {
      const squash = mode === "squash" || mode === "squash-commit"
      await ctx.popups.menu({
        title: `Merge ${branch.name} stopped with conflicts`,
        groups: [
          {
            id: "conflicts",
            items: [
              { key: "v", label: "View conflicted files", run: () => ctx.commands.execute("files.focus") },
              {
                key: "a",
                label: squash ? "Abort squash merge…" : "Abort merge",
                run: () => (squash ? abortSquashMerge() : abortMerge(false)),
              },
            ],
          },
        ],
      })
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
        await ctx.popups.menu({
          title: `Merge ${branch.name} into ${into}`,
          groups: [
            {
              id: "merge",
              items: choices.map((choice) => ({
                key: choice.key,
                label: choice.label,
                run: () => mergeBranch(branch, choice.mode),
              })),
            },
          ],
        })
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
    // configured, and an unpushed branch gets a 404 from the host, as it does in lazygit.
    async function openPullRequest(branch: Branch): Promise<void> {
      const url = pullRequestUrl(ctx.git.state.remotes, branch.name)
      if (url === null) return ctx.popups.notify("No web remote to open a pull request on", "warning")
      try {
        await ctx.open(url)
      } catch (error) {
        fail(error)
      }
    }

    function openMenu(branch: Branch): void {
      void ctx.menus.open("branches.actions", branch).catch(fail)
    }

    function BranchRow({
      branch,
      id,
      selected,
      focused,
      onSelect,
    }: {
      readonly branch: Branch
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

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined} onMouseDown={onSelect}>
          <span fg={dim ? theme.textMuted : theme.accent}>{branch.isHead ? "*" : " "}</span>
          <span fg={nameColor(branch, theme, dim)}>{` ${branch.name}`}</span>
          {ahead === "" ? null : <span fg={dim ? theme.textMuted : theme.info}>{`  ${ahead}`}</span>}
          {badge === undefined ? null : <span fg={toneColor(theme, decoration?.tone)}>{`  ${badge}`}</span>}
        </text>
      )
    }

    function BranchesPane({ focused }: PaneProps) {
      const theme = useTheme()
      const branches = useGit((state) => state.branches)
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
      const selected = cursor.selected
      // Keyed on the name, not the object: a refresh rebuilds every Branch, and re-issuing an
      // unchanged target would refetch the diff on every poll.
      const selectedName = selected?.name

      useEffect(() => {
        rows.setSelected(selected)
        return () => rows.setSelected(undefined)
      }, [selected])

      useEffect(() => {
        // Only while focused: the diff belongs to whichever list the user is driving.
        if (!focused || selectedName === undefined) return
        diff.show({ kind: "branch", ref: selectedName, path: null })
      }, [focused, selectedName])

      useCommand({
        id: "branches.checkout",
        title: "Check out branch",
        hint: "checkout",
        keys: "space",
        run: () => (selected === undefined ? undefined : checkout(selected)),
      })
      useCommand({
        id: "branches.create",
        title: "Create branch here",
        hint: "new branch",
        keys: "n",
        run: () =>
          repository ? createBranchAt(selected) : ctx.popups.notify("No repository here to branch from", "warning"),
      })
      useCommand({
        id: "branches.delete",
        title: "Delete branch",
        hint: "delete",
        keys: "d",
        run: () => (selected === undefined ? undefined : deleteBranch(selected)),
      })
      useCommand({
        id: "branches.merge",
        title: "Merge branch into the current branch",
        hint: "merge",
        keys: "shift+m",
        run: () => (selected === undefined ? undefined : openMergeMenu(selected)),
      })
      useCommand({
        id: "branches.pull-request",
        title: "Open a pull request for this branch",
        keys: "o",
        run: () => (selected === undefined ? undefined : openPullRequest(selected)),
      })
      useCommand({
        id: "branches.menu",
        title: "Branch actions",
        hint: "menu",
        keys: "x",
        run: () => (selected === undefined ? undefined : openMenu(selected)),
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
          {visibleBranches.map((branch, index) => (
            <BranchRow
              key={branch.name}
              id={cursor.rowId(index)}
              branch={branch}
              selected={index === cursor.index}
              focused={focused}
              onSelect={() => cursor.setIndex(index)}
            />
          ))}
        </scrollbox>
      )
    }

    const pane = ctx.panes.register({
      id: "branches",
      title: "Branches",
      component: BranchesPane,
      placement: { column: 0, order: 30 },
    })

    // Keyless: core binds `1`–`9` positionally over the Layout (§1.7).
    ctx.commands.register({
      id: "branches.focus",
      title: "Focus branches",
      run: () => pane.focus(),
    })

    ctx.menus.register({
      id: "branches.actions",
      title: (branch) => `Branch: ${branch.name}`,
      groups: [
        {
          // Explicit ids: splices address these, so they must not move when a title changes.
          id: "branch",
          title: "Branch",
          items: [
            { key: "c", label: "Check out", when: (branch) => !branch.isHead, run: checkout },
            { key: "n", label: "Create branch here", run: createBranchAt },
            {
              key: "m",
              label: "Merge into current branch…",
              when: (branch) => !branch.isHead,
              run: openMergeMenu,
            },
            { key: "d", label: "Delete", when: (branch) => !branch.isHead, run: deleteBranch },
            {
              // `shift+d`, not `D`: the parser lowercases a bare letter, colliding with `d`.
              key: "shift+d",
              label: "Force delete",
              when: (branch) => !branch.isHead,
              run: (branch) => forceDelete(branch, `${branch.name} may have commits no other branch has.`),
            },
          ],
        },
        {
          id: "upstream",
          title: "Upstream",
          items: [
            { key: "u", label: "Set upstream…", run: setUpstream },
            {
              key: "p",
              label: "Push, setting upstream",
              when: (branch) => branch.upstream === null,
              run: pushSettingUpstream,
            },
            { key: "f", label: "Fast-forward", when: canFastForward, run: fastForward },
            {
              key: "o",
              label: "Open a pull request",
              when: (branch) => pullRequestUrl(ctx.git.state.remotes, branch.name) !== null,
              run: openPullRequest,
            },
          ],
        },
      ],
    })

    return rows.api
  },
})
