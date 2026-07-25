import { afterEach, expect, it } from "bun:test"
import { chmod, rm } from "node:fs/promises"
import { join } from "node:path"
import { GitError, type GitState, type Head } from "laziergit"

import { defaultGitConfig } from "../config/config"
import { ActivationScope } from "../extension/activation-scope"
import { Diagnostics } from "../extension/diagnostics"
import { GitService } from "./service"
import { addOrigin, createSeededRepo, createTestRepo, registerRepoCleanup } from "./test-repo"

registerRepoCleanup()

const services: GitService[] = []
const reports: string[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.drain()))
  reports.length = 0
})

/** Polls fast enough that the ~2s production default does not become a ~2s test. */
async function open(repoRoot: string, refreshIntervalMs = 250): Promise<GitService> {
  const service = new GitService({
    repoRoot,
    config: { ...defaultGitConfig, refreshIntervalMs },
    report: (message, error) => reports.push(error instanceof Error ? `${message}: ${error.message}` : message),
  })
  services.push(service)
  await service.prime()
  return service
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(15)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function state(service: GitService): GitState {
  return service.getSnapshot()
}

/**
 * Narrows HEAD to the branch-with-commits variant, so a test asserting on an oid or an
 * upstream fails on the wrong variant instead of never compiling.
 */
function onBranch(head: Head): Extract<Head, { kind: "onBranch" }> {
  if (head.kind !== "onBranch") throw new Error(`Expected HEAD on a branch, got "${head.kind}"`)
  return head
}

// ---- reads --------------------------------------------------------------------------

it("loads head, branches, and history from a real repository", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)

  expect(onBranch(state(service).head).branch).toBe("main")
  expect(onBranch(state(service).head).oid).toMatch(/^[0-9a-f]{40}$/)
  expect(state(service).commits.map((commit) => commit.subject)).toEqual(["first commit"])
  expect(state(service).commits[0]?.parents).toEqual([])
  expect(state(service).commits[0]?.author).toEqual({ name: "Test", email: "test@example.com" })
  expect(state(service).branches.map((branch) => branch.name)).toEqual(["main"])
  expect(state(service).branches[0]?.isHead).toBe(true)
  expect(state(service).status.isClean).toBe(true)
  expect(reports).toEqual([])
})

it("reads a repository with no commits without failing on `git log`", async () => {
  const repo = await createTestRepo()
  await repo.write("untracked.txt", "x\n")
  const service = await open(repo.path)

  // git reports `(initial)` where the oid would be, and `git log` exits 128 outright.
  // HEAD is still symbolic here, which is why the unborn variant carries a branch name.
  expect(state(service).head).toEqual({ kind: "unborn", branch: "main" })
  expect(state(service).commits).toEqual([])
  expect(state(service).status.untracked.map((file) => file.path)).toEqual(["untracked.txt"])
  expect(reports).toEqual([])
})

it("reports a detached HEAD even when a branch is literally named `(detached)`", async () => {
  const repo = await createSeededRepo()
  await repo.git("checkout", "--quiet", "--detach")
  const detached = await open(repo.path)
  expect(state(detached).head).toEqual({ kind: "detached", oid: expect.stringMatching(/^[0-9a-f]{40}$/) })
  // No row is HEAD while detached, which is also how git marks it.
  expect(state(detached).branches.every((branch) => !branch.isHead)).toBe(true)

  await repo.git("checkout", "--quiet", "-b", "(detached)")
  const named = await open(repo.path)
  expect(named.getSnapshot().head).toMatchObject({ kind: "onBranch", branch: "(detached)" })
})

