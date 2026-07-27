import { remoteWebUrl, type Remote } from "laziergit"

/**
 * The page a hosting service opens a pull request for a branch on, or `null` when the
 * repository has no web remote.
 *
 * GitHub's `/compare` path, which Gitea and Codeberg share; GitLab is a known miss. Encoded a
 * segment at a time because a branch name is a path — `feature/thing` must not become
 * `feature%2Fthing`, which GitHub resolves to nothing.
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
