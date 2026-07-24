/** @jsxImportSource @opentui/react */
import {
  defineExtension,
  GitError,
  useGit,
  useTheme,
  type Head,
  type Remote,
  type Theme,
  type UpstreamInfo,
  type WorkingTreeStatus,
} from "laziergit"

/**
 * Where HEAD points, in the vocabulary this Pane draws rather than the one git reports.
 *
 * The one thing {@link Head} cannot say on its own is "there is no repository": outside one
 * the store serves an unborn HEAD whose branch is `""`, a name no real branch can have. That
 * is the only signal an Extension gets, so it is decoded here — once, at the boundary —
 * instead of being re-checked wherever an empty branch name would otherwise be rendered.
 */
type RepositoryHead =
  | { readonly kind: "unborn"; readonly branch: string }
  | { readonly kind: "detached"; readonly shortOid: string }
  | { readonly kind: "branch"; readonly branch: string; readonly upstream: UpstreamInfo | null }

type HeadLine = { readonly kind: "noRepository" } | RepositoryHead

function headLine(head: Head): HeadLine {
  if (head.kind === "detached") return { kind: "detached", shortOid: head.oid.slice(0, 7) }
  if (head.kind === "onBranch") return { kind: "branch", branch: head.branch, upstream: head.upstream }
  return head.branch === "" ? { kind: "noRepository" } : { kind: "unborn", branch: head.branch }
}

/** One coloured run of a row. This Pane is the smallest cell in the column, so it packs. */
interface Segment {
  readonly key: string
  readonly text: string
  readonly fg: string
}

/**
 * `wrapMode="none"` is what keeps this Pane two rows tall.
 *
 * The default wraps, and a wrapped row reflows into as many lines as the column is narrow —
 * in a two-column layout on a 34-cell terminal the HEAD row alone became three lines and
 * pushed the counts row down, so the Pane silently stopped being the fixed two-row summary
 * every other Pane's height is budgeted against. Clipping keeps the height a constant and
 * costs only the tail of a line, which is why the rows below are ordered most-important
 * first.
 */
function Row({ segments }: { readonly segments: readonly Segment[] }) {
  return (
    <text wrapMode="none">
      {segments.map((segment) => (
        <span key={segment.key} fg={segment.fg}>
          {segment.text}
        </span>
      ))}
    </text>
  )
}

/**
 * The divergence half of the HEAD row.
 *
 * `gone` is checked before the counts, and drawn as a warning, because git reports it
 * *instead of* a divergence: `ahead` and `behind` are both 0 for a deleted upstream, so
 * reading the numbers first would render "the remote deleted my branch" and "everything is
 * pushed" identically.
 */
function upstreamSegment(upstream: UpstreamInfo | null, theme: Theme): Segment {
  if (upstream === null) return { key: "sync", text: " no upstream", fg: theme.textMuted }
  if (upstream.gone) return { key: "sync", text: " gone", fg: theme.warning }
  if (upstream.ahead === 0 && upstream.behind === 0) return { key: "sync", text: " ≡", fg: theme.textMuted }
  const parts = [upstream.ahead > 0 ? `↑${upstream.ahead}` : "", upstream.behind > 0 ? `↓${upstream.behind}` : ""]
  return { key: "sync", text: ` ${parts.filter((part) => part !== "").join(" ")}`, fg: theme.info }
}

function headSegments(head: RepositoryHead, theme: Theme): readonly Segment[] {
  if (head.kind === "detached") return [{ key: "head", text: `detached at ${head.shortOid}`, fg: theme.warning }]
  if (head.kind === "unborn") {
    return [
      { key: "head", text: head.branch, fg: theme.accent },
      // An unborn branch has no commit and therefore no upstream, so the slot a divergence
      // would occupy says why there is nothing to compare against instead.
      { key: "sync", text: " no commits yet", fg: theme.textMuted },
    ]
  }
  return [{ key: "head", text: head.branch, fg: theme.accent }, upstreamSegment(head.upstream, theme)]
}

/**
 * Counts, then stashes. Zero-count kinds are omitted rather than drawn as `+0`: a glance
 * should land on what is actually there, and at the width this Pane gets four zeroes read
 * exactly like four somethings.
 */