it("classifies staged, unstaged, untracked, and renamed paths", async () => {
  const repo = await createSeededRepo()
  // Long enough that git's similarity detection still calls the move below a rename.
  await repo.write("movable.txt", Array.from({ length: 40 }, (_, line) => `line ${line}\n`).join(""))
  await repo.git("add", "movable.txt")
  await repo.commit("add a movable file")

  await repo.write("added.txt", "new\n")
  await repo.write("seed.txt", "seed\nstaged\n")
  await repo.git("add", "added.txt", "seed.txt")
  // Modified again after staging: the same path must appear on both sides.
  await repo.write("seed.txt", "seed\nstaged\nunstaged\n")
  await repo.write("loose.txt", "loose\n")
  await repo.git("mv", "movable.txt", "dir renamed.txt")

  const service = await open(repo.path)
  const status = state(service).status

  expect(status.staged).toContainEqual({ path: "added.txt", previousPath: null, kind: "added" })
  expect(status.staged).toContainEqual({ path: "seed.txt", previousPath: null, kind: "modified" })
  // A `2` record carries its original path in a second NUL field, and the path itself
  // contains a space — neither may be lost.
  expect(status.staged).toContainEqual({
    path: "dir renamed.txt",
    previousPath: "movable.txt",
    kind: "renamed",
  })
  expect(status.unstaged).toContainEqual({ path: "seed.txt", previousPath: null, kind: "modified" })
  expect(status.untracked.map((file) => file.path)).toEqual(["loose.txt"])
  expect(status.isClean).toBe(false)
})

it("records conflicted paths without also staging them", async () => {
  const repo = await createSeededRepo()
  await repo.git("checkout", "--quiet", "-b", "other")
  await repo.write("seed.txt", "theirs\n")
  await repo.git("add", "seed.txt")
  await repo.commit("theirs")
  await repo.git("checkout", "--quiet", "main")
  await repo.write("seed.txt", "ours\n")
  await repo.git("add", "seed.txt")
  await repo.commit("ours")
  // The merge is expected to fail; that failure is the fixture.
  await repo.git("merge", "other").catch(() => undefined)

  const service = await open(repo.path)
  expect(state(service).status.conflicted).toEqual([{ path: "seed.txt", previousPath: null, kind: "conflicted" }])
  expect(state(service).status.staged).toEqual([])
  expect(state(service).status.unstaged).toEqual([])
})

it("tracks divergence from an upstream, and reports a branch with none as null", async () => {
  const repo = await createSeededRepo()
  await addOrigin(repo)
  await repo.write("seed.txt", "ahead\n")
  await repo.git("add", "seed.txt")
  await repo.commit("ahead by one")
  await repo.git("checkout", "--quiet", "-b", "local-only")

  const service = await open(repo.path)
  const main = state(service).branches.find((branch) => branch.name === "main")
  expect(main?.upstream).toEqual({ remote: "origin", branch: "main", gone: false, ahead: 1, behind: 0 })
  expect(state(service).branches.find((branch) => branch.name === "local-only")?.upstream).toBeNull()
  // HEAD's upstream is the same object the branch row carries, so the two can never disagree.
  expect(onBranch(state(service).head).upstream).toBe(
    state(service).branches.find((branch) => branch.isHead)?.upstream ?? null,
  )
})

it("tells an unborn HEAD apart from the branch it used to be indistinguishable from", async () => {
  const unborn = state(await open((await createTestRepo()).path)).head
  const born = state(await open((await createSeededRepo()).path)).head

  // Both are on `main`, and the old encoding said so identically — same shape, same
  // `detached: false`, an oid of `""` that a consumer could still hand to git. The variant
  // is now the difference, and there is no oid on the unborn one to misread.
  expect(unborn).toEqual({ kind: "unborn", branch: "main" })
  expect("oid" in unborn).toBe(false)
  expect(born.kind).toBe("onBranch")
  expect(onBranch(born).oid).toMatch(/^[0-9a-f]{40}$/)
})

