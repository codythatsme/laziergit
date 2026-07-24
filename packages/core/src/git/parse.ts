import type { Branch, ChangeKind, Commit, FileChange, Head, Remote, StashEntry, Tag, UpstreamInfo } from "laziergit"

/**
 * Porcelain readers. Every function here is pure: argv in one place, bytes to model in
 * another, so every format quirk below is testable without a repository.
 *
 * `%00` is the field separator throughout. Git forbids NUL in refnames, oids, author
 * fields, and single-line subjects, so no value can ever contain one — which is what
 * makes these splits total rather than heuristic.
 */

const nul = "\0"

/** Records are NUL-*terminated*, so a well-formed stream always ends in an empty element. */
function nulRecords(stdout: string): readonly string[] {
  return stdout.split(nul).filter((record) => record.length > 0)
}

function lines(stdout: string): readonly string[] {
  return stdout.split("\n").filter((line) => line.length > 0)
}

function chunk(fields: readonly string[], size: number): readonly (readonly string[])[] {
  const chunks: (readonly string[])[] = []
  for (let index = 0; index + size <= fields.length; index += size) chunks.push(fields.slice(index, index + size))
  return chunks
}

/**
 * The rest of a record after `count` space-separated tokens. Written as an index scan
 * rather than `split(" ", count)` because JS's split limit *discards* the tail instead
 * of keeping it — and the tail is the path, which may itself contain spaces.
 */
function afterTokens(record: string, count: number): string | null {
  let index = 0
  for (let token = 0; token < count; token += 1) {
    const next = record.indexOf(" ", index)
    if (next === -1) return null
    index = next + 1
  }
  return index < record.length ? record.slice(index) : null
}

function epochSecondsToMs(value: string): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) ? seconds * 1000 : 0
}

// ---- status -----------------------------------------------------------------------

export const statusArgs = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"] as const

export interface ParsedStatus {
  /** `# branch.oid`, or null on an unborn HEAD, where git reports `(initial)` instead. */
  readonly oid: string | null
  readonly staged: readonly FileChange[]
  readonly unstaged: readonly FileChange[]
  readonly untracked: readonly FileChange[]
  readonly conflicted: readonly FileChange[]
}

const changeKinds: Readonly<Record<string, ChangeKind>> = Object.freeze({
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
})

function changed(code: string): ChangeKind | null {
  return changeKinds[code] ?? null
}

/**
 * Parses `--porcelain=v2 -z`.
 *
 * The one trap is the `2` (rename/copy) record: under `-z` it consumes **two** NUL
 * fields, the second being the original path, so the read has to advance the cursor
 * itself rather than iterate. `XY` is two independent columns — `X` is HEAD→index and
 * `Y` is index→worktree — so `MM` legitimately produces one staged *and* one unstaged
 * entry for the same path.
 */
export function parseStatus(stdout: string): ParsedStatus {
  const records = nulRecords(stdout)
  const staged: FileChange[] = []
  const unstaged: FileChange[] = []
  const untracked: FileChange[] = []
  const conflicted: FileChange[] = []
  let oid: string | null = null

  for (let cursor = 0; cursor < records.length; cursor += 1) {
    const record = records[cursor]
    if (record === undefined) continue

    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length)
      // A repository cannot hold an object named `(initial)`, so the sentinel is safe to
      // match — unlike `# branch.head (detached)`, which a branch may legally be named.
      oid = value === "(initial)" ? null : value
      continue
    }
    if (record.startsWith("#")) continue

    const kind = record.slice(0, 2)
    if (kind === "? ") {
      untracked.push({ path: record.slice(2), previousPath: null, kind: "untracked" })
      continue
    }
    // Only emitted under `--ignored`, which we never pass. Consumed defensively so a
    // future flag change cannot silently reinterpret the record as a path.
    if (kind === "! ") continue

    const marker = record.slice(0, 1)
    if (marker === "u") {
      const path = afterTokens(record, 10)
      // The XY of an unmerged record spells which side did what (`UU`, `AA`, `DU`, ...);
      // the model has one conflicted kind, so the detail is deliberately dropped here
      // rather than mangled into a staged/unstaged pair.
      if (path !== null) conflicted.push({ path, previousPath: null, kind: "conflicted" })
      continue
    }
    if (marker !== "1" && marker !== "2") continue

    const codes = record.slice(2, 4)
    const index = codes.slice(0, 1)
    const worktree = codes.slice(1, 2)
    const renamed = marker === "2"
    const path = afterTokens(record, renamed ? 9 : 8)
    if (path === null) continue

    let previousPath: string | null = null
    if (renamed) {
      cursor += 1
      previousPath = records[cursor] ?? null
    }

    const stagedKind = changed(index)
    if (stagedKind) {
      staged.push({
        path,
        previousPath: stagedKind === "renamed" || stagedKind === "copied" ? previousPath : null,
        kind: stagedKind,
      })
    }
    const unstagedKind = changed(worktree)
    // Never `previousPath` here: the worktree change is measured against the index,
    // where the file already lives under its new name.
    if (unstagedKind) unstaged.push({ path, previousPath: null, kind: unstagedKind })
  }

  return { oid, staged, unstaged, untracked, conflicted }
}