function workingTreeSegments(status: WorkingTreeStatus, stashes: number, theme: Theme): readonly Segment[] {
  const kinds = [
    { key: "staged", glyph: "+", count: status.staged.length, fg: theme.success },
    { key: "unstaged", glyph: "~", count: status.unstaged.length, fg: theme.warning },
    { key: "untracked", glyph: "?", count: status.untracked.length, fg: theme.info },
    { key: "conflicted", glyph: "!", count: status.conflicted.length, fg: theme.danger },
  ]
  const counts = kinds
    .filter((kind) => kind.count > 0)
    .map((kind, index) => ({
      key: kind.key,
      text: `${index === 0 ? "" : " "}${kind.glyph}${kind.count}`,
      fg: kind.fg,
    }))

  const base = status.isClean ? [{ key: "clean", text: "clean", fg: theme.textMuted }] : counts
  if (stashes === 0) return base
  return [...base, { key: "stash", text: ` ⚑${stashes}`, fg: theme.textMuted }]
}

/**
 * The last segment of the repository root, without `node:path` — an Extension may import
 * only `"laziergit"`, `"react"` and `"@opentui/react"` (ADR-0001). Trailing separators are
 * dropped so a root of `/work/repo/` still names itself `repo`.
 */
function directoryName(root: string): string {
  const segments = root.split(/[/\\]/).filter((segment) => segment !== "")
  return segments.at(-1) ?? root
}

/**
 * The three remote spellings that have a web page behind them.
 *
 * The two SSH forms are matched separately rather than by one pattern with an optional
 * `ssh://`, because the colon means opposite things in them: in the scp-short form
 * everything after it is path, while in the URL form `ssh://git@host:22/owner/repo.git` it
 * introduces a *port*. One pattern for both turned that port into a path segment and built
 * `https://host/22/owner/repo` — a URL that resolves nowhere, offered by a menu item whose
 * `when` had just promised it worked.
 *
 * The user is optional in the URL form (`ssh://host/owner/repo.git` is a real remote) but
 * required in the scp-short one, where it is the only thing separating `host:path` from a
 * Windows drive letter or a plain relative path. In both, the part before `@` may not
 * contain a slash, so a local path that happens to hold one — `/Users/ann@work/repo` — is
 * not mistaken for a host.
 */
const sshUrlRemote = /^ssh:\/\/(?:[^@\s/]+@)?([^\s:/]+)(?::\d+)?\/(\S+?)(?:\.git)?\/?$/
const scpRemote = /^[^@\s/]+@([^\s:/]+):(\S+?)(?:\.git)?\/?$/
const httpRemote = /^(https?:\/\/\S+?)(?:\.git)?\/?$/

/**
 * The `git@host:path` → `https://host/path` transform from docs/extension-api.md §0, plus
 * the `ssh://` spelling of the same remote.
 *
 * Returns null when the remote has no web page — a local path, a `git://` daemon, a sibling
 * clone — which is exactly what the menu item's `when` reads: offering "open in browser"
 * for one would hand `ctx.open` a directory to open in a file manager.
 *
 * The commits Pane builds its commit URLs from the same set of patterns, kept in step by
 * hand because ADR-0001 gives the two no package to share them through: the two items sit
 * one menu apart, and a remote one of them recognises and the other does not is an
 * inconsistency the user has no way to explain. Any correction here is owed to that copy.
 */
function webRemoteUrl(remotes: readonly Remote[]): string | null {
  // `origin` before position: "the repository" means the canonical remote, and `remotes[0]`
  // is only whichever one git config happened to list first.
  const remote = remotes.find((entry) => entry.name === "origin") ?? remotes[0]
  if (remote === undefined) return null

  const url = remote.fetchUrl.trim()
  const ssh = sshUrlRemote.exec(url) ?? scpRemote.exec(url)
  const host = ssh?.[1]
  const path = ssh?.[2]
  if (host !== undefined && path !== undefined) return `https://${host}/${path}`
  return httpRemote.exec(url)?.[1] ?? null
}