it("tells an upstream deleted on the remote apart from one that is in sync", async () => {
  const repo = await createSeededRepo()
  await addOrigin(repo)
  await repo.git("checkout", "--quiet", "-b", "feature")
  await repo.git("push", "--quiet", "--set-upstream", "origin", "feature")
  await repo.git("push", "--quiet", "origin", "--delete", "feature")
  await repo.git("fetch", "--quiet", "--prune")

  const service = await open(repo.path)
  const upstreamOf = (name: string) => state(service).branches.find((branch) => branch.name === name)?.upstream

  // git reports `gone` instead of a divergence, so both branches read as zero ahead and
  // zero behind — `gone` is the entire difference between "the remote deleted this" and
  // "nothing to do", which is the distinction a branches Pane most needs to draw.
  expect(upstreamOf("feature")).toEqual({ remote: "origin", branch: "feature", gone: true, ahead: 0, behind: 0 })
  expect(upstreamOf("main")).toEqual({ remote: "origin", branch: "main", gone: false, ahead: 0, behind: 0 })
})

it("resolves an annotated tag to its commit, and reads remotes and stashes", async () => {
  const repo = await createSeededRepo()
  await repo.git("tag", "--annotate", "annotated", "--message", "released")
  await repo.git("tag", "lightweight")
  await repo.git("remote", "add", "origin", "https://example.com/fetch.git")
  await repo.git("remote", "set-url", "--push", "origin", "https://example.com/push.git")
  await repo.write("seed.txt", "stashed\n")
  await repo.git("stash", "push", "--message", "work: in progress")

  const service = await open(repo.path)
  const head = onBranch(state(service).head).oid

  // An annotated tag's own oid is the tag object; every consumer wants the commit.
  expect(state(service).tags).toEqual(
    expect.arrayContaining([
      { name: "annotated", oid: head },
      { name: "lightweight", oid: head },
    ]),
  )
  expect(state(service).remotes).toEqual([
    { name: "origin", fetchUrl: "https://example.com/fetch.git", pushUrl: "https://example.com/push.git" },
  ])
  expect(state(service).stash).toEqual([
    expect.objectContaining({ index: 0, branch: "main", message: "work: in progress" }),
  ])
})

// ---- writes -------------------------------------------------------------------------

it("stages, commits, and refreshes before the caller's await resolves", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("feature.txt", "feature\n")

  await service.stage(["feature.txt"])
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["feature.txt"])

  await service.commit("add the feature")
  // The store is already current when the write resolves; no extra refresh is needed.
  expect(state(service).commits.map((commit) => commit.subject)).toEqual(["add the feature", "first commit"])
  expect(state(service).status.isClean).toBe(true)
})

it("runs the branch and stash porcelain", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)

  await service.createBranch("feature", { checkout: true })
  expect(onBranch(state(service).head).branch).toBe("feature")

  await service.checkout("main")
  expect(onBranch(state(service).head).branch).toBe("main")

  await service.deleteBranch("feature")
  expect(state(service).branches.map((branch) => branch.name)).toEqual(["main"])

  await repo.write("seed.txt", "changed\n")
  await service.stash.save({ message: "parked" })
  expect(state(service).status.isClean).toBe(true)
  expect(state(service).stash).toHaveLength(1)

  await service.stash.pop()
  expect(state(service).stash).toEqual([])
  expect(state(service).status.unstaged.map((file) => file.path)).toEqual(["seed.txt"])
})

it("republishes after a write that failed, because a failed write still moved the repository", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("seed.txt", "stashed\n")
  await service.stash.save({ message: "parked" })
  // A commit on the same line, so the pop below conflicts instead of applying cleanly.
  await repo.write("seed.txt", "committed\n")
  await repo.git("add", "seed.txt")
  await repo.commit("conflicting edit")

  const failure = await service.stash.pop().catch((error: unknown) => error)
  if (!(failure instanceof GitError)) throw new Error(`Expected a GitError, got ${String(failure)}`)

  // The pop rejected, but it wrote conflict markers and recorded the conflict on the way
  // out. Refreshing on the success channel alone would leave the store reporting a clean
  // tree over a repository mid-conflict.
  expect(state(service).status.conflicted.map((file) => file.path)).toEqual(["seed.txt"])
  expect(state(service).status.isClean).toBe(false)
})

