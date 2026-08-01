import type { Remote } from "./types"

/**
 * The three remote spellings that have a web page behind them.
 *
 * The SSH forms need separate patterns because the colon means opposite things: in the
 * scp-short form everything after it is path, while `ssh://git@host:22/owner/repo.git` has a
 * port. The user is optional in the URL form but required in the scp-short one, where it is
 * all that separates `host:path` from a Windows drive letter or a relative path.
 */
const sshUrlRemote = /^ssh:\/\/(?:[^@\s/]+@)?([^\s:/]+)(?::\d+)?\/(\S+?)(?:\.git)?\/?$/
const scpRemote = /^[^@\s/]+@([^\s:/]+):(\S+?)(?:\.git)?\/?$/
const httpRemote = /^(https?:\/\/\S+?)(?:\.git)?\/?$/

/**
 * The web page a repository's remote corresponds to, or `null` when it has none — a `file://`
 * remote, a `git://` daemon or a sibling clone, where `null` is what lets an "open on remote"
 * contextual Command hide itself with `when`. Prefers `origin` over whatever git listed first.
 *
 * ```ts
 * const url = remoteWebUrl(ctx.git.state.remotes);
 * // a commit page: `${url}/commit/${oid}`
 * ```
 */
export function remoteWebUrl(remotes: readonly Remote[]): string | null {
  const remote = remotes.find((entry) => entry.name === "origin") ?? remotes[0]
  if (remote === undefined) return null

  const url = remote.fetchUrl.trim()
  const ssh = sshUrlRemote.exec(url) ?? scpRemote.exec(url)
  const host = ssh?.[1]
  const path = ssh?.[2]
  if (host !== undefined && path !== undefined) return `https://${host}/${path}`
  return httpRemote.exec(url)?.[1] ?? null
}
