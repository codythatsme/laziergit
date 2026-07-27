import { describe, expect, it } from "bun:test"

import { describeGitFailure } from "./failure"
import { remoteWebUrl } from "./remote"
import { GitError, type Remote } from "./types"

function remote(fetchUrl: string, name = "origin"): Remote {
  return { name, fetchUrl, pushUrl: fetchUrl }
}

/** The spellings git actually hands back, and what each one is worth as a web page. */
const cases: readonly (readonly [label: string, url: string, expected: string | null])[] = [
  [
    "scp-short, the spelling git prints for most hosts",
    "git@github.com:owner/repo.git",
    "https://github.com/owner/repo",
  ],
  ["scp-short without the .git suffix", "git@github.com:owner/repo", "https://github.com/owner/repo"],
  ["ssh URL with a user", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo"],
  // `:22` is a port in this spelling and a path segment in the scp one.
  ["ssh URL carrying a port", "ssh://git@github.com:22/owner/repo.git", "https://github.com/owner/repo"],
  ["ssh URL with no user at all", "ssh://github.com/owner/repo.git", "https://github.com/owner/repo"],
  ["https", "https://github.com/owner/repo.git", "https://github.com/owner/repo"],
  ["http", "http://example.com/owner/repo", "http://example.com/owner/repo"],
  [
    "a nested path, which some hosts use for groups",
    "git@gitlab.com:group/sub/repo.git",
    "https://gitlab.com/group/sub/repo",
  ],
  // Everything below has no web page, and `null` is what hides the menu item.
  ["a git daemon", "git://example.com/owner/repo.git", null],
  ["a file URL", "file:///srv/git/repo.git", null],
  ["an absolute local path", "/srv/git/repo.git", null],
  ["a sibling clone by relative path", "../other-clone", null],
  // A local path may legitimately contain `@`; it must not be read as user@host.
  ["a local path containing an @", "/Users/ann@work/repo", null],
]

describe("remoteWebUrl", () => {
  for (const [label, url, expected] of cases) {
    it(`maps ${label}`, () => {
      expect(remoteWebUrl([remote(url)])).toBe(expected)
    })
  }

  it("has no page when there are no remotes at all", () => {
    expect(remoteWebUrl([])).toBeNull()
  })

  it("prefers origin over whatever git listed first", () => {
    const remotes = [remote("git@github.com:someone/fork.git", "upstream"), remote("git@github.com:me/repo.git")]
    expect(remoteWebUrl(remotes)).toBe("https://github.com/me/repo")
  })

  it("falls back to the first remote when there is no origin", () => {
    expect(remoteWebUrl([remote("git@github.com:someone/fork.git", "upstream")])).toBe(
      "https://github.com/someone/fork",
    )
  })

  it("tolerates the surrounding whitespace a config value can carry", () => {
    expect(remoteWebUrl([remote("  git@github.com:owner/repo.git  ")])).toBe("https://github.com/owner/repo")
  })
})

describe("describeGitFailure", () => {
  it("gives git's own sentence, which GitError has already read off stderr", () => {
    const error = new GitError(["push"], { stdout: "", stderr: "! [rejected] main -> main\n", exitCode: 1 })
    expect(describeGitFailure(error)).toBe("! [rejected] main -> main")
  })

  it("keeps the line structure a rejected hook prints its complaint across", () => {
    const stderr = "pre-commit hook failed:\n  lint: 3 errors\n  types: 1 error\n"
    const error = new GitError(["commit"], { stdout: "", stderr, exitCode: 1 })
    expect(describeGitFailure(error)).toBe("pre-commit hook failed:\n  lint: 3 errors\n  types: 1 error")
  })

  it("describes the argv when git failed without saying anything", () => {
    const error = new GitError(["stash", "pop"], { stdout: "", stderr: "  \n", exitCode: 1 })
    expect(describeGitFailure(error)).toBe("git stash pop exited with 1")
  })

  it("says so plainly when what failed was not git", () => {
    expect(describeGitFailure(new TypeError("not a function"))).toBe("not a function")
    expect(describeGitFailure("a thrown string")).toBe("a thrown string")
  })
})