it("discards both tracked edits and untracked files", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("seed.txt", "edited\n")
  await repo.write("loose.txt", "loose\n")
  await service.refresh()
  expect(state(service).status.isClean).toBe(false)

  // `git restore` alone would leave every untracked path in place.
  await service.discard(["seed.txt", "loose.txt"])
  expect(state(service).status.isClean).toBe(true)
})

it("unstages everything without touching the working tree", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("added.txt", "x\n")
  await service.stage("all")
  expect(state(service).status.staged).toHaveLength(1)

  await service.unstage("all")
  expect(state(service).status.staged).toEqual([])
  expect(state(service).status.untracked.map((file) => file.path)).toEqual(["added.txt"])
})

it("unstages on a repository that has no commits yet", async () => {
  const repo = await createTestRepo()
  const service = await open(repo.path)
  await repo.write("first.txt", "x\n")

  await service.stage("all")
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["first.txt"])

  // There is no HEAD to restore from here, which is exactly where `git restore --staged` fails.
  await service.unstage("all")
  expect(state(service).status.staged).toEqual([])
  expect(state(service).status.untracked.map((file) => file.path)).toEqual(["first.txt"])
})

it("treats an empty selection as unstaging nothing, not everything", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("staged.txt", "x\n")
  await service.stage("all")
  expect(state(service).status.staged).toHaveLength(1)

  // A pathspec-less `git reset --` is a mixed reset of the whole index; an empty
  // multi-select in a Bundled Extension must never reach it.
  await service.unstage([])
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["staged.txt"])
  await service.discard([])
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["staged.txt"])
})

it("creates a branch whose name begins with a dash without reading it as an option", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)

  // Without `--`, git would take `-weird` as an option and `main` as the branch to create.
  await service.createBranch("-weird", { at: "main" }).catch(() => undefined)
  expect(state(service).branches.map((branch) => branch.name)).not.toContain("main-duplicate")
  expect(state(service).branches.filter((branch) => branch.name === "main")).toHaveLength(1)
})

it("names a branch that shares its name with a tag as the branch, not a disambiguated ref", async () => {
  const repo = await createSeededRepo()
  await repo.git("branch", "dup")
  await repo.git("tag", "dup")
  const service = await open(repo.path)

  // `%(refname:short)` would report `heads/dup` here, which git will not accept back.
  expect(state(service).branches.map((branch) => branch.name)).toContain("dup")
  expect(state(service).tags.map((tag) => tag.name)).toContain("dup")

  await service.deleteBranch("dup", { force: true })
  expect(state(service).branches.map((branch) => branch.name)).not.toContain("dup")
})

it("removes an untracked directory that contains its own repository", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.git("init", "--quiet", "nested")
  await repo.write("nested/file.txt", "x\n")
  await service.refresh()

  // A single `-f` makes clean refuse to descend into it, exiting 0 having done nothing.
  await service.discard(["nested/"])
  expect(await Bun.file(`${repo.path}/nested/file.txt`).exists()).toBe(false)
})

it("pushes to a remote and clears the divergence it reported", async () => {
  const repo = await createSeededRepo()
  await addOrigin(repo)
  await repo.write("seed.txt", "ahead\n")
  await repo.git("add", "seed.txt")
  await repo.commit("ahead by one")

  const service = await open(repo.path)
  expect(onBranch(state(service).head).upstream?.ahead).toBe(1)

  await service.push()
  expect(onBranch(state(service).head).upstream).toEqual({
    remote: "origin",
    branch: "main",
    gone: false,
    ahead: 0,
    behind: 0,
  })
})

