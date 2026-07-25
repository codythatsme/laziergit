/** @jsxImportSource @opentui/react */
import { createCell, defineExtension, GitError, useGit, useTheme, type Head, type UpstreamInfo } from "laziergit"

/** The two {@link Head} variants that have nothing to push or pull. */
type WithoutBranch = Exclude<Head, { kind: "onBranch" }>

/** On a branch at all: what pull needs, and what push needs before anything else. */
function onBranch(head: Head): boolean {
  return head.kind === "onBranch"
}

/** On a branch that tracks something: the precondition for push, force push, and a lease. */
function tracking(head: Head): boolean {
  return head.kind === "onBranch" && head.upstream !== null
}

/** On a branch with no upstream — the one case where pushing has to set one. */
function untracked(head: Head): boolean {
  return head.kind === "onBranch" && head.upstream === null
}

/**
 * Why git refused a push, when the answer is one this Extension can act on.
 *
 * Read off the message rather than assumed from the exit code, which is 1 for every
 * refusal git makes. `[rejected]` with the bracket attached, because `[remote rejected]`
 * is a hook or a permission saying no and no amount of forcing changes that answer. The
 * wording is git's own and does not move with the locale — core pins `LC_ALL=C` (§1.5).
 */
type Rejection =
  /**
   * `fetch first` — the remote's tip is an object this repository does not have, so
   * someone else pushed and we never fetched. Kept apart from `diverged` because
   * the two need opposite answers: nothing here can count what a force would destroy, and
   * `--force-with-lease` would *pass*, since its lease is the tracking ref that predates
   * those commits. Offering a force here is offering to delete work sight unseen.
   */
  | "unfetched"
  /**
   * `non-fast-forward` — the remote's commits are already in this repository, so
   * `upstream.behind` counts exactly what a force would drop. The one rejection where a
   * force is worth offering, because the confirm can say what it costs.
   */
  | "diverged"
  /**
   * `stale info` — the lease no longer matches: the remote moved since our last fetch,
   * which is exactly what `--force-with-lease` exists to refuse. Re-offering it would fail
   * identically.
   */
  | "stale-lease"

function rejectionOf(error: GitError): Rejection | null {
  if (!error.stderr.includes("[rejected]")) return null
  if (error.stderr.includes("stale info")) return "stale-lease"
  if (error.stderr.includes("fetch first")) return "unfetched"
  return error.stderr.includes("non-fast-forward") ? "diverged" : null
}

function divergence(upstream: UpstreamInfo): string {
  return `↑${upstream.ahead} ↓${upstream.behind}`
}

/** How the upstream is spelled everywhere the user reads it. */
function upstreamName(upstream: UpstreamInfo): string {
  return `${upstream.remote}/${upstream.branch}`
}

/**
 * The exact source and destination, so `push.default` never gets a vote.
 *
 * A bare `git push` lets the user's `push.default` decide what travels: under `matching` a
 * single `--force-with-lease` force-updates *every* branch whose name exists on the remote
 * while the confirm named one, and under `upstream` a branch tracking a differently-named
 * ref lands somewhere the toast did not say. Naming both ends makes what git is told
 * exactly what the user agreed to.
 */
function refspec(branch: string, upstream: UpstreamInfo): string {
  return `${branch}:${upstream.branch}`
}

/**
 * What a force push actually destroys, in the words the confirm has room for.
 *
 * The count leads because it is the fact that decides the answer: "overwrites the remote"
 * reads as housekeeping, "3 commits will be destroyed" does not. The lease guards only
 * against movement *since* the last fetch, so it says nothing about commits already
 * fetched — which is the whole reason the count has to be spelled out here. Lines are kept
 * short and broken by hand; the confirm is 60 columns wide.
 */
function forceWarning(upstream: UpstreamInfo): string {
  const target = upstreamName(upstream)
  const loss =
    upstream.behind === 0
      ? `${target} held nothing new at the last fetch.`
      : `${upstream.behind} commit${upstream.behind === 1 ? "" : "s"} on ${target} will be destroyed.`
  return `${loss}\n--force-with-lease refuses if the remote moved since the last fetch.`
}

