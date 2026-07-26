import { expect, it } from "bun:test"

import {
  parseBranches,
  parseCommits,
  parseHeadRef,
  parseRemotes,
  parseStash,
  parseStatus,
  parseTags,
  readHead,
} from "./parse"

/** Builds the NUL-terminated stream git emits, so the fixtures below read as records. */
function nulTerminated(...records: readonly string[]): string {
  return records.map((record) => `${record}\0`).join("")
}

// Fixtures that spell a separator inline write `\x00`, never `\0`: several are followed by a digit,
// where `\0` would instead parse as a legacy octal escape. A raw NUL byte is never an option — it
// makes this file binary to git, costing it line diffs and hiding it from grep.

it("reads every porcelain v2 record kind, including a path that is both staged and unstaged", () => {
  const parsed = parseStatus(
    nulTerminated(
      "# branch.oid a7838d82f36266ecad362141e496fae1b0338f60",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -0",
      "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 3e757656 added.txt",
      "1 .M N... 100644 100644 100644 df967b96 df967b96 base.txt",
      "1 MM N... 100644 100644 100644 49f33a8c 4f7858ad both.txt",
      "1 D. N... 100644 000000 000000 abaddc0b 0000000000000000000000000000000000000000 del.txt",
      "1 T. N... 100644 120000 120000 aa80e646 8286e959 type.txt",
      "? untracked.txt",
      "! ignored.txt",
    ),
  )

  expect(parsed.oid).toBe("a7838d82f36266ecad362141e496fae1b0338f60")
  // One entry per path, in path order, each carrying both of git's columns. `both.txt` is
  // the case the four-array model could not express: it appears once, saying `MM`.
  // `ignored.txt` is absent — `!` records are only emitted under --ignored, which we never
  // pass, and they must never be mistaken for a path belonging to the preceding record.
  expect(parsed.files).toEqual([
    { kind: "changed", path: "added.txt", previousPath: null, index: "added", worktree: null },
    { kind: "changed", path: "base.txt", previousPath: null, index: null, worktree: "modified" },
    { kind: "changed", path: "both.txt", previousPath: null, index: "modified", worktree: "modified" },
    { kind: "changed", path: "del.txt", previousPath: null, index: "deleted", worktree: null },
    { kind: "changed", path: "type.txt", previousPath: null, index: "typechange", worktree: null },
    { kind: "changed", path: "untracked.txt", previousPath: null, index: null, worktree: "untracked" },
  ])
})

it("merges the `1 D.` and `?` records git emits for one path into a single entry", () => {
  // `git rm --cached` on a file still on disk: the index is dropping a path the working
  // tree still holds, so git describes it twice. One entry that is both staged and
  // untracked is the honest answer — the four-array model made it two files.
  const parsed = parseStatus(
    nulTerminated(
      "# branch.oid a7838d82",
      "1 D. N... 100644 000000 000000 abaddc0b 0000000000000000000000000000000000000000 tracked.txt",
      "? tracked.txt",
    ),
  )

  expect(parsed.files).toEqual([
    { kind: "changed", path: "tracked.txt", previousPath: null, index: "deleted", worktree: "untracked" },
  ])
})

it("orders entries by path so a directory's rows stay contiguous", () => {
  // `.` (0x2E) sorts before `/` (0x2F), so `b.txt` precedes `b/x.txt`. A tree built over
  // this list depends on it, and the records arrive interleaved by record kind, not path.
  const parsed = parseStatus(
    nulTerminated(
      "# branch.oid a7838d82",
      "? b/x.txt",
      "1 .M N... 100644 100644 100644 df967b96 df967b96 a.txt",
      "? b.txt",
      "1 .M N... 100644 100644 100644 df967b96 df967b96 b/a.txt",
    ),
  )

  expect(parsed.files.map((file) => file.path)).toEqual(["a.txt", "b.txt", "b/a.txt", "b/x.txt"])
})

it("consumes the second NUL field of a rename record, and keeps a path containing spaces whole", () => {
  const parsed = parseStatus(
    nulTerminated(
      "# branch.oid a7838d82",
      "2 RM N... 100644 100644 100644 9d80ddb4 9d80ddb4 R100 dir/renamed spacé.txt",
      "dir/héllo wörld.txt",
      "1 .M N... 100644 100644 100644 df967b96 df967b96 after.txt",
    ),
  )

  expect(parsed.files).toEqual([
    // Proves the cursor advanced past the original path rather than parsing it as a record.
    { kind: "changed", path: "after.txt", previousPath: null, index: null, worktree: "modified" },
    // One entry carries the rename and the later edit together. `previousPath` is a fact
    // about the index — the working tree is measured against the index, where the file
    // already lives under its new name — so it hangs off the entry, not off a side.
    {
      kind: "changed",
      path: "dir/renamed spacé.txt",
      previousPath: "dir/héllo wörld.txt",
      index: "renamed",
      worktree: "modified",
    },
  ])
})

