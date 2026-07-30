/** @jsxImportSource @opentui/react */
import {
  defineExtension,
  describeGitFailure,
  GitError,
  remoteWebUrl,
  useGit,
  useGitActivity,
  useTheme,
  type Head,
  type Theme,
  type UpstreamInfo,
} from "laziergit"

import { useSpinner } from "./spinner"

/** The last segment of the repository root — an Extension has no `node:path`. */
function directoryName(root: string): string {
  const segments = root.split(/[/\\]/).filter((segment) => segment !== "")
  return segments.at(-1) ?? root
}

type WithoutBranch = Exclude<Head, { kind: "onBranch" }>

function onBranch(head: Head): boolean {
  return head.kind === "onBranch"
}

function tracking(head: Head): boolean {
  return head.kind === "onBranch" && head.upstream !== null
}

function untracked(head: Head): boolean {
  return head.kind === "onBranch" && head.upstream === null
}

/**
 * Why git refused a push. Read off the message, since every refusal exits 1; `[rejected]`
 * keeps its bracket, because `[remote rejected]` is a hook saying no and forcing cannot
 * change that. The wording is stable — core pins `LC_ALL=C`.
 */
type Rejection =
  /**
   * `fetch first` — the remote's tip is an object this repository does not have, so nothing
   * here can count what a force would destroy, and the lease predates those commits and would
   * let it through.
   */
  | "unfetched"
  /**
   * `non-fast-forward` — the remote's commits are already here, so `upstream.behind` counts
   * exactly what a force would drop. The one rejection where offering a force is honest.
   */
  | "diverged"
  /** `stale info` — the remote moved since the last fetch, which is what the lease refuses. */
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

/** The same counts for the status line, which is read continuously: only the non-zero ones. */
function drift(upstream: UpstreamInfo): string {
  const parts: string[] = []
  if (upstream.ahead > 0) parts.push(`↑${upstream.ahead}`)
  if (upstream.behind > 0) parts.push(`↓${upstream.behind}`)
  return parts.join(" ")
}

/**
 * One token of the status line segment, in reading order. Data rather than markup, so the
 * separator between tokens is applied in exactly one place — no token is reliably first.
 */
interface Token {
  readonly key: string
  readonly text: string
  readonly color: string
}

/** The divergence half of the status line segment, as zero or one token. */
function upstreamTokens(upstream: UpstreamInfo | null, theme: Theme): readonly Token[] {
  if (upstream === null) return []
  if (upstream.gone) {
    return [{ key: "sync", text: `${upstream.remote}/${upstream.branch} gone`, color: theme.danger }]
  }
  const counts = drift(upstream)
  return counts === "" ? [] : [{ key: "sync", text: counts, color: theme.info }]
}

function upstreamName(upstream: UpstreamInfo): string {
  return `${upstream.remote}/${upstream.branch}`
}

/**
 * Both ends named, so `push.default` never gets a vote: under `matching` a single
 * `--force-with-lease` would force-update every branch whose name exists on the remote.
 */
function refspec(branch: string, upstream: UpstreamInfo): string {
  return `${branch}:${upstream.branch}`
}

