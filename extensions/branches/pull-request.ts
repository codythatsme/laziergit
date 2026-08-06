import { remoteWebUrl, type Branch, type Remote } from "laziergit"

const pullRequestGraphqlFields = "headRefName headRefOid headRepositoryOwner { login } state isDraft url createdAt"

export interface GitHubRepository {
  readonly host: string
  readonly owner: string
  readonly name: string
}

/** The part of `gh pr list --json` used by the branches pane. */
export interface PullRequest {
  readonly headRefName: string
  readonly headRefOid: string | null
  readonly headRepositoryOwner: { readonly login: string } | null
  readonly state: string
  readonly isDraft: boolean
  readonly url: string
  readonly createdAt: string
}

interface PullRequestConnection {
  readonly nodes?: readonly PullRequest[]
}

interface PullRequestQueryResponse {
  readonly data?: {
    readonly repository?: Readonly<Record<string, PullRequestConnection | null>> | null
  }
}

/**
 * The repository whose pull requests local branches target. Fork workflows conventionally
 * call that remote `upstream`; a single remote is unambiguous, and `origin` is the useful
 * fallback when several remotes exist without that convention.
 */
export function githubRepository(remotes: readonly Remote[]): GitHubRepository | null {
  const candidates = remotes.flatMap((remote): readonly [readonly [Remote, GitHubRepository]] | readonly [] => {
    const web = remoteWebUrl([remote])
    if (web === null) return []
    try {
      const url = new URL(web)
      const [owner, name] = url.pathname.split("/").filter(Boolean)
      return owner === undefined || name === undefined ? [] : [[remote, { host: url.host, owner, name }]]
    } catch {
      return []
    }
  })
  if (candidates.length === 0) return null
  const selected =
    candidates.find(([remote]) => remote.name === "upstream") ??
    candidates.find(([remote]) => remote.name === "origin") ??
    candidates[0]
  return selected?.[1] ?? null
}

/** A targeted GraphQL request: five newest PRs for each tracked branch, as LazyGit does. */
export function pullRequestQueryArgs(repository: GitHubRepository, branches: readonly string[]): readonly string[] {
  const declarations = ["$owner: String!", "$repo: String!"]
  const fields = branches.map((branch, index) => {
    const variable = `branch${index}`
    declarations.push(`$${variable}: String!`)
    return `${variable}: pullRequests(first: 5, headRefName: $${variable}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${pullRequestGraphqlFields} } }`
  })
  const query = `query(${declarations.join(", ")}) { repository(owner: $owner, name: $repo) { ${fields.join(" ")} } }`
  return [
    "api",
    "graphql",
    "--hostname",
    repository.host,
    "-f",
    `query=${query}`,
    "-f",
    `owner=${repository.owner}`,
    "-f",
    `repo=${repository.name}`,
    ...branches.flatMap((branch, index) => ["-f", `branch${index}=${branch}`]),
  ]
}

/** Queries only merged PRs when deciding whether a gone local branch is safe to clean. */
export function mergedPullRequestQueryArgs(repository: GitHubRepository, branch: string): readonly string[] {
  const query = `query($owner: String!, $repo: String!, $branch: String!, $endCursor: String) { repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $endCursor, headRefName: $branch, states: [MERGED], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${pullRequestGraphqlFields} } pageInfo { hasNextPage endCursor } } } }`
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
    "-f",
    `branch=${branch}`,
  ]
}

export function parsePullRequestQuery(stdout: string): readonly PullRequest[] {
  const parsed = JSON.parse(stdout) as PullRequestQueryResponse | readonly PullRequestQueryResponse[]
  const responses: readonly PullRequestQueryResponse[] = Array.isArray(parsed)
    ? parsed
    : [parsed as PullRequestQueryResponse]
  return responses.flatMap((response) => {
    const repository = response.data?.repository
    if (repository === null || repository === undefined) return []
    return Object.values(repository).flatMap((connection) => connection?.nodes ?? [])
  })
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

function ownersByRemote(remotes: readonly Remote[]): ReadonlyMap<string, string> {
  return new Map(
    remotes.flatMap((remote): readonly [readonly [string, string]] | readonly [] => {
      const owner = remoteOwner(remote)
      return owner === null ? [] : [[remote.name, owner.toLowerCase()]]
    }),
  )
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
  const owners = ownersByRemote(remotes)
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
 * Local branches whose upstream disappeared and whose exact tip was merged through a pull
 * request. Matching the remote owner prevents a PR from another fork with the same branch name
 * from authorizing deletion.
 */
export function cleanableBranches(
  pullRequests: readonly PullRequest[],
  branches: readonly Branch[],
  remotes: readonly Remote[],
): readonly Branch[] {
  const owners = ownersByRemote(remotes)
  const mergedHeads = new Set(
    pullRequests.flatMap((pullRequest): readonly string[] => {
      const owner = pullRequest.headRepositoryOwner?.login.toLowerCase()
      if (
        owner === undefined ||
        pullRequest.state.toUpperCase() !== "MERGED" ||
        typeof pullRequest.headRefOid !== "string"
      ) {
        return []
      }
      return [`${owner}\0${pullRequest.headRefName}\0${pullRequest.headRefOid}`]
    }),
  )

  return branches.filter((branch) => {
    const upstream = branch.upstream
    if (branch.isHead || upstream?.gone !== true) return false
    const owner = owners.get(upstream.remote)
    return owner !== undefined && mergedHeads.has(`${owner}\0${upstream.branch}\0${branch.oid}`)
  })
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