it("reads unmerged records as conflicts, keeping which side did what", () => {
  const parsed = parseStatus(
    nulTerminated(
      "# branch.oid a7838d82",
      "u UU N... 100644 100644 100644 100644 78981922 30305bba a7453f07 conflict.txt",
      "u AA N... 000000 100644 100644 100644 00000000 f719efd4 5626abf0 both-added.txt",
      "u DU N... 100644 000000 100644 100644 78981922 00000000 a7453f07 we-deleted.txt",
    ),
  )

  // The unmerged `XY` is the one place a row's whole meaning is which side did what, so it
  // is carried rather than flattened to a single "conflicted".
  expect(parsed.files).toEqual([
    { kind: "conflicted", path: "both-added.txt", previousPath: null, ours: "added", theirs: "added" },
    { kind: "conflicted", path: "conflict.txt", previousPath: null, ours: "modified", theirs: "modified" },
    { kind: "conflicted", path: "we-deleted.txt", previousPath: null, ours: "deleted", theirs: "modified" },
  ])
})

it("reports an unborn HEAD as no oid at all", () => {
  // git writes the literal `(initial)` where the oid would be; null keeps the "there is no
  // commit" answer out of the same type as "here is the commit".
  expect(parseStatus(nulTerminated("# branch.oid (initial)", "# branch.head main", "? u.txt")).oid).toBeNull()
})

it("trusts symbolic-ref's exit code over the branch name, which may itself be `(detached)`", () => {
  expect(parseHeadRef("main\n", 0)).toBe("main")
  expect(parseHeadRef("", 1)).toBeNull()
  // `git checkout -b '(detached)'` is legal and its status header is byte-identical to a
  // real detached HEAD — only the exit code tells them apart.
  expect(parseHeadRef("(detached)\n", 0)).toBe("(detached)")
})

/** A branch row is the only place an upstream lives, so `readHead` needs one to read from. */
const mainRow = parseBranches(
  ["main", "a83bc136", "origin", "refs/heads/main", "ahead 1", "first", "1784800005"].join("\0"),
  "main",
)

const noChanges = { files: [] }

it("picks HEAD's variant from the oid and the branch together, and reuses the branch row's upstream", () => {
  expect(readHead({ ...noChanges, oid: "a83bc136" }, "main", mainRow)).toEqual({
    kind: "onBranch",
    oid: "a83bc136",
    branch: "main",
    upstream: { remote: "origin", branch: "main", gone: false, ahead: 1, behind: 0 },
  })
  // No commit yet, but HEAD is still a symbolic ref — which is why unborn carries a branch
  // and not an oid. The branch row is ignored: `main` does not exist, so it cannot be here.
  expect(readHead({ ...noChanges, oid: null }, "main", [])).toEqual({
    kind: "unborn",
    branch: "main",
  })
  // Detached: no branch, therefore nothing an upstream could be attached to.
  expect(readHead({ ...noChanges, oid: "a83bc136" }, null, mainRow)).toEqual({
    kind: "detached",
    oid: "a83bc136",
  })
})

it("reads every upstream tracking shape, and separates 'no upstream' from 'in sync'", () => {
  const branches = parseBranches(
    [
      "ahead1\x00d9722771\x00origin\x00refs/heads/ahead1\x00ahead 1\x00x\x001784800009",
      "behindb\x00a83bc136\x00origin\x00refs/heads/behindb\x00behind 2\x00first\x001784800008",
      "diverged\x0020724e12\x00origin\x00refs/heads/other\x00ahead 1, behind 2\x00d2\x001784800007",
      "gonebr\x00a83bc136\x00origin\x00refs/heads/gonebr\x00gone\x00first\x001784800006",
      "main\x00a83bc136\x00origin\x00refs/heads/main\x00\x00first\x001784800005",
      "local\x00b1234567\x00\x00\x00\x00only local\x001784800004",
    ].join("\n"),
    "main",
  )

  expect(branches.map((branch) => branch.upstream)).toEqual([
    // HEAD is moved to the front; the rest keep git's most-recently-committed-first order.
    { remote: "origin", branch: "main", gone: false, ahead: 0, behind: 0 },
    { remote: "origin", branch: "ahead1", gone: false, ahead: 1, behind: 0 },
    { remote: "origin", branch: "behindb", gone: false, ahead: 0, behind: 2 },
    { remote: "origin", branch: "other", gone: false, ahead: 1, behind: 2 },
    // A deleted upstream reports no divergence, so `gone` is all that separates this row
    // from `main` above it.
    { remote: "origin", branch: "gonebr", gone: true, ahead: 0, behind: 0 },
    null,
  ])
  expect(branches.map((branch) => branch.name)).toEqual(["main", "ahead1", "behindb", "diverged", "gonebr", "local"])
  expect(branches.map((branch) => branch.isHead)).toEqual([true, false, false, false, false, false])
  expect(branches[0]?.lastCommit).toEqual({ oid: "a83bc136", subject: "first", authoredAt: 1784800005000 })
})

