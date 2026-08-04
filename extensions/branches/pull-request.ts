import { remoteWebUrl, type Branch, type Remote } from "laziergit"

export const pullRequestFields = "headRefName,headRepositoryOwner,state,isDraft,url,createdAt"

/** The part of `gh pr list --json` used by the branches pane. */
export interface PullRequest {
  readonly headRefName: string
  readonly headRepositoryOwner: { readonly login: string } | null
  readonly state: string
  readonly isDraft: boolean
  readonly url: string
  readonly createdAt: string
}

function remoteOwner(remote: Remote): string | null {
  const web = remoteWebUrl([remote])
  if (web === null) return null
  try {
    return new URL(web).pathname.split("/").filter(Boolean)[0] ?? null
  } catch {
    return null
  }
}

function createdAt(pullRequest: PullRequest): number {
  const timestamp = Date.parse(pullRequest.createdAt)
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
}

/**
 * Maps a local branch to the newest PR for the ref it tracks. The remote owner is part of the
 * key: two forks can both have a `topic` branch and PRs against the same base repository.
 */
export function pullRequestsByBranch(
  pullRequests: readonly PullRequest[],
  branches: readonly Branch[],
  remotes: readonly Remote[],
): ReadonlyMap<string, PullRequest> {
  const owners = new Map(
    remotes.flatMap((remote): readonly [readonly [string, string]] | readonly [] => {
      const owner = remoteOwner(remote)
      return owner === null ? [] : [[remote.name, owner.toLowerCase()]]
    }),
  )
  const newestByHead = new Map<string, PullRequest>()
  for (const pullRequest of pullRequests) {
    const owner = pullRequest.headRepositoryOwner?.login.toLowerCase()
    if (owner === undefined) continue
    const key = `${owner}\0${pullRequest.headRefName}`
    const previous = newestByHead.get(key)
    if (previous === undefined || createdAt(pullRequest) > createdAt(previous)) newestByHead.set(key, pullRequest)
  }

  const result = new Map<string, PullRequest>()
  for (const branch of branches) {
    const upstream = branch.upstream
    if (upstream === null) continue
    const owner = owners.get(upstream.remote)
    if (owner === undefined) continue
    const pullRequest = newestByHead.get(`${owner}\0${upstream.branch}`)
    if (pullRequest !== undefined) result.set(branch.name, pullRequest)
  }
  return result
}

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
