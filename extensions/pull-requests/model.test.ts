import { expect, it } from "bun:test"
import type { PullRequestRepository, Remote } from "laziergit"

import {
  formatAge,
  parseAuthoredPullRequests,
  pullRequestQueryArgs,
  pullRequestRepository,
  repositoryArgument,
} from "./model"

function remote(fetchUrl: string, name = "origin"): Remote {
  return { name, fetchUrl, pushUrl: fetchUrl }
}

const repository: PullRequestRepository = { host: "github.example.com", owner: "base", name: "project" }

function response(
  nodes: readonly unknown[],
  viewer = "claudia",
): { readonly data: { readonly viewer: { readonly login: string }; readonly repository: unknown } } {
  return {
    data: {
      viewer: { login: viewer },
      repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
    },
  }
}

function pullRequest(number: number, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.example.com/base/project/pull/${number}`,
    headRefName: `feature/${number}`,
    isDraft: false,
    updatedAt,
    author: { login: "claudia" },
    ...extra,
  }
}

it("chooses upstream before origin for a fork workflow", () => {
  expect(
    pullRequestRepository([
      remote("git@github.com:claudia/project.git"),
      remote("https://github.example.com/base/project.git", "upstream"),
    ]),
  ).toEqual(repository)
})

it("falls back to origin only when upstream is absent", () => {
  expect(pullRequestRepository([remote("/srv/git/project.git")])).toBeNull()
  expect(pullRequestRepository([remote("git@github.com:base/project.git")])).toEqual({
    host: "github.com",
    owner: "base",
    name: "project",
  })
  expect(
    pullRequestRepository([remote("/srv/git/project.git", "upstream"), remote("git@github.com:base/project.git")]),
  ).toBeNull()
})

it("builds an exhaustive, update-ordered GraphQL request for the selected host", () => {
  const args = pullRequestQueryArgs(repository)
  const command = args.join(" ")

  expect(args.slice(0, 6)).toEqual(["api", "graphql", "--paginate", "--slurp", "--hostname", repository.host])
  expect(command).toContain("pullRequests(first: 100, after: $endCursor, states: [OPEN]")
  expect(command).toContain("orderBy: {field: UPDATED_AT, direction: DESC}")
  expect(command).toContain("pageInfo { hasNextPage endCursor }")
  expect(command).toContain("-f owner=base -f repo=project")
  expect(repositoryArgument(repository)).toBe("github.example.com/base/project")
})

it("combines every page, keeps drafts, filters to the viewer, and sorts by update", () => {
  const olderDraft = pullRequest(1, "2026-08-20T01:00:00Z", { isDraft: true })
  const newest = pullRequest(2, "2026-08-23T01:00:00Z")
  const anotherAuthor = pullRequest(3, "2026-08-24T01:00:00Z", { author: { login: "someone-else" } })
  const middle = pullRequest(4, "2026-08-22T01:00:00Z", { author: { login: "CLAUDIA" } })

  const parsed = parseAuthoredPullRequests(
    JSON.stringify([response([olderDraft, anotherAuthor]), response([newest, middle])]),
    repository,
  )

  expect(parsed.map((pullRequest) => pullRequest.number)).toEqual([2, 4, 1])
  expect(parsed[2]?.isDraft).toBe(true)
  expect(parsed.every((pullRequest) => pullRequest.repository === repository)).toBe(true)
})

it("deduplicates a pull request that moved between pages while the query ran", () => {
  const old = pullRequest(7, "2026-08-20T01:00:00Z")
  const fresh = pullRequest(7, "2026-08-24T01:00:00Z", { title: "Fresh title" })
  const parsed = parseAuthoredPullRequests(JSON.stringify([response([old]), response([fresh])]), repository)

  expect(parsed).toHaveLength(1)
  expect(parsed[0]?.title).toBe("Fresh title")
})

it("fails loudly when GitHub omits the viewer or repository connection", () => {
  expect(() => parseAuthoredPullRequests(JSON.stringify([{ data: { viewer: null } }]), repository)).toThrow(
    "GitHub returned an incomplete pull request response",
  )
})

it("formats update ages coarsely and rejects malformed timestamps", () => {
  const now = new Date("2026-08-24T12:00:00Z")
  expect(formatAge("2026-08-24T11:59:55Z", now)).toBe("5s")
  expect(formatAge("2026-08-24T11:57:00Z", now)).toBe("3m")
  expect(formatAge("2026-08-24T10:00:00Z", now)).toBe("2h")
  expect(formatAge("2026-08-20T12:00:00Z", now)).toBe("4d")
  expect(formatAge("not a date", now)).toBeNull()
})