/**
 * What to put in front of the user when git says no. {@link GitError} carries the real
 * stderr, and credential prompting is off by design, so git's own sentence is the whole
 * explanation; anything else reaching here is a bug in this Extension and should say so
 * rather than hide behind a generic message.
 */
function failureMessage(error: unknown): string {
  if (error instanceof GitError) {
    const stderr = error.stderr.trim()
    return stderr === "" ? error.message : stderr
  }
  return error instanceof Error ? error.message : String(error)
}

export default defineExtension({
  name: "status",
  description: "Repository status: branch, divergence, and working-tree counts",

  activate(ctx) {
    // Read once, in activate: the repository root is constant for the session, so neither
    // the Pane nor the segment has to touch the ctx surface while rendering.
    const root = ctx.git.root
    const repoName = directoryName(root)

    function StatusPane() {
      const theme = useTheme()
      const head = useGit((state) => state.head)
      const status = useGit((state) => state.status)
      const stashes = useGit((state) => state.stash.length)
      const line = headLine(head)

      // Running outside a repository is a supported mode, and a blank Pane would read as a
      // crash rather than as the answer.
      if (line.kind === "noRepository") return <text fg={theme.textMuted} content="no repository" />

      return (
        <box flexDirection="column">
          {/* HEAD first, repository name last, because the row is clipped from the right:
              in a narrow column the name is the part a user can already infer from the
              window they are looking at, and the branch is the part they came here for. */}
          <Row segments={[...headSegments(line, theme), { key: "repo", text: ` ${repoName}`, fg: theme.textMuted }]} />
          <Row segments={workingTreeSegments(status, stashes, theme)} />
        </box>
      )
    }

    function StatusSegment() {
      const theme = useTheme()
      const head = useGit((state) => state.head)
      const clean = useGit((state) => state.status.isClean)
      const line = headLine(head)

      // Nothing to describe: the status line is shared, so a segment with no answer takes
      // no width rather than printing a placeholder next to everyone else's real data.
      if (line.kind === "noRepository") return null
      const label = line.kind === "detached" ? line.shortOid : line.branch
      return (
        <Row
          segments={[
            { key: "head", text: label, fg: theme.accent },
            ...(clean ? [] : [{ key: "dirty", text: "*", fg: theme.warning }]),
          ]}
        />
      )
    }

    const pane = ctx.panes.register({
      id: "status",
      title: "Status",
      component: StatusPane,
      placement: { column: 0, order: 10 },
    })

    ctx.statusline.register({ id: "status", component: StatusSegment, align: "left" })

    ctx.commands.register({
      id: "status.focus",
      title: "Focus status",
      keys: "1",
      run: () => pane.focus(),
    })

    ctx.commands.register({
      id: "status.menu",
      title: "Repository actions",
      keys: "x",
      pane: "status",
      // The target is snapshotted at open(), which is what makes every item's `when` and
      // `run` agree on one state rather than each re-reading a store that may have moved.
      run: () => ctx.menus.open("status.actions", ctx.git.state),
    })

    async function report(work: () => Promise<void>, done: string): Promise<void> {
      try {
        await work()
        ctx.popups.notify(done, "success")
      } catch (error) {
        ctx.popups.notify(failureMessage(error), "error")
      }
    }

    ctx.menus.register({
      id: "status.actions",
      title: `Repository: ${repoName}`,
      groups: [
        {
          id: "sync",
          items: [
            { key: "r", label: "Refresh", run: () => report(() => ctx.git.refresh(), "Refreshed") },
            { key: "f", label: "Fetch all remotes", run: () => report(() => ctx.git.fetch(), "Fetched all remotes") },
          ],
        },
        {
          id: "repository",
          items: [
            {
              key: "o",
              label: "Open repository in browser",
              when: (state) => webRemoteUrl(state.remotes) !== null,
              run: async (state) => {
                const url = webRemoteUrl(state.remotes)
                // `when` already established there is one; this narrows the type rather
                // than asking the same question a second time.
                if (url !== null) await ctx.open(url)
              },
            },
            {
              key: "y",
              label: "Copy repository root path",
              run: () => report(() => ctx.copy(root), root),
            },
          ],
        },
      ],
    })
  },
})
