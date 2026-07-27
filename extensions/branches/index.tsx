/** @jsxImportSource @opentui/react */
import {
  createRowSource,
  defineExtension,
  describeGitFailure,
  GitError,
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

/**
 * The divergence, as arrows, or `""` where there is nothing to say.
 *
 * Three of the four upstream states say nothing worth a column: no upstream at all, and an
 * upstream that matches, are both "carry on" — and a row that spelled either out spent its
 * width telling the reader that nothing had happened. Only real counts print, and only the
 * ones above zero, so what is on screen is always something to act on.
 */
function divergence(upstream: UpstreamInfo | null): string {
  if (upstream === null || upstream.gone) return ""
  const parts: string[] = []
  if (upstream.ahead > 0) parts.push(`↑${upstream.ahead}`)
  if (upstream.behind > 0) parts.push(`↓${upstream.behind}`)
  return parts.join(" ")
}

/**
 * The colour a branch's own name is drawn in.
 *
 * `gone` is the one upstream state that cannot be left to the divergence column: git reports
 * it *instead of* a divergence, so a branch whose remote ref was deleted carries
 * `ahead === 0, behind === 0` — byte-identical to a perfectly in-sync branch, and the
 * opposite situation (§5.12). With the words dropped from the row, the name itself is what
 * carries it, which is also where lazygit puts it.
 */
function nameColor(branch: Branch, theme: Theme, dim: boolean): string {
  if (dim) return theme.textMuted
  if (branch.upstream?.gone === true) return theme.danger
  return theme.text
}

/**
 * Whether there is a repository here at all — the distinction an empty branch list cannot
 * make on its own, since a fresh repository and no repository both have zero branches. Both
 * the empty state and `branches.create` read this rather than the list length.
 */
function hasRepository(head: Head): boolean {
  return head.kind !== "noRepository"
}

/**
 * The one refusal of `git branch -d` that a second confirmation can answer.
 *
 * Every refusal exits 1, so the exit code cannot tell them apart, and blindly retrying with
 * `-D` would turn "that branch is checked out in another worktree" into a force delete
 * nobody agreed to. Matched case-insensitively: git has changed the capitalisation of this
 * sentence between releases.
 */
function isUnmerged(error: unknown): boolean {
  return error instanceof GitError && /not fully merged/i.test(error.stderr)
}

/**
 * A fast-forward has to actually be one. With local commits the upstream does not have,
 * advancing the ref would silently drop them — which is why `behind > 0` alone is not the
 * test — so the offer is withdrawn rather than left to fail.
 */
function canFastForward(branch: Branch): boolean {
  const upstream = branch.upstream
  return upstream !== null && !upstream.gone && upstream.behind > 0 && upstream.ahead === 0
}

/** Non-empty and single-token: the two rules git will not repair for us. */
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
    // A branch's name is its identity; the oid moves under it on every commit.
    const rows = createRowSource<Branch>({ key: (row) => row.name })
    const diff = ctx.extensions.get("diff")

    const fail = (error: unknown): void => ctx.popups.notify(describeGitFailure(error), "error")

    async function checkout(branch: Branch): Promise<void> {
      // `git checkout` on the branch you are already on succeeds and does nothing, which
      // reads as the key having been swallowed. Say so instead.
      if (branch.isHead) return ctx.popups.notify(`Already on ${branch.name}`, "info")
      try {
        await ctx.git.checkout(branch.name)
      } catch (error) {
        fail(error)
      }
    }

    /** `base` is absent only in an unborn repository, where there is no row to stand on. */
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
      // Refused here rather than by git, whose answer ("used by worktree at …") describes a
      // mechanism instead of the choice the user actually has.
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
      // The branch's own remote, else the conventional one, else whatever is configured —
      // the same precedence `push` uses, so the suggestion names where a push would go.
      const remote = branch.upstream?.remote ?? (remotes.includes("origin") ? "origin" : remotes[0])
      const value = await ctx.popups.prompt({
        title: `Upstream for ${branch.name}`,
        placeholder: "remote/branch",
        initial: `${remote ?? "origin"}/${branch.upstream?.branch ?? branch.name}`,
        validate: (input) => validateRef(input, "Name the upstream ref"),
      })
      if (value === undefined) return
      try {
        // No porcelain helper covers this one; `raw` is the sanctioned escape hatch, and
        // `branch` is not a read-only subcommand, so the store refreshes behind it.
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
      // `canFastForward` already guarantees this; the guard is what lets the compiler agree,
      // and what stops a palette-driven call on stale data building "undefined/undefined".
      if (upstream === null) return
      try {
        if (branch.isHead) await ctx.git.raw(["merge", "--ff-only", `${upstream.remote}/${upstream.branch}`])
        // A branch you are not standing on cannot be merged into, but fetching straight into
        // its ref moves it — and git refuses there exactly the non-fast-forward this action
        // promises never to do, so the guarantee is enforced twice.
        else await ctx.git.raw(["fetch", upstream.remote, `${upstream.branch}:${branch.name}`])
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
    }: {
      readonly branch: Branch
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(branch)
      const ahead = divergence(branch.upstream)
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined}>
          {/* The marker, not the highlight, is what says where the cursor is while another
              Pane holds focus — the state in which the diff on screen is still this Pane's
              selection and the user needs to see which row that was. */}
          <span fg={theme.textMuted}>{selected ? "❯ " : "  "}</span>
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
      const cursor = useListCursor({ items: branches, idPrefix: "branches", noun: "branch" })
      const selected = cursor.selected
      // Keyed on the name, not the oid: the name is a branch's identity, and a commit landing
      // on the selected branch must not re-issue a target that has not conceptually moved.
      const selectedName = selected?.name

      useEffect(() => {
        rows.setSelected(selected)
        // Cleared on unmount, not merely replaced on the next move: a Pane the Layout has
        // hidden has no selection, and `BranchesApi.selected()` must not keep naming the row
        // it had when it went away.
        return () => rows.setSelected(undefined)
      }, [selected])

      useEffect(() => {
        // Only while focused: the diff pane belongs to whichever list the user is driving,
        // and a background pane must not steal it. A commit landing on the selected branch
        // still redraws the patch — the diff Pane refetches on `git.refreshed` — without
        // this effect re-issuing a target that has not conceptually moved.
        if (!focused || selectedName === undefined) return
        // `branch`, not `commit`: the patch is the same either way — a branch name resolves
        // to its tip — but only this kind lets the diff Pane print the name the row clipped.
        diff.show({ kind: "branch", ref: selectedName, path: null })
      }, [focused, selectedName])

      // A selection is empty only when the list is, and the empty state below already says so
      // — a toast would repeat it, so every key with nothing to act on is a silent no-op. The
      // same rule in the files, commits and stash Panes.
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
        // Refused before the prompt: outside a repository there is nothing to create a branch
        // in, and asking for a name only to hand git a request it must reject is the Pane
        // telling the user a lie it already knew the answer to.
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
        id: "branches.menu",
        title: "Branch actions",
        hint: "menu",
        keys: "x",
        run: () => (selected === undefined ? undefined : openMenu(selected)),
      })

      // Two different nothings. An unborn repository has branches nobody has created yet, and
      // `n` still works there — the only thing missing is the row to create at. Outside a
      // repository there is nothing to create *in*, so the offer is withdrawn along with it.
      if (branches.length === 0) {
        const message = repository ? "no branches yet — n creates one" : "no repository here"
        return <text fg={theme.textMuted} content={message} />
      }

      return (
        // `flexBasis={0}` is not decoration: without it the box is sized by its *content*, so
        // a list longer than the Pane makes the box taller than the Pane and it paints across
        // the frame around it instead of scrolling inside it.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {branches.map((branch, index) => (
            <BranchRow
              key={branch.name}
              id={cursor.rowId(index)}
              branch={branch}
              selected={index === cursor.index}
              focused={focused}
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

    // Keyless by design: core binds `1`–`9` positionally over the Layout (§1.7), so this
    // registration is the palette row and the id a user rebinds, not the jump key.
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
          // Explicit ids: splices address these, and retitling a group must not silently
          // reroute someone else's items.
          id: "branch",
          title: "Branch",
          items: [
            { key: "c", label: "Check out", when: (branch) => !branch.isHead, run: checkout },
            { key: "n", label: "Create branch here", run: createBranchAt },
            { key: "d", label: "Delete", when: (branch) => !branch.isHead, run: deleteBranch },
            {
              // `shift+d` rather than `D`: the binding parser lowercases a bare letter, so
              // `"D"` would be the same stroke as the delete above and one of the two would
              // silently never fire.
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
          ],
        },
      ],
    })

    return rows.api
  },
})