export default defineExtension({
  name: "sync",
  description: "Push, pull, and fetch the current branch",

  activate(ctx) {
    /**
     * The operation in flight, and the whole of sync's progress reporting.
     *
     * `notify` is a transient toast and a fetch of a large repository outlives it, so
     * toasts here report outcomes only. "Working" belongs to the one surface that lasts as
     * long as the work does: the status line segment below — §5.11's "a pane that owns long
     * work renders its own state", read for an Extension whose only pixels are a segment.
     * Nothing clears this on a reload landing mid-push, because the segment reading it is
     * torn down in the same breath.
     */
    const running = createCell<string | null>(null)

    /** What one git operation did, so a caller never has to guess from a thrown value. */
    type Outcome =
      | { readonly kind: "done" }
      | { readonly kind: "failed"; readonly error: GitError }
      /** Refused before it started: another sync operation is still running. */
      | { readonly kind: "busy" }

    async function run(label: string, work: () => Promise<void>): Promise<Outcome> {
      const current = running.get()
      if (current !== null) {
        // Two pushes racing would interleave their confirms, and the second would decide
        // what to do about a repository the first is still moving.
        ctx.popups.notify(`Still ${current} — try again when it finishes`, "warning")
        return { kind: "busy" }
      }

      running.set(label)
      try {
        await work()
        return { kind: "done" }
      } catch (error) {
        // Anything that is not git refusing is a bug in this Extension; the Command host
        // logs and reports those, and catching them here would only hide them.
        if (!(error instanceof GitError)) throw error
        return { kind: "failed", error }
      } finally {
        running.set(null)
      }
    }

    /**
     * git's own words, and never a summary of them: with credential prompting off
     * (`GIT_TERMINAL_PROMPT=0`, §5.11) a remote that wants authentication fails fast and
     * this message is the entire diagnosis the user gets. Its line structure is kept —
     * git's most useful refusals are a header plus a list of paths, and a toast renders the
     * lines — and only trimmed, so nothing is summarised away.
     */
    function surface(error: GitError): void {
      const said = error.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n")
      ctx.popups.notify(said.length === 0 ? `git exited ${error.exitCode}` : said, "error")
    }

    function refuse(head: WithoutBranch, verb: string): void {
      ctx.popups.notify(
        head.kind === "noRepository"
          ? `Cannot ${verb}: there is no repository here`
          : head.kind === "unborn"
            ? `Cannot ${verb}: ${head.branch} has no commits yet`
            : `Cannot ${verb}: HEAD is detached at ${head.oid.slice(0, 7)} — check out a branch first`,
        "warning",
      )
    }

    /** Where a branch with no upstream would be pushed, or nothing if no remote exists. */
    function defaultRemote(): string | undefined {
      const names = ctx.git.state.remotes.map((remote) => remote.name)
      return names.includes("origin") ? "origin" : names[0]
    }

    /** The divergence a fetch just established — the whole reason for running one. */
    function fetchedSummary(): string {
      const head = ctx.git.state.head
      if (head.kind !== "onBranch" || head.upstream === null || head.upstream.gone) return "Fetched"
      return `Fetched — ${divergence(head.upstream)}`
    }

    async function pushSettingUpstream(branch: string): Promise<void> {
      const remote = defaultRemote()
      if (remote === undefined) return ctx.popups.notify("No remote configured", "warning")

      const confirmed = await ctx.popups.confirm({
        title: `Push ${branch} to ${remote}?`,
        message: `${branch} has no upstream — this creates ${remote}/${branch} and tracks it.`,
        confirmLabel: "Push",
      })
      if (!confirmed) return

      // The remote is named explicitly rather than left to core's fallback, so what git is
      // told is exactly what the confirm promised the user.
      const outcome = await run("pushing", () => ctx.git.push({ remote, ref: branch, setUpstream: true }))
      if (outcome.kind === "failed") return surface(outcome.error)
      if (outcome.kind === "done") ctx.popups.notify(`Pushed ${branch} to ${remote}/${branch}`, "success")
    }

    async function push(): Promise<void> {
      const head = ctx.git.state.head
      if (head.kind !== "onBranch") return refuse(head, "push")

      const upstream = head.upstream
      if (upstream === null) return pushSettingUpstream(head.branch)

      const outcome = await run("pushing", () =>
        ctx.git.push({ remote: upstream.remote, ref: refspec(head.branch, upstream) }),
      )
      if (outcome.kind === "done")
        return ctx.popups.notify(`Pushed ${head.branch} to ${upstreamName(upstream)}`, "success")
      if (outcome.kind !== "failed") return

      // Always first, so git's own account of the refusal is on screen — and stays there —
      // while the confirm behind it asks what to do about it.
      surface(outcome.error)
      const rejection = rejectionOf(outcome.error)
      if (rejection === "stale-lease") {
        return ctx.popups.notify(`${upstreamName(upstream)} moved since the last fetch`, "warning")
      }
      if (rejection === "unfetched") {
        // git's own advice, and the only order that is safe: those commits are not in this
        // repository, so nothing here can say how many a force would destroy — and the
        // lease, measured against a tracking ref that predates them, would let it through.
        return ctx.popups.notify(
          `${upstreamName(upstream)} has commits this repository has never fetched — fetch, then decide`,
          "warning",
        )
      }
      if (rejection === "diverged") await forcePush()
    }

    async function forcePush(): Promise<void> {
      const head = ctx.git.state.head
      if (head.kind !== "onBranch") return refuse(head, "push")

      // The lease is a claim about a remote ref this branch already tracks. `when: tracking`
      // keeps the menu entry off screen without one, but HEAD is re-read on every run, so a
      // checkout between the menu opening and the key landing still has to be answerable.
      const upstream = head.upstream
      if (upstream === null) {
        return ctx.popups.notify(`Cannot force-push: ${head.branch} has no upstream`, "warning")
      }

      const confirmed = await ctx.popups.confirm({
        title: `Force-push ${head.branch} to ${upstreamName(upstream)}?`,
        message: forceWarning(upstream),
        confirmLabel: "Force push",
        danger: true,
      })
      if (!confirmed) return

      // `with-lease` and never plain `--force` (§1.5): the lease is what turns "overwrite
      // whatever is there" into "overwrite what I last saw", and this Extension offers no
      // way past it. The refspec is explicit for the same reason the confirm names one
      // branch — a bare force push is `push.default`'s call, not the user's.
      const outcome = await run("force-pushing", () =>
        ctx.git.push({ remote: upstream.remote, ref: refspec(head.branch, upstream), force: "with-lease" }),
      )
      if (outcome.kind === "failed") return surface(outcome.error)
      if (outcome.kind === "done") {
        ctx.popups.notify(`Force-pushed ${head.branch} to ${upstreamName(upstream)}`, "success")
      }
    }

    async function pull(rebase: boolean): Promise<void> {
      const head = ctx.git.state.head
      if (head.kind !== "onBranch") return refuse(head, "pull")

      // A branch with no upstream is not pre-empted here: git's "there is no tracking
      // information for the current branch" says it better than a paraphrase would.
      const outcome = await run(rebase ? "pulling (rebase)" : "pulling", () => ctx.git.pull({ rebase }))
      if (outcome.kind === "failed") return surface(outcome.error)
      if (outcome.kind === "done") ctx.popups.notify(`Pulled ${head.branch}`, "success")
    }

    async function fetch(prune: boolean): Promise<void> {
      // No Head check: fetching is meaningful on a detached HEAD and on a repository with
      // no commits at all, which is often exactly when you need it.
      const outcome = await run(prune ? "fetching (prune)" : "fetching", () => ctx.git.fetch({ prune }))
      if (outcome.kind === "failed") return surface(outcome.error)
      if (outcome.kind === "done") ctx.popups.notify(fetchedSummary(), "success")
    }

    function SyncSegment() {
      const theme = useTheme()
      const busy = running.use()
      const head = useGit((state) => state.head)

      // The progress indicator outranks the divergence: it is the only place a running
      // fetch is visible, and the numbers it covers are about to change anyway.
      if (busy !== null) return <text content={`⟳ ${busy}`} fg={theme.warning} />
      // No branch, no upstream, or no repository at all — nothing to be ahead or behind of.
      if (head.kind !== "onBranch" || head.upstream === null) return null

      const upstream = head.upstream
      // `gone` and in-sync are both `↑0 ↓0` (§1.5), so drawing them alike is the exact
      // mistake `UpstreamInfo.gone` exists to prevent.
      if (upstream.gone) return <text content={`${upstream.remote}/${upstream.branch} gone`} fg={theme.danger} />

      const inSync = upstream.ahead === 0 && upstream.behind === 0
      return <text content={divergence(upstream)} fg={inSync ? theme.textMuted : theme.text} />
    }

    ctx.statusline.register({ id: "sync", component: SyncSegment, align: "right" })

    ctx.commands.register({
      id: "sync.push",
      title: "Push",
      // `shift+p`, not `"P"`: the binding parser lowercases a bare letter, so `"P"` would
      // bind the same stroke as `sync.pull` below and one of them would never fire (§1.1).
      keys: "shift+p",
      run: push,
    })
    ctx.commands.register({
      id: "sync.pull",
      title: "Pull",
      // Global, which is what lets the stash Pane's own `p` (pop) shadow it while that Pane
      // is focused: a Pane layer sits at priority 100 and the global layer at 0. That is the
      // layering working as designed, not a collision to resolve — `p` means pop where a
      // stash is selected and pull everywhere else.
      keys: "p",
      run: () => pull(false),
    })
    ctx.commands.register({ id: "sync.fetch", title: "Fetch all remotes", keys: "f", run: () => fetch(false) })
    ctx.commands.register({
      id: "sync.menu",
      title: "Sync actions",
      keys: "shift+s",
      run: () => ctx.menus.open("sync.actions", ctx.git.state.head),
    })

    /**
     * Menu keys are parsed by the same grammar as bindings, so they are all lowercase:
     * `f` and `F` are one stroke, and the second of them would silently never fire.
     *
     * Every `run` reads HEAD again instead of using the target. The target — a snapshot
     * taken when the menu opened — decides what is *offered*; what the action is *applied
     * to* is the repository as it stands when the key is pressed, which is the same rule
     * the top-level Commands follow.
     */
    ctx.menus.register({
      id: "sync.actions",
      title: (head) => {
        if (head.kind === "detached") return `Sync (detached at ${head.oid.slice(0, 7)})`
        if (head.kind === "onBranch") return `Sync ${head.branch}`
        if (head.kind === "noRepository") return "Sync (no repository)"
        return `Sync (${head.branch}, no commits yet)`
      },
      groups: [
        {
          id: "push",
          title: "Push",
          items: [
            // One handler behind two entries: `push` already branches on the upstream, and
            // `when` keeps exactly one of them on screen — so the labels differ where they
            // must (what the user is about to agree to) and the behaviour cannot drift.
            { key: "p", label: "Push", when: tracking, run: push },
            { key: "u", label: "Push and set upstream", when: untracked, run: push },
            {
              key: "o",
              label: "Force push (with lease)",
              // Needs an upstream: the lease is a claim about a remote ref this branch is
              // already tracking, and there is nothing to claim without one.
              when: tracking,
              run: forcePush,
            },
          ],
        },
        {
          id: "pull",
          title: "Pull",
          items: [
            { key: "l", label: "Pull", when: onBranch, run: () => pull(false) },
            { key: "r", label: "Pull (rebase)", when: onBranch, run: () => pull(true) },
          ],
        },
        {
          id: "fetch",
          title: "Fetch",
          // Never hidden, so the menu always has something in it whatever HEAD is.
          items: [
            { key: "f", label: "Fetch all remotes", run: () => fetch(false) },
            { key: "n", label: "Fetch and prune", run: () => fetch(true) },
          ],
        },
      ],
    })
  },
})