it("pushes a named ref to its own remote rather than to a remote of that name", async () => {
  const repo = await createSeededRepo()
  await addOrigin(repo)
  await repo.git("checkout", "--quiet", "-b", "feature")
  await repo.write("seed.txt", "feature\n")
  await repo.git("add", "seed.txt")
  await repo.commit("feature work")
  const service = await open(repo.path)

  // git's first positional operand is the repository, so a bare `git push feature` would
  // fail with "'feature' does not appear to be a git repository".
  await service.push({ ref: "feature", setUpstream: true })
  expect(state(service).branches.find((branch) => branch.name === "feature")?.upstream).toEqual({
    remote: "origin",
    branch: "feature",
    gone: false,
    ahead: 0,
    behind: 0,
  })
})

// ---- raw ----------------------------------------------------------------------------

it("refreshes after a mutating raw invocation and not after a read", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  let publishes = 0
  service.store.onPublish(() => {
    publishes += 1
  })

  await service.raw(["log", "--oneline"])
  expect(publishes).toBe(0)

  await repo.write("seed.txt", "raw\n")
  await service.raw(["add", "seed.txt"])
  // `add` is not on the read-only list, so the store is re-read — and it really changed.
  expect(publishes).toBe(1)
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["seed.txt"])
})

it("classifies a read that is only a read in combination, and one behind a global option", async () => {
  const repo = await createSeededRepo()
  await repo.write("seed.txt", "stashed\n")
  await repo.git("stash", "push", "--message", "parked")
  const service = await open(repo.path)
  let publishes = 0
  service.store.onPublish(() => {
    publishes += 1
  })

  // The stash-preview pane in the API docs runs this on every cursor move.
  await service.raw(["stash", "show", "-p", "stash@{0}"])
  await service.raw(["stash", "list"])
  // `-c` consumes the next argument, which is therefore not the subcommand.
  await service.raw(["-c", "core.abbrev=12", "log", "--oneline"])
  expect(publishes).toBe(0)

  await service.raw(["stash", "apply"])
  expect(publishes).toBe(1)
})

it("resolves a write's own refresh against reads taken after the write", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  // Hold a refresh open so the write below lands mid-pass, where a coalescing bug would
  // hand it the in-flight pass whose reads predate it.
  const inFlight = service.refresh()
  await repo.write("late.txt", "late\n")
  await service.stage(["late.txt"])

  expect(state(service).status.staged.map((file) => file.path)).toEqual(["late.txt"])
  await inFlight
})

it("fails a raw invocation with the exit code and stderr git reported", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)

  const failure = await service.raw(["checkout", "no-such-branch"]).catch((error: unknown) => error)
  if (!(failure instanceof GitError)) throw new Error(`Expected a GitError, got ${String(failure)}`)
  expect(failure.exitCode).not.toBe(0)
  expect(failure.args).toEqual(["checkout", "no-such-branch"])

  // allowFailure turns the same invocation into an ordinary result to inspect.
  const tolerated = await service.raw(["checkout", "no-such-branch"], { allowFailure: true })
  expect(tolerated.exitCode).not.toBe(0)
  expect(tolerated.stderr).not.toBe("")
})

it("passes stdin through to git", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)

  const output = await service.raw(["hash-object", "-w", "--stdin"], { stdin: "hello\n" })
  expect(output.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
  expect((await service.raw(["cat-file", "-p", output.stdout.trim()])).stdout).toBe("hello\n")
})

// ---- outside a repository -------------------------------------------------------------

it("serves an empty snapshot outside a repository and fails writes with a clear reason", async () => {
  const repo = await createTestRepo()
  await rm(`${repo.path}/.git`, { recursive: true, force: true })
  const service = await open(repo.path)

  expect(service.available).toBe(false)
  // Its own variant, not an unborn HEAD with a nameless branch: nothing here is a fact
  // about HEAD, because nothing answered (see `emptyGitState`).
  expect(state(service).head).toEqual({ kind: "noRepository" })
  expect(state(service).status.isClean).toBe(true)
  // Not diagnosed: running outside a repository is a supported mode, not a failure.
  expect(reports).toEqual([])

  const failure = await service.commit("nope").catch((error: unknown) => error)
  if (!(failure instanceof GitError)) throw new Error(`Expected a GitError, got ${String(failure)}`)
  expect(failure.message).toContain("not a git repository")
})

