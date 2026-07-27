import { describe, expect, it } from "bun:test"
import type { Remote } from "laziergit"

import { pullRequestUrl } from "./pull-request"

function remote(fetchUrl: string, name = "origin"): Remote {
  return { name, fetchUrl, pushUrl: fetchUrl }
}

const origin = [remote("git@github.com:owner/repo.git")]

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
