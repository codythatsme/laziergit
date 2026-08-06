import { describe, expect, it } from "bun:test"
import type { Branch, Remote, UpstreamInfo } from "laziergit"

import {
  cleanableBranches,
  githubRepository,
  mergedPullRequestQueryArgs,
  parsePullRequestQuery,
  pullRequestQueryArgs,
  pullRequestsByBranch,
  pullRequestUrl,
  type PullRequest,
} from "./pull-request"

function remote(fetchUrl: string, name = "origin"): Remote {
  return { name, fetchUrl, pushUrl: fetchUrl }
}

const origin = [remote("git@github.com:owner/repo.git")]

function upstream(remote = "origin", branch = "topic", gone = false): UpstreamInfo {
  return { remote, branch, gone, ahead: 0, behind: 0 }
}

function localBranch(name: string, tracking: UpstreamInfo | null = upstream(), oid = "a".repeat(40)): Branch {
  return {
    name,
    oid,
    isHead: false,
    upstream: tracking,
    lastCommit: { oid, subject: "subject", authoredAt: 0 },
  }
}

function pr(
  url: string,
  owner = "owner",
  branch = "topic",
  createdAt = "2026-08-01T00:00:00Z",
  headRefOid = "a".repeat(40),
  state = "OPEN",
): PullRequest {
  return {
    headRefName: branch,
    headRefOid,
    headRepositoryOwner: { login: owner },
    state,
    isDraft: false,
    url,
    createdAt,
  }
}

describe("pullRequestUrl", () => {
  it("points at the branch's compare page with the form already open", () => {
    expect(pullRequestUrl(origin, "main")).toBe("https://github.com/owner/repo/compare/main?expand=1")
  })

  it("keeps the slashes in a namespaced branch", () => {
    expect(pullRequestUrl(origin, "feature/nested/thing")).toBe(
      "https://github.com/owner/repo/compare/feature/nested/thing?expand=1",
    )
  })

  it("encodes what would otherwise end the path or start a query", () => {
    expect(pullRequestUrl(origin, "fix/#42 crash")).toBe(
      "https://github.com/owner/repo/compare/fix/%2342%20crash?expand=1",
    )
  })

  it("has nothing to open without a web remote", () => {
    expect(pullRequestUrl([remote("/srv/git/repo.git")], "main")).toBeNull()
    expect(pullRequestUrl([], "main")).toBeNull()
  })

  it("follows origin rather than whatever git listed first", () => {
    const remotes = [remote("git@github.com:someone/fork.git", "upstream"), remote("git@github.com:me/repo.git")]
    expect(pullRequestUrl(remotes, "topic")).toBe("https://github.com/me/repo/compare/topic?expand=1")
  })
})

describe("GitHub pull request query", () => {
  it("targets upstream as the base repository in a fork workflow", () => {
    const remotes = [remote("git@github.com:me/repo.git"), remote("https://github.com/base/repo.git", "upstream")]

    expect(githubRepository(remotes)).toEqual({ host: "github.com", owner: "base", name: "repo" })
  })

  it("falls back to origin and ignores remotes with no web repository", () => {
    expect(githubRepository(origin)).toEqual({ host: "github.com", owner: "owner", name: "repo" })
    expect(githubRepository([remote("/srv/git/repo.git")])).toBeNull()
  })

  it("asks GraphQL only for the tracked branch names", () => {
    const args = pullRequestQueryArgs({ host: "github.example.com", owner: "base", name: "tools" }, [
      "feature/one",
      "feature/two",
    ])
    const command = args.join(" ")

    expect(command).toStartWith("api graphql --hostname github.example.com")
    expect(command).toContain("repository(owner: $owner, name: $repo)")
    expect(command).toContain("headRefName: $branch0")
    expect(command).toContain("headRefName: $branch1")
    expect(command).toContain("first: 5")
    expect(command).toContain("headRefOid")
    expect(command).toContain("-f owner=base -f repo=tools")
    expect(command).toContain("-f branch0=feature/one -f branch1=feature/two")
    expect(command).not.toContain("--limit 1000")
  })

  it("asks for merged pull request history when cleaning branches", () => {
    const command = mergedPullRequestQueryArgs(
      { host: "github.com", owner: "base", name: "tools" },
      "feature/one",
    ).join(" ")

    expect(command).toContain("first: 100")
    expect(command).toContain("after: $endCursor")
    expect(command).toContain("headRefName: $branch, states: [MERGED]")
    expect(command).toContain("headRefOid")
    expect(command).toContain("pageInfo { hasNextPage endCursor }")
    expect(command).toContain("--paginate --slurp")
    expect(command).toContain("-f branch=feature/one")
  })

  it("flattens branch aliases from the GraphQL response", () => {
    const one = pr("https://github.com/base/repo/pull/1", "one", "topic")
    const two = pr("https://github.com/base/repo/pull/2", "two", "topic")
    const response = JSON.stringify({
      data: { repository: { branch0: { nodes: [one] }, branch1: { nodes: [two] } } },
    })

    expect(parsePullRequestQuery(response)).toEqual([one, two])
  })

  it("flattens every page from a paginated cleanup response", () => {
    const one = pr("https://github.com/base/repo/pull/1")
    const two = pr("https://github.com/base/repo/pull/2")
    const response = JSON.stringify([
      { data: { repository: { pullRequests: { nodes: [one] } } } },
      { data: { repository: { pullRequests: { nodes: [two] } } } },
    ])

    expect(parsePullRequestQuery(response)).toEqual([one, two])
  })
})

