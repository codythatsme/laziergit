import { remoteWebUrl, type PullRequest, type PullRequestRepository, type Remote } from "laziergit"

interface PullRequestNode {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly headRefName: string
  readonly isDraft: boolean
  readonly updatedAt: string
  readonly author: { readonly login: string } | null
}

interface PullRequestQueryResponse {
  readonly data?: {
    readonly viewer?: { readonly login?: string } | null
    readonly repository?: {
      readonly pullRequests?: { readonly nodes?: readonly PullRequestNode[] } | null
    } | null
  }
}

const pullRequestFields = "number title url headRefName isDraft updatedAt author { login }"

/** `upstream` is the canonical project in a fork workflow; `origin` is the ordinary fallback. */
export function pullRequestRepository(remotes: readonly Remote[]): PullRequestRepository | null {
  const selected =
    remotes.find((remote) => remote.name === "upstream") ??
    remotes.find((remote) => remote.name === "origin") ??
    remotes[0]
  if (selected === undefined) return null

  const web = remoteWebUrl([selected])
  if (web === null) return null
  try {
    const url = new URL(web)
    const [owner, name] = url.pathname.split("/").filter(Boolean)
    return owner === undefined || name === undefined ? null : { host: url.host, owner, name }
  } catch {
    return null
  }
}

export function repositoryKey(repository: PullRequestRepository): string {
  return `${repository.host}/${repository.owner}/${repository.name}`
}

/** The HOST/OWNER/REPO spelling accepted by every repository-targeted `gh pr` command. */
export function repositoryArgument(repository: PullRequestRepository): string {
  return repositoryKey(repository)
}

/** Exhaustive pagination over open PRs, ordered at the source by most recent update. */
export function pullRequestQueryArgs(repository: PullRequestRepository): readonly string[] {
  const query = `query($owner: String!, $repo: String!, $endCursor: String) { viewer { login } repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $endCursor, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${pullRequestFields} } pageInfo { hasNextPage endCursor } } } }`
  return [
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "--hostname",
    repository.host,
    "-f",
    `query=${query}`,
    "-f",
    `owner=${repository.owner}`,
    "-f",
    `repo=${repository.name}`,
  ]
}

function updatedAt(pullRequest: Pick<PullRequest, "updatedAt">): number {
  const timestamp = Date.parse(pullRequest.updatedAt)
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
}

/**
 * `--slurp` produces one response per page. Filter against each page's authenticated viewer,
 * then sort again because updates landing during pagination can disturb page boundaries.
 */
export function parseAuthoredPullRequests(stdout: string, repository: PullRequestRepository): readonly PullRequest[] {
  const parsed = JSON.parse(stdout) as PullRequestQueryResponse | readonly PullRequestQueryResponse[]
  const responses: readonly PullRequestQueryResponse[] = Array.isArray(parsed)
    ? parsed
    : [parsed as PullRequestQueryResponse]
  const byNumber = new Map<number, PullRequest>()

  for (const response of responses) {
    const viewer = response.data?.viewer?.login
    const connection = response.data?.repository?.pullRequests
    if (viewer === undefined || connection === null || connection === undefined) {
      throw new Error("GitHub returned an incomplete pull request response")
    }
    const login = viewer.toLowerCase()
    for (const node of connection.nodes ?? []) {
      if (node.author?.login.toLowerCase() !== login) continue
      const pullRequest: PullRequest = {
        number: node.number,
        title: node.title,
        url: node.url,
        headRefName: node.headRefName,
        isDraft: node.isDraft,
        updatedAt: node.updatedAt,
        repository,
      }
      const previous = byNumber.get(node.number)
      if (previous === undefined || updatedAt(pullRequest) > updatedAt(previous)) {
        byNumber.set(node.number, pullRequest)
      }
    }
  }

  return [...byNumber.values()].sort((left, right) => updatedAt(right) - updatedAt(left) || right.number - left.number)
}

/** "5s", "3m", "2h", "4d" — coarse because the visible Pane repaints on its poll tick. */
export function formatAge(timestamp: string, now: Date): string | null {
  const then = Date.parse(timestamp)
  if (Number.isNaN(then)) return null
  const total = Math.max(0, Math.round((now.getTime() - then) / 1000))
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m`
  if (total < 86400) return `${Math.floor(total / 3600)}h`
  return `${Math.floor(total / 86400)}d`
}