// ---- head -------------------------------------------------------------------------

/**
 * `-q` makes a detached HEAD exit 1 with empty output instead of erroring. The exit
 * code is the authority, never the `# branch.head` field: `git checkout -b '(detached)'`
 * is legal and produces a status header byte-identical to a real detached HEAD.
 */
export const symbolicRefArgs = ["symbolic-ref", "-q", "--short", "HEAD"] as const

/**
 * The branch HEAD symbolically points at, or null when it points at a raw commit. Null
 * *is* "detached" — a second boolean saying so would be the same fact twice, and two
 * copies of one fact can disagree.
 */
export function parseHeadRef(stdout: string, exitCode: number): string | null {
  const branch = stdout.trim()
  return exitCode !== 0 || branch.length === 0 ? null : branch
}

/**
 * The one place a {@link Head} variant is decided, because deciding it needs all three
 * reads: `symbolic-ref` says whether HEAD is a branch at all, status says whether that
 * branch has a commit yet, and the branch rows already carry the upstream — HEAD's
 * upstream is *the same object* its row holds, so the two can never disagree.
 *
 * Unborn is decided by the missing oid and detached by the missing branch. They cannot
 * both hold: a detached HEAD *is* an oid, so it always has one. Should git ever report
 * neither — only reachable from empty output — unborn wins, because it is the variant
 * that claims the least and the one the empty store already serves.
 */
export function readHead(status: ParsedStatus, headBranch: string | null, branches: readonly Branch[]): Head {
  if (status.oid === null) return { kind: "unborn", branch: headBranch ?? "" }
  if (headBranch === null) return { kind: "detached", oid: status.oid }
  return {
    kind: "onBranch",
    oid: status.oid,
    branch: headBranch,
    upstream: branches.find((candidate) => candidate.name === headBranch)?.upstream ?? null,
  }
}

// ---- branches ---------------------------------------------------------------------

/**
 * `%(refname)` rather than `%(refname:short)`: shortening is *disambiguating*, so a branch
 * that shares its name with a tag comes back as `heads/x` instead of `x` — and that string
 * is then not a branch name any more, which breaks anything that passes it back to git.
 */
const branchFormat = [
  "%(refname)",
  "%(objectname)",
  "%(upstream:remotename)",
  "%(upstream:remoteref)",
  "%(upstream:track,nobracket)",
  "%(contents:subject)",
  "%(authordate:unix)",
].join("%00")

export const branchArgs = ["for-each-ref", "--sort=-committerdate", `--format=${branchFormat}`, "refs/heads"] as const

const aheadPattern = /(?:^|, )ahead (\d+)/
const behindPattern = /(?:^|, )behind (\d+)/

/**
 * `,nobracket` strips the surrounding `[...]`, leaving `ahead 1`, `behind 2`,
 * `ahead 1, behind 2`, `gone`, or the empty string.
 *
 * `gone` is reported *instead of* a divergence, never alongside one — git has no
 * remote-tracking ref left to compare against — so the counts stay zero and the flag is
 * the only thing that separates a deleted upstream from a perfectly in-sync one.
 */