describe("pullRequestsByBranch", () => {
  it("maps the tracked ref rather than assuming the local branch has the same name", () => {
    const pullRequest = pr("https://github.com/base/repo/pull/12")
    const branches = [localBranch("local-topic")]

    expect(pullRequestsByBranch([pullRequest], branches, origin).get("local-topic")).toBe(pullRequest)
  })

  it("uses the upstream owner to disambiguate identically named branches from forks", () => {
    const mine = pr("https://github.com/base/repo/pull/12", "me")
    const theirs = pr("https://github.com/base/repo/pull/13", "them")
    const remotes = [remote("git@github.com:base/repo.git"), remote("git@github.com:me/repo.git", "fork")]
    const branches = [localBranch("topic", upstream("fork"))]

    expect(pullRequestsByBranch([theirs, mine], branches, remotes).get("topic")).toBe(mine)
  })

  it("chooses the newest pull request for a reused branch", () => {
    const older = pr("https://github.com/owner/repo/pull/1", "owner", "topic", "2026-07-01T00:00:00Z")
    const newer = pr("https://github.com/owner/repo/pull/2", "owner", "topic", "2026-08-01T00:00:00Z")

    expect(pullRequestsByBranch([older, newer], [localBranch("topic")], origin).get("topic")).toBe(newer)
  })

  it("does not guess for an untracked branch or a remote without a web owner", () => {
    const pullRequest = pr("https://github.com/owner/repo/pull/12")

    expect(pullRequestsByBranch([pullRequest], [localBranch("topic", null)], origin).size).toBe(0)
    expect(pullRequestsByBranch([pullRequest], [localBranch("topic")], [remote("/srv/git/repo.git")]).size).toBe(0)
  })
})

describe("cleanableBranches", () => {
  it("requires a gone upstream and a merged PR at the exact local tip", () => {
    const exactOid = "b".repeat(40)
    const eligible = localBranch("eligible", upstream("origin", "eligible", true), exactOid)
    const notGone = localBranch("not-gone", upstream("origin", "not-gone"), exactOid)
    const wrongOid = localBranch("wrong-oid", upstream("origin", "wrong-oid", true), exactOid)
    const stillOpen = localBranch("still-open", upstream("origin", "still-open", true), exactOid)
    const otherFork = localBranch("other-fork", upstream("origin", "other-fork", true), exactOid)
    const checkedOut = {
      ...localBranch("checked-out", upstream("origin", "checked-out", true), exactOid),
      isHead: true,
    }
    const merged = (branch: string, oid = exactOid, owner = "owner", state = "MERGED") =>
      pr(`https://github.com/owner/repo/pull/${branch}`, owner, branch, "2026-08-01T00:00:00Z", oid, state)

    expect(
      cleanableBranches(
        [
          merged("eligible"),
          merged("not-gone"),
          merged("wrong-oid", "c".repeat(40)),
          merged("still-open", exactOid, "owner", "OPEN"),
          merged("other-fork", exactOid, "someone-else"),
          merged("checked-out"),
        ],
        [eligible, notGone, wrongOid, stillOpen, otherFork, checkedOut],
        origin,
      ).map((branch) => branch.name),
    ).toEqual(["eligible"])
  })
})