it("marks no branch as HEAD while detached, where git marks none either", () => {
  const branches = parseBranches("main\x00a83bc136\x00\x00\x00\x00first\x001784800005", null)
  expect(branches.map((branch) => branch.isHead)).toEqual([false])
})

it("prefers a remote's pushurl and falls back to its fetch url", () => {
  expect(
    parseRemotes(
      nulTerminated(
        "remote.origin.url\nssh://git@example.com/repo.git",
        "remote.push.diff.url\nhttps://example.com/fetch.git",
        "remote.push.diff.pushurl\nhttps://example.com/push.git",
        // Only a pushurl is malformed config; inventing an empty fetchUrl would be worse.
        "remote.broken.pushurl\nhttps://example.com/orphan.git",
      ),
    ),
  ).toEqual([
    { name: "origin", fetchUrl: "ssh://git@example.com/repo.git", pushUrl: "ssh://git@example.com/repo.git" },
    // A remote name may itself contain dots, so the last one separates name from setting.
    { name: "push.diff", fetchUrl: "https://example.com/fetch.git", pushUrl: "https://example.com/push.git" },
  ])
})

it("resolves an annotated tag to its commit rather than its tag object", () => {
  // The %(if)%(*objectname) format already peeled it; a lightweight tag has no peel.
  expect(parseTags("annot1\x00a83bc136\nlw1\x0008309ec5")).toEqual([
    { name: "annot1", oid: "a83bc136" },
    { name: "lw1", oid: "08309ec5" },
  ])
})

it("reads commits including a subject containing a newline, a root commit, and a merge", () => {
  const parsed = parseCommits(
    nulTerminated(
      "9162e0c5",
      "9162e0c",
      "1784800073",
      "Ada Løvelace",
      "a@b.c",
      "a83bc136 0d22f310",
      "merge bothab into main",
      "a83bc136",
      "a83bc13",
      "1784800009",
      "Ada Løvelace",
      "a@b.c",
      "",
      // `%s` folds a multi-line first paragraph onto one line and emits `%H` literally.
      "subject with newline and %H",
    ),
  )

  expect(parsed).toEqual([
    {
      oid: "9162e0c5",
      shortOid: "9162e0c",
      subject: "merge bothab into main",
      author: { name: "Ada Løvelace", email: "a@b.c" },
      authoredAt: 1784800073000,
      parents: ["a83bc136", "0d22f310"],
    },
    {
      oid: "a83bc136",
      shortOid: "a83bc13",
      subject: "subject with newline and %H",
      author: { name: "Ada Løvelace", email: "a@b.c" },
      authoredAt: 1784800009000,
      parents: [],
    },
  ])
})

it("splits a stash subject on the branch, not on the first colon in its message", () => {
  const parsed = parseStash(
    nulTerminated(
      "stash@{0}",
      "03baeb9a",
      "1784800114",
      "On main: msg: with colon and WIP on fake",
      "stash@{1}",
      "6acf5650",
      "1784800113",
      "WIP on (no branch): 08309ec subject",
      "stash@{2}",
      "5a317992",
      "1784800112",
      "raw plumbing subject",
    ),
  )

  expect(parsed).toEqual([
    // A branch name cannot contain `:`, so the first `": "` always ends it — a greedy
    // capture would report the branch as `main: msg`.
    { index: 0, oid: "03baeb9a", message: "msg: with colon and WIP on fake", branch: "main", createdAt: 1784800114000 },
    // Stashed while detached: git writes `(no branch)`, and there is no branch to name.
    { index: 1, oid: "6acf5650", message: "08309ec subject", branch: null, createdAt: 1784800113000 },
    // No `On`/`WIP on` prefix: keep the whole subject as the message.
    { index: 2, oid: "5a317992", message: "raw plumbing subject", branch: null, createdAt: 1784800112000 },
  ])
})

it("falls back to list position when the stash selector is not the default shape", () => {
  expect(parseStash(nulTerminated("refs/stash@{0}", "03baeb9a", "1784800114", "On main: x"))[0]?.index).toBe(0)
})