/**
 * What a force push destroys. The lease guards only against movement since the last fetch, so
 * it says nothing about already-fetched commits — hence the count. The confirm is 60 columns.
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
    // The repository root is constant for the session.
    const root = ctx.git.root
    const repoName = directoryName(root)

    /**
     * The operation in flight: a mutual-exclusion latch, not progress — the status segment
     * reads core's own activity. A reload landing mid-push never clears it, which is harmless
     * because `activate` runs again and builds a fresh one.
     */
    let running: string | null = null

    type Outcome =
      | { readonly kind: "done" }
      | { readonly kind: "failed"; readonly error: GitError }
      /** Refused before it started: another sync operation is still running. */
      | { readonly kind: "busy" }

    async function run(label: string, work: () => Promise<void>): Promise<Outcome> {
      if (running !== null) {
        ctx.popups.notify(`Still ${running} — try again when it finishes`, "warning")
        return { kind: "busy" }
      }

      running = label
      try {
        await work()
        return { kind: "done" }
      } catch (error) {
        // Anything that is not git refusing is a bug here; the Command host reports those.
        if (!(error instanceof GitError)) throw error
        return { kind: "failed", error }
      } finally {
        running = null
      }
    }

    /**
     * git's own words, never a summary: with credential prompting off, this message is
     * the whole diagnosis. The line structure is kept, since a toast renders lines.
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

      // Named explicitly rather than left to core's fallback, so git is told what the confirm
      // promised.
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

      // First, so git's own account stays on screen while the confirm asks what to do about it.
      surface(outcome.error)
      const rejection = rejectionOf(outcome.error)
      if (rejection === "stale-lease") {
        return ctx.popups.notify(`${upstreamName(upstream)} moved since the last fetch`, "warning")
      }
      if (rejection === "unfetched") {
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

      // The menu's `when: tracking` already hid this, but a checkout can land between the menu
      // opening and the key, and the lease is a claim about a ref this branch tracks.
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

      // `with-lease` and never plain `--force`: "overwrite what I last saw", not
      // "overwrite whatever is there". This Extension offers no way past it.
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

      // A missing upstream is left to git, whose own message says it better than a paraphrase.
      const outcome = await run(rebase ? "pulling (rebase)" : "pulling", () => ctx.git.pull({ rebase }))
      if (outcome.kind === "failed") return surface(outcome.error)
      if (outcome.kind === "done") ctx.popups.notify(`Pulled ${head.branch}`, "success")
    }

    async function fetch(prune: boolean): Promise<void> {
      // No Head check: fetching is meaningful on a detached HEAD and on an unborn repository.
      const outcome = await run(prune ? "fetching (prune)" : "fetching", () => ctx.git.fetch({ prune }))
      if (outcome.kind === "failed") return surface(outcome.error)
      if (outcome.kind === "done") ctx.popups.notify(fetchedSummary(), "success")
    }

    /** Where HEAD is, and how far it has drifted from its upstream. */
    function SyncSegment() {
      const theme = useTheme()
      const head = useGit((state) => state.head)
      // Core's activity, not this Extension's, so the segment also covers writes sync never
      // sees. `.at(-1)`: the most recently started, when two overlap.
      const busy = useGitActivity().at(-1) ?? null
      const wave = useSpinner(busy !== null)

      const tokens: Token[] = []
      if (head.kind === "detached") {
        tokens.push({ key: "head", text: `detached at ${head.oid.slice(0, 7)}`, color: theme.warning })
      } else if (head.kind !== "noRepository") {
        tokens.push({ key: "head", text: head.branch, color: theme.accent })
      }

      // Beside the branch rather than over it: a push must not cost you the branch name.
      if (busy !== null && wave !== null) {
        tokens.push({ key: "wave", text: wave, color: theme.accent })
        tokens.push({ key: "busy", text: busy.label, color: theme.textMuted })
      }

      tokens.push(...upstreamTokens(head.kind === "onBranch" ? head.upstream : null, theme))

      if (tokens.length === 0) return null

      // `<span>` children of one `<text>`, never a `content` prop, in every state: React reuses
      // the renderable across renders, and switching one instance between the two forms leaves
      // OpenTUI's text buffer with no chunks, which throws at the next paint.
      return (
        <text wrapMode="none">
          {tokens.map((token, index) => (
            <span key={token.key} fg={token.color}>
              {index === 0 ? token.text : ` ${token.text}`}
            </span>
          ))}
        </text>
      )
    }

    ctx.statusline.register({ id: "sync", component: SyncSegment, align: "right" })

    // No `hint` on any of these: a global's hint would sit on every Pane's bar permanently,
    // and these are all one `shift+s` away in the menu.
    ctx.commands.register({
      id: "sync.push",
      title: "Push",
      // `shift+p`, not `"P"`: the parser lowercases a bare letter, colliding with `sync.pull`.
      keys: "shift+p",
      run: push,
    })
    ctx.commands.register({
      id: "sync.pull",
      title: "Pull",
      // Global, so the stash Pane's own `p` shadows it while that Pane is focused.
      keys: "p",
      run: () => pull(false),
    })
    ctx.commands.register({ id: "sync.fetch", title: "Fetch all remotes", keys: "f", run: () => fetch(false) })
    ctx.commands.register({
      id: "sync.refresh",
      title: "Refresh",
      keys: "shift+r",
      run: async () => {
        try {
          await ctx.git.refresh()
        } catch (error) {
          ctx.popups.notify(describeGitFailure(error), "error")
        }
      },
    })
    ctx.commands.register({
      id: "sync.menu",
      title: "Repository actions",
      keys: "shift+s",
      // The whole state, not just HEAD: the repository group below needs the remotes.
      run: () => ctx.menus.open("sync.actions", ctx.git.state),
    })

    /**
     * The target is a snapshot taken when the menu opened, so it decides what is *offered*;
     * every `run` re-reads HEAD, because what an action applies to is the repository as it
     * stands when the key lands.
     */
    ctx.menus.register({
      id: "sync.actions",
      title: ({ head }) => {
        if (head.kind === "detached") return `${repoName} (detached at ${head.oid.slice(0, 7)})`
        if (head.kind === "onBranch") return `${repoName} — ${head.branch}`
        if (head.kind === "noRepository") return `${repoName} (no repository)`
        return `${repoName} (${head.branch}, no commits yet)`
      },
      groups: [
        {
          id: "push",
          title: "Push",
          items: [
            // One handler behind two entries: `push` already branches on the upstream, and
            // `when` keeps exactly one of them on screen.
            { key: "p", label: "Push", when: ({ head }) => tracking(head), run: push },
            { key: "u", label: "Push and set upstream", when: ({ head }) => untracked(head), run: push },
            {
              key: "o",
              label: "Force push (with lease)",
              when: ({ head }) => tracking(head),
              run: forcePush,
            },
          ],
        },
        {
          id: "pull",
          title: "Pull",
          items: [
            { key: "l", label: "Pull", when: ({ head }) => onBranch(head), run: () => pull(false) },
            { key: "r", label: "Pull (rebase)", when: ({ head }) => onBranch(head), run: () => pull(true) },
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
        {
          id: "repository",
          title: "Repository",
          items: [
            {
              // `b`, not `o`: that is force-push above, and one menu is one keyspace.
              key: "b",
              label: "Open repository in browser",
              when: (state) => remoteWebUrl(state.remotes) !== null,
              run: async (state) => {
                const url = remoteWebUrl(state.remotes)
                if (url !== null) await ctx.open(url)
              },
            },
            {
              key: "y",
              label: "Copy repository root path",
              run: async () => {
                try {
                  await ctx.copy(root)
                  ctx.popups.notify(root, "success")
                } catch (error) {
                  ctx.popups.notify(describeGitFailure(error), "error")
                }
              },
            },
          ],
        },
      ],
    })
  },
})
