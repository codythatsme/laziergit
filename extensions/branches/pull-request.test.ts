import { describe, expect, it } from "bun:test"
import type { Branch, Remote, UpstreamInfo } from "laziergit"

import { pullRequestsByBranch, pullRequestUrl, type PullRequest } from "./pull-request"

function remote(fetchUrl: string, name = "origin"): Remote {
  return { name, fetchUrl, pushUrl: fetchUrl }
}

const origin = [remote("git@github.com:owner/repo.git")]

function upstream(remote = "origin", branch = "topic"): UpstreamInfo {
  return { remote, branch, gone: false, ahead: 0, behind: 0 }
}

function localBranch(name: string, tracking: UpstreamInfo | null = upstream()): Branch {
  return {
    name,
    oid: "a".repeat(40),
    isHead: false,
    upstream: tracking,
    lastCommit: { oid: "a".repeat(40), subject: "subject", authoredAt: 0 },
  }
}

function pr(url: string, owner = "owner", branch = "topic", createdAt = "2026-08-01T00:00:00Z"): PullRequest {
  return {
    headRefName: branch,
    headRepositoryOwner: { login: owner },
    state: "OPEN",
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