it("refuses to bind to an enclosing repository", async () => {
  const repo = await createSeededRepo()
  // A plain `git rev-parse` here would walk up and silently adopt the parent repository.
  await Bun.write(`${repo.path}/nested/keep.txt`, "x\n")
  const service = await open(`${repo.path}/nested`)

  expect(service.available).toBe(false)
})

// ---- reactivity ------------------------------------------------------------------------

it("publishes only the slices that changed, and keeps the rest referentially stable", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  const before = state(service)

  await repo.write("loose.txt", "loose\n")
  await service.refresh()
  const after = state(service)

  expect(after.status).not.toBe(before.status)
  expect(after.branches).toBe(before.branches)
  expect(after.commits).toBe(before.commits)
  expect(after.head).toBe(before.head)
})

it("notifies React subscribers only when the snapshot actually moved", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  let notifications = 0
  service.subscribe(() => {
    notifications += 1
  })

  await service.refresh()
  expect(notifications).toBe(0)

  await repo.write("loose.txt", "loose\n")
  await service.refresh()
  expect(notifications).toBe(1)
})

it("fires a selector subscription only on a change to the selected value", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  const branches: (string | null)[] = []
  const subscription = service.subscribeSelector(
    (snapshot) => (snapshot.head.kind === "onBranch" || snapshot.head.kind === "unborn" ? snapshot.head.branch : null),
    (value) => branches.push(value),
  )

  await repo.write("loose.txt", "loose\n")
  await service.refresh()
  expect(branches).toEqual([])

  await service.createBranch("feature", { checkout: true })
  expect(branches).toEqual(["feature"])

  subscription.dispose()
  await service.checkout("main")
  expect(branches).toEqual(["feature"])
})

// ---- the M3 gate -------------------------------------------------------------------

it("tracks a commit made outside laziergit within one poll interval", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path, 250)
  service.start()
  expect(state(service).commits).toHaveLength(1)

  // Exactly what the gate describes: git run in another terminal.
  await repo.write("external.txt", "external\n")
  await repo.git("add", "external.txt")
  await repo.commit("committed elsewhere")

  await waitFor(() => state(service).commits.length === 2, "the external commit to appear")
  expect(state(service).commits[0]?.subject).toBe("committed elsewhere")
  expect(state(service).status.isClean).toBe(true)
})

it("tracks a branch switch and a bare working-tree edit made outside laziergit", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path, 250)
  service.start()

  await repo.git("checkout", "--quiet", "-b", "elsewhere")
  await waitFor(() => onBranch(state(service).head).branch === "elsewhere", "the external checkout to appear")

  // Nothing under .git moves when a file is edited, so a refs-only fingerprint would
  // never notice this — the poll reads the working tree status too.
  await repo.write("seed.txt", "edited outside\n")
  await waitFor(() => !state(service).status.isClean, "the external edit to appear")
  expect(state(service).status.unstaged.map((file) => file.path)).toEqual(["seed.txt"])
})

it("tracks a stash dropped from the middle of the list, which moves no ref", async () => {
  const repo = await createSeededRepo()
  for (const message of ["one", "two", "three"]) {
    await repo.write("seed.txt", `${message}\n`)
    await repo.git("stash", "push", "--message", message)
  }
  const service = await open(repo.path, 250)
  service.start()
  expect(state(service).stash).toHaveLength(3)

  // Dropping anything but the top entry rewrites only the stash reflog, so `refs/stash`
  // and the whole refs snapshot stay byte-identical.
  await repo.git("stash", "drop", "stash@{1}")
  await waitFor(() => state(service).stash.length === 2, "the dropped stash to disappear")
  expect(state(service).stash.map((entry) => entry.message)).toEqual(["three", "one"])
})