function readTrack(track: string): { readonly gone: boolean; readonly ahead: number; readonly behind: number } {
  return {
    gone: track === "gone",
    ahead: Number(aheadPattern.exec(track)?.[1] ?? 0),
    behind: Number(behindPattern.exec(track)?.[1] ?? 0),
  }
}

function withoutPrefix(ref: string, prefix: string): string {
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}

function readUpstream(remote: string, remoteRef: string, track: string): UpstreamInfo | null {
  // An empty remotename is the only unambiguous "no upstream" signal: an empty track
  // field means either no upstream or a perfectly in-sync one.
  if (remote.length === 0) return null
  return { remote, branch: withoutPrefix(remoteRef, "refs/heads/"), ...readTrack(track) }
}

/**
 * `headBranch` decides `isHead`, not `%(HEAD)`: while HEAD is detached git marks no row
 * at all, and the marker adds a field that would have to agree with the status output
 * anyway.
 */
export function parseBranches(stdout: string, headBranch: string | null): readonly Branch[] {
  const branches: Branch[] = []
  for (const line of lines(stdout)) {
    const [refname, oid, remote, remoteRef, track, subject, authoredAt] = line.split(nul)
    if (refname === undefined || oid === undefined) continue
    const name = withoutPrefix(refname, "refs/heads/")
    branches.push({
      name,
      oid,
      isHead: headBranch !== null && name === headBranch,
      upstream: readUpstream(remote ?? "", remoteRef ?? "", track ?? ""),
      lastCommit: { oid, subject: subject ?? "", authoredAt: epochSecondsToMs(authoredAt ?? "0") },
    })
  }

  // HEAD first, then most-recently-committed first, which `--sort` already gave us.
  const headIndex = branches.findIndex((branch) => branch.isHead)
  if (headIndex > 0) branches.unshift(...branches.splice(headIndex, 1))
  return branches
}

// ---- remotes ----------------------------------------------------------------------

/**
 * Read from config rather than `git remote -v`, whose `name<TAB>url (fetch)` shape is
 * ambiguous for a URL containing a tab, and rather than `git remote get-url`, which
 * costs two subprocesses per remote. `--null` makes even a URL containing a newline
 * unambiguous: entries are NUL-terminated and `key\nvalue` inside each.
 */
/**
 * Deliberately wider than `parseRemotes` needs. `branch.*` is where a branch's upstream
 * lives, and both it and `remote.*` are invisible to the refs snapshot the poll compares —
 * so this same read is also the poll's fingerprint for everything that is configured
 * rather than committed.
 */
export const configArgs = ["config", "--null", "--get-regexp", "^(remote|branch)\\."] as const

export function parseRemotes(stdout: string): readonly Remote[] {
  const fetchUrls = new Map<string, string>()
  const pushUrls = new Map<string, string>()
  const order: string[] = []

  for (const entry of nulRecords(stdout)) {
    const separator = entry.indexOf("\n")
    if (separator === -1) continue
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if (!key.startsWith("remote.")) continue

    // Remote names may contain dots, so the *last* dot separates name from setting.
    const rest = key.slice("remote.".length)
    const boundary = rest.lastIndexOf(".")
    if (boundary <= 0) continue
    const name = rest.slice(0, boundary)
    const setting = rest.slice(boundary + 1)

    if (!order.includes(name)) order.push(name)
    if (setting === "url") fetchUrls.set(name, value)
    // A multi-push remote declares several pushurls; the model holds one, so the last wins.
    else if (setting === "pushurl") pushUrls.set(name, value)
  }

  const remotes: Remote[] = []
  for (const name of order) {
    const fetchUrl = fetchUrls.get(name)
    // A remote with only a pushurl is malformed config; skipping beats inventing a "".
    if (fetchUrl === undefined) continue
    remotes.push({ name, fetchUrl, pushUrl: pushUrls.get(name) ?? fetchUrl })
  }
  return remotes
}

// ---- tags -------------------------------------------------------------------------

