import { remoteWebUrl, type Remote } from "laziergit"

/**
 * The page a hosting service opens a pull request for a branch on, or `null` when the
 * repository has no web remote to open one against.
 *
 * A helper file beside the Extension rather than public API, for the same reason the files
 * Pane's tree is one: it is one Pane's view model, and the second consumer is the thing that
 * would tell us which parts generalise. What *is* public is the half both Panes already
 * share — {@link remoteWebUrl} turns whichever spelling of a remote git recorded into an
 * `https://host/owner/repo`, and this only appends the path.
 *
 * GitHub's path, the same bet the commits Pane makes for `/commit/<oid>`: `/compare/<branch>`
 * is what GitHub, Gitea and Codeberg all spell, and `?expand=1` is what opens the form rather
 * than a diff you then have to click through. GitLab is the known miss — it wants
 * `/-/merge_requests/new?merge_request[source_branch]=…` — and a service table belongs with
 * the first user who needs it, not ahead of them.
 *
 * The branch name is encoded segment by segment, because a branch name is a path: `/` has to
 * survive (`feature/thing` is one branch, not two) while `#`, `?` and a space must not. A
 * whole-string `encodeURIComponent` would send `feature%2Fthing`, which GitHub resolves to
 * nothing at all.
 */
export function pullRequestUrl(remotes: readonly Remote[], branch: string): string | null {
  const base = remoteWebUrl(remotes)
  if (base === null) return null
  const path = branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `${base}/compare/${path}?expand=1`
}