it("tracks a remote added outside laziergit, which touches no ref and no file", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path, 250)
  service.start()
  expect(state(service).remotes).toEqual([])

  // Purely a config edit: invisible to both the status and the refs half of the fingerprint.
  await repo.git("remote", "add", "origin", "https://example.com/repo.git")
  await waitFor(() => state(service).remotes.length === 1, "the new remote to appear")
  expect(state(service).remotes[0]?.name).toBe("origin")
})

it("stays quiet while the repository is untouched", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path, 250)
  let publishes = 0
  service.start()
  service.store.onPublish(() => {
    publishes += 1
  })

  await Bun.sleep(900)
  // The poll reads, finds the same fingerprint, and publishes nothing — no re-render per tick.
  expect(publishes).toBe(0)
  expect(reports).toEqual([])
})

// ---- configuration ---------------------------------------------------------------------

it("re-reads history when the commit window changes, and not when nothing did", async () => {
  const repo = await createSeededRepo()
  await repo.write("seed.txt", "second\n")
  await repo.git("add", "seed.txt")
  await repo.commit("second commit")

  const service = await open(repo.path)
  let publishes = 0
  service.store.onPublish(() => {
    publishes += 1
  })

  service.setConfig({ ...defaultGitConfig, commitLimit: 1 })
  await waitFor(() => state(service).commits.length === 1, "history to be re-read at the new window")
  expect(publishes).toBe(1)

  service.setConfig({ ...defaultGitConfig, commitLimit: 1 })
  await Bun.sleep(120)
  // Applying the same settings must not republish, or every pane re-renders on any config edit.
  expect(publishes).toBe(1)
})

it("waits for an in-flight write before shutting down", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("late.txt", "late\n")

  const write = service.stage(["late.txt"])
  await service.drain()
  await write

  // Drain is what keeps a `git commit` from being cut off by the process exiting.
  expect(await new Response(Bun.spawn(["git", "status", "--porcelain"], { cwd: repo.path }).stdout).text()).toContain(
    "A  late.txt",
  )
})

// ---- the Effect face -----------------------------------------------------------------

it("runs an Effect-face write to completion when the extension deactivates mid-flight", async () => {
  const repo = await createSeededRepo()
  // A hook slow enough that the scope closes while git is still working.
  await repo.write(".git/hooks/pre-commit", "#!/bin/sh\nsleep 1\n")
  await chmod(join(repo.path, ".git/hooks/pre-commit"), 0o755)
  const service = await open(repo.path)
  await repo.write("late.txt", "late\n")
  await service.stage(["late.txt"])

  const scope = new ActivationScope("effect-writer", new Diagnostics())
  let settled = false
  void scope
    .runEffect(service.rawEffect(["commit", "--message", "from the effect face"]))
    .then(() => {
      settled = true
    })
    .catch(() => {
      settled = true
    })

  await Bun.sleep(200)
  await scope.close("reload")
  await Bun.sleep(1500)

  // Repo integrity beats promise tidiness: the write finishes, only its notification is
  // dropped. The Promise face guarantees the same thing by never passing a cancel callback.
  const log = await repo.git("log", "--oneline")
  expect(log).toContain("from the effect face")
  expect(settled).toBe(false)
})

it("does not run an Effect-face read to completion after deactivation", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  const scope = new ActivationScope("effect-reader", new Diagnostics())

  let settled = false
  void scope
    .runEffect(service.rawEffect(["log", "--oneline"]))
    .then(() => {
      settled = true
    })
    .catch(() => {
      settled = true
    })
  await scope.close("reload")
  await Bun.sleep(200)

  // Reads carry no integrity risk, so they are interrupted like any other scoped work —
  // and either way the promise is parked rather than resumed on a stale ctx.
  expect(settled).toBe(false)
})

// ---- lock contention ---------------------------------------------------------------

it("retries a write that lost a race for index.lock", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("locked.txt", "locked\n")
  await Bun.write(`${repo.path}/.git/index.lock`, "")

  const staged = service.stage(["locked.txt"])
  // Released well inside the ~1.26s retry budget, so the write should still land.
  setTimeout(() => void rm(`${repo.path}/.git/index.lock`, { force: true }), 120)

  await staged
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["locked.txt"])
})