/**
 * `%(*objectname)` is the peeled object of an annotated tag and empty for a lightweight
 * one, so the `%(if)` picks the commit in both cases. Without it an annotated tag would
 * report the oid of the *tag object*, which no commit-shaped consumer can use.
 */
const tagFormat = "%(refname)%00%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)"

export const tagArgs = ["for-each-ref", "--sort=-creatordate", `--format=${tagFormat}`, "refs/tags"] as const

export function parseTags(stdout: string): readonly Tag[] {
  const tags: Tag[] = []
  for (const line of lines(stdout)) {
    const [refname, oid] = line.split(nul)
    if (refname === undefined || oid === undefined) continue
    // Full refname stripped here for the same reason as branches: `:short` disambiguates,
    // and a disambiguated name is no longer the name git will accept back.
    tags.push({ name: withoutPrefix(refname, "refs/tags/"), oid })
  }
  return tags
}

// ---- commits ----------------------------------------------------------------------

const commitFormat = ["%H", "%h", "%at", "%an", "%ae", "%P", "%s"].join("%x00")

/**
 * `-z` NUL-terminates each record and the format ends in `%s`, so the output is one flat
 * NUL-separated field stream with no newlines at all — `%s` folds a multi-line first
 * paragraph onto one line and emits any `%H` inside the message literally.
 *
 * The trailing `--` stops a ref that shares a name with a file from being reinterpreted
 * as a pathspec.
 */
export function commitArgs(limit: number): readonly string[] {
  return ["log", "-z", "--no-show-signature", `--max-count=${limit}`, `--format=${commitFormat}`, "HEAD", "--"]
}

export function parseCommits(stdout: string): readonly Commit[] {
  const commits: Commit[] = []
  for (const [oid, shortOid, authoredAt, name, email, parents, subject] of chunk(stdout.split(nul), 7)) {
    if (oid === undefined || oid.length === 0) continue
    commits.push({
      oid,
      shortOid: shortOid ?? "",
      subject: subject ?? "",
      author: { name: name ?? "", email: email ?? "" },
      authoredAt: epochSecondsToMs(authoredAt ?? "0"),
      parents: parents === undefined || parents.length === 0 ? [] : parents.split(" "),
    })
  }
  return commits
}

// ---- stash ------------------------------------------------------------------------

export const stashArgs = ["stash", "list", "-z", "--format=%gd%x00%H%x00%ct%x00%gs"] as const

const stashSelector = /^stash@\{(\d+)\}$/
/**
 * `[^:]+` rather than a greedy capture, because git forbids `:` in a branch name but a
 * stash *message* may contain one: `On main: msg: with colon` must yield the branch
 * `main`, not `main: msg`.
 */
const stashSubject = /^(?:WIP on|On) ([^:]+): ([\s\S]*)$/

export function parseStash(stdout: string): readonly StashEntry[] {
  const entries: StashEntry[] = []
  for (const [selector, oid, createdAt, subject] of chunk(stdout.split(nul), 4)) {
    if (oid === undefined || oid.length === 0) continue

    const matched = stashSelector.exec(selector ?? "")
    const parsed = stashSubject.exec(subject ?? "")
    const branch = parsed?.[1]
    entries.push({
      // Position is the fallback: `stash@{N}` is what `%gd` reports under default config,
      // but ref-shortening settings can reshape it, and the list is always in order.
      index: matched ? Number(matched[1]) : entries.length,
      oid,
      // Git writes the literal `(no branch)` for a stash taken while detached, so there
      // is no branch to name. A subject with no `On`/`WIP on` prefix (plumbing wrote it)
      // keeps its whole text as the message.
      message: parsed?.[2] ?? subject ?? "",
      branch: branch === undefined || branch === "(no branch)" ? null : branch,
      createdAt: epochSecondsToMs(createdAt ?? "0"),
    })
  }
  return entries
}

// ---- fingerprint ------------------------------------------------------------------

/**
 * Every ref plus HEAD in one process. Exits 1 with empty stderr on a repository that
 * has no refs at all, which {@link execGitAllowingEmpty} reads as an empty snapshot.
 */
export const refSnapshotArgs = ["show-ref", "--head"] as const
