import type { Remote } from "./types"

/**
 * The three remote spellings that have a web page behind them.
 *
 * The two SSH forms are matched separately rather than by one pattern with an optional
 * `ssh://`, because the colon means opposite things in them: in the scp-short form
 * everything after it is path, while in the URL form `ssh://git@host:22/owner/repo.git` it
 * introduces a *port*. One pattern for both turns that port into a path segment and builds
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
 * The web page a repository's remote corresponds to, or `null` when it has none.
 *
 * The `git@host:path` → `https://host/path` transform, plus the `ssh://` and HTTP(S)
 * spellings of the same remote. `origin` is preferred over whatever git listed first,
 * because "the repository" means the canonical remote and `remotes[0]` is the wrong answer
 * the moment a fork is added.
 *
 * Returning `null` is the point: a `file://` remote, a `git://` daemon, a bare directory or
 * a sibling clone has no page, and `null` is what lets an "open on remote" menu item hide
 * itself with `when` rather than hand {@link ExtensionContext.open} a directory to open in a
 * file manager.
 *
 * ```ts
 * const url = remoteWebUrl(ctx.git.state.remotes);
 * // a commit page: `${url}/commit/${oid}`
 * ```
 *
 * Public API rather than a snippet each Extension copies: two Bundled Extensions carried
 * this transform, one menu apart, "kept in step by hand" — and they had already diverged on
 * the port case by the time anyone compared them. A remote one Pane recognises and another
 * does not is an inconsistency the user has no way to explain, and §5.11's test applies —
 * shared logic is public API or it is copy-paste.
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