it("does not retry a command that merely printed `index.lock` on its stdout", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  await repo.write("notes.txt", "the lock lives at .git/index.lock\n")
  await repo.write("other.txt", "no lock here\n")

  // What the diff Pane runs for an untracked file: always a nonzero exit, with the file's
  // own bytes on stdout. Retrying it would cost the whole ~1.26s budget and seven spawns.
  const started = Date.now()
  const output = await service.raw(["diff", "--no-index", "--", "notes.txt", "other.txt"], { allowFailure: true })
  expect(output.stdout).toContain("index.lock")
  expect(output.exitCode).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(1000)
})

it("never runs git through a shell, so a hostile path is only ever a path", async () => {
  const repo = await createSeededRepo()
  const service = await open(repo.path)
  // Every one of these is a legal filename and shell syntax at the same time.
  const hostile = "; touch pwned; echo $(id) `whoami`.txt"
  await repo.write(hostile, "harmless\n")

  await service.stage([hostile])
  expect(state(service).status.staged.map((file) => file.path)).toEqual([hostile])
  // argv arrays, never a shell string: the metacharacters were data the whole way down.
  expect(await Bun.file(`${repo.path}/pwned`).exists()).toBe(false)
})

/**
 * The other half of the shell test above: git needs no shell to expand a name, because
 * every path it takes is a *pathspec* and a pathspec is a glob. `foo[1].txt` matches
 * `foo1.txt` too, and `--` does not change that.
 */
it("stages only the bracketed path it was given, not the neighbour that path globs to", async () => {
  const repo = await createSeededRepo()
  await repo.write("foo[1].txt", "bracket\n")
  await repo.write("foo1.txt", "one\n")
  await repo.git("add", "--", ":(literal)foo[1].txt", ":(literal)foo1.txt")
  await repo.commit("both files")

  const service = await open(repo.path)
  await repo.write("foo[1].txt", "bracket edited\n")
  await repo.write("foo1.txt", "one edited\n")
  await service.refresh()

  await service.stage(["foo[1].txt"])
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["foo[1].txt"])
  expect(state(service).status.unstaged.map((file) => file.path)).toEqual(["foo1.txt"])

  // Unstaging the same one path must leave the neighbour's staged state alone too.
  await service.stage(["foo1.txt"])
  await service.unstage(["foo[1].txt"])
  expect(state(service).status.staged.map((file) => file.path)).toEqual(["foo1.txt"])
})

it("discards only the bracketed path it was given, and cleans only the file it named", async () => {
  const repo = await createSeededRepo()
  await repo.write("foo[1].txt", "bracket\n")
  await repo.write("foo1.txt", "one\n")
  await repo.git("add", "--", ":(literal)foo[1].txt", ":(literal)foo1.txt")
  await repo.commit("both files")

  const service = await open(repo.path)
  await repo.write("foo[1].txt", "bracket edited\n")
  await repo.write("foo1.txt", "one edited\n")
  await repo.write("bar[1].txt", "bracket untracked\n")
  await repo.write("bar1.txt", "one untracked\n")
  await service.refresh()

  // One tracked path and one untracked one, so both halves of `discard` are exercised:
  // `git restore --worktree` on the first, `git clean -ffd` on the second.
  await service.discard(["foo[1].txt", "bar[1].txt"])

  // The neighbour's edits survive...
  expect(await Bun.file(join(repo.path, "foo1.txt")).text()).toBe("one edited\n")
  // ...and the untracked neighbour is still there. A confirm dialog named one file.
  expect(await Bun.file(join(repo.path, "bar1.txt")).exists()).toBe(true)
  expect(await Bun.file(join(repo.path, "foo[1].txt")).text()).toBe("bracket\n")
  expect(await Bun.file(join(repo.path, "bar[1].txt")).exists()).toBe(false)
})
