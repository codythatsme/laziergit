import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, symlinked into the bundled scope the way `main.tsx` loads it. */
const syncExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "sync")

/** Remotes and clones live outside the harness directory, so they are cleaned up here. */
const temporaries: string[] = []

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...gitIsolationEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
  return stdout
}

interface RepoOptions {
  /** Leave HEAD unborn — `git init` with nothing committed. */
  readonly unborn?: boolean
}

/** A harness running the real `sync` Extension over a repository with one commit. */
async function startRepo(options: RepoOptions = {}): Promise<Harness> {
  const harness = await createHarness({ git: true })
  await symlink(syncExtension, join(harness.bundled, "sync"))
  // Several tests move the repository from outside laziergit; the poll is what catches that.
  await writeFile(harness.configFiles.repo, `{ "git": { "refreshIntervalMs": 250 } }`)

  if (options.unborn !== true) {
    await writeFile(join(harness.directory, "seed.txt"), "seed\n")
    await git(harness.directory, "add", "seed.txt")
    await git(harness.directory, "commit", "--quiet", "--message", "first commit")
  }
  return harness
}

/** A bare repository standing in for the remote, with `main` pushed and tracking it. */
async function addOrigin(harness: Harness): Promise<string> {
  const origin = await mkdtemp(join(tmpdir(), "laziergit-sync-remote-"))
  temporaries.push(origin)
  await git(origin, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet")
  await git(harness.directory, "remote", "add", "origin", origin)
  await git(harness.directory, "push", "--quiet", "--set-upstream", "origin", "main")
  return origin
}

/** A second working copy of the remote — how a test makes the remote move behind our back. */
async function cloneOf(origin: string): Promise<string> {
  const clone = await mkdtemp(join(tmpdir(), "laziergit-sync-clone-"))
  temporaries.push(clone)
  await git(clone, "clone", "--quiet", origin, ".")
  return clone
}

async function commitIn(directory: string, file: string, contents: string): Promise<void> {
  await writeFile(join(directory, file), contents)
  await git(directory, "add", "--", file)
  await git(directory, "commit", "--quiet", "--message", `add ${file}`)
}

/** What the user actually reads: the toast text, not the call that produced it. */
function toasts(harness: Harness): readonly string[] {
  return harness.kernel.notifications.getSnapshot().map((toast) => `${toast.level}: ${toast.message}`)
}

/**
 * One keypress, plus enough real time for the terminal parser to disambiguate it. An
 * uppercase letter arrives as the shift stroke the Command bound (`"P"` → `shift+p`).
 */
async function press(harness: Harness, key: string): Promise<void> {
  await act(async () => {
    harness.setup.mockInput.pressKey(key)
    await Bun.sleep(60)
  })
  await settle(harness)
}

/**
 * Renders until the screen (or the toast queue) catches up. Push, pull, and fetch each
 * spawn git, so nothing they produce is available on the render after the keypress.
 */
async function waitFor(harness: Harness, condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await settle(harness)
    if (condition()) return
    await act(async () => {
      await Bun.sleep(25)
    })
  }
  throw new Error(
    `Timed out waiting for ${description}.\nFrame:\n${frame(harness)}\nToasts: ${JSON.stringify(toasts(harness))}`,
  )
}

function waitForToast(harness: Harness, fragment: string): Promise<void> {
  return waitFor(harness, () => toasts(harness).some((toast) => toast.includes(fragment)), `a toast saying ${fragment}`)
}

function waitForFrame(harness: Harness, fragment: string): Promise<void> {
  return waitFor(harness, () => frame(harness).includes(fragment), `${JSON.stringify(fragment)} on screen`)
}

describe("sync.push", () => {
  it("pushes the current branch to its upstream", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await commitIn(harness.directory, "ahead.txt", "one\n")
    await renderApp(harness)

    await press(harness, "P")
    await waitForToast(harness, "Pushed main to origin/main")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(harness.directory, "rev-parse", "main"))
    // The store refreshed with the push, so the segment is already telling the truth.
    expect(frame(harness)).toContain("↑0 ↓0")
  })

  it("confirms before creating an upstream, and tracks it afterwards", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await git(harness.directory, "checkout", "--quiet", "-b", "feature")
    await commitIn(harness.directory, "feature.txt", "work\n")
    await renderApp(harness)

    await press(harness, "P")
    await waitForFrame(harness, "Push feature to origin?")
    expect(frame(harness)).toContain("no upstream")

    await press(harness, "y")
    await waitForToast(harness, "Pushed feature to origin/feature")

    expect(await git(origin, "rev-parse", "feature")).toEqual(await git(harness.directory, "rev-parse", "feature"))
    expect((await git(harness.directory, "rev-parse", "--abbrev-ref", "feature@{upstream}")).trim()).toBe(
      "origin/feature",
    )
  })

  it("leaves the remote alone when the set-upstream confirm is declined", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await git(harness.directory, "checkout", "--quiet", "-b", "feature")
    await commitIn(harness.directory, "feature.txt", "work\n")
    await renderApp(harness)

    await press(harness, "P")
    await waitForFrame(harness, "Push feature to origin?")
    await press(harness, "n")

    expect(await git(origin, "branch", "--list", "feature")).toBe("")
    expect(toasts(harness)).toEqual([])
  })

  it("pushes only the current branch, whatever push.default would have sent", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    // `matching` is git's oldest default and still in plenty of configs: a bare `git push`
    // under it sends every branch whose name exists on the remote, so `other` would travel
    // on the back of a push the user asked for on `main`.
    await git(harness.directory, "config", "push.default", "matching")
    await git(harness.directory, "checkout", "--quiet", "-b", "other")
    await git(harness.directory, "push", "--quiet", "--set-upstream", "origin", "other")
    const otherBefore = await git(origin, "rev-parse", "other")
    await commitIn(harness.directory, "other.txt", "unrelated\n")
    await git(harness.directory, "checkout", "--quiet", "main")
    await commitIn(harness.directory, "ours.txt", "ours\n")
    await renderApp(harness)

    await press(harness, "P")
    await waitForToast(harness, "Pushed main to origin/main")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(harness.directory, "rev-parse", "main"))
    // The toast named one branch, so exactly one branch moved.
    expect(await git(origin, "rev-parse", "other")).toBe(otherBefore)
  })

  it("surfaces git's own rejection and offers a force push that names the cost", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    // The remote gains two commits this repository knows about (its tracking ref moves with
    // the push), so the lease still holds and the force is allowed to land.
    await git(harness.directory, "checkout", "--quiet", "-b", "elsewhere")
    await commitIn(harness.directory, "theirs.txt", "theirs\n")
    await commitIn(harness.directory, "theirs-two.txt", "theirs\n")
    await git(harness.directory, "push", "--quiet", "origin", "elsewhere:main")
    await git(harness.directory, "checkout", "--quiet", "main")
    await commitIn(harness.directory, "ours.txt", "ours\n")
    await renderApp(harness)

    await press(harness, "P")
    await waitForFrame(harness, "Force-push main to origin/main?")
    // git's account of the refusal is on screen underneath the confirm, verbatim.
    expect(toasts(harness).join("\n")).toContain("[rejected]")
    expect(frame(harness)).toContain("--force-with-lease")
    // The number is the fact that decides the answer: the lease will pass here, because
    // these commits were fetched, so nothing else on screen says work is about to be lost.
    expect(frame(harness)).toContain("2 commits on origin/main will be destroyed.")

    await press(harness, "y")
    await waitForToast(harness, "Force-pushed main to origin/main")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(harness.directory, "rev-parse", "main"))
  })

  it("force-pushes only the current branch, whatever push.default would have sent", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await git(harness.directory, "config", "push.default", "matching")
    await git(harness.directory, "checkout", "--quiet", "-b", "other")
    await git(harness.directory, "push", "--quiet", "--set-upstream", "origin", "other")
    const otherBefore = await git(origin, "rev-parse", "other")
    // `other`'s lease holds too — this repository is the one that moved it — so a bare
    // `--force-with-lease` force-updates it alongside the branch the confirm named.
    await commitIn(harness.directory, "other.txt", "unrelated\n")
    await git(harness.directory, "checkout", "--quiet", "main")
    await git(harness.directory, "checkout", "--quiet", "-b", "elsewhere")
    await commitIn(harness.directory, "theirs.txt", "theirs\n")
    await git(harness.directory, "push", "--quiet", "origin", "elsewhere:main")
    await git(harness.directory, "checkout", "--quiet", "main")
    await commitIn(harness.directory, "ours.txt", "ours\n")
    await renderApp(harness)

    await press(harness, "P")
    await waitForFrame(harness, "Force-push main to origin/main?")
    await press(harness, "y")
    await waitForToast(harness, "Force-pushed main to origin/main")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(harness.directory, "rev-parse", "main"))
    expect(await git(origin, "rev-parse", "other")).toBe(otherBefore)
  })

  it("will not offer a force push over commits it has never fetched", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    // Pushed from a second clone, so this repository's `origin/main` still points at the
    // old commit. git says `fetch first` rather than `non-fast-forward`, and the two mean
    // opposite things: nothing here can count what a force would destroy, so it is not
    // offered at all.
    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    await commitIn(harness.directory, "ours.txt", "ours\n")
    await renderApp(harness)

    await press(harness, "P")
    // git's own account lands either way; what is asserted below is what happens next.
    await waitForToast(harness, "[rejected]")

    expect(harness.kernel.popups.top).toBeUndefined()
    expect(toasts(harness).join("\n")).toContain("has commits this repository has never fetched")
    expect(await git(origin, "rev-parse", "main")).toEqual(await git(theirs, "rev-parse", "HEAD"))
  })

  it("never overwrites a remote that moved since the last fetch", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    await commitIn(harness.directory, "ours.txt", "ours\n")
    await renderApp(harness)

    // Reached deliberately from the menu, because the rejection path above refuses to
    // suggest it: the lease is the last line of defence, and it holds.
    await press(harness, "S")
    await waitForFrame(harness, "Sync main")
    await press(harness, "o")
    await waitForFrame(harness, "Force-push main to origin/main?")
    await press(harness, "y")
    await waitForToast(harness, "stale info")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(theirs, "rev-parse", "HEAD"))
  })

  it("refuses on a detached HEAD, naming the commit it is sitting on", async () => {
    const harness = await startRepo()
    await addOrigin(harness)
    await git(harness.directory, "checkout", "--quiet", "--detach")
    await renderApp(harness)

    await press(harness, "P")
    await waitForToast(harness, "Cannot push: HEAD is detached")

    expect(harness.kernel.popups.top).toBeUndefined()
  })

  it("refuses on an unborn HEAD, which has no commit to push", async () => {
    const harness = await startRepo({ unborn: true })
    await renderApp(harness)

    await press(harness, "P")
    await waitForToast(harness, "Cannot push: main has no commits yet")
  })
})

describe("sync.pull and sync.fetch", () => {
  it("pulls the upstream's new commits into the working tree", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    await renderApp(harness)

    await press(harness, "p")
    await waitForToast(harness, "Pulled main")

    expect(await git(harness.directory, "rev-parse", "main")).toEqual(await git(theirs, "rev-parse", "HEAD"))
  })

  it("fetches without merging, and reports the divergence it just found", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    const before = await git(harness.directory, "rev-parse", "main")
    await renderApp(harness)

    await press(harness, "f")
    await waitForToast(harness, "Fetched — ↑0 ↓1")

    expect(await git(harness.directory, "rev-parse", "main")).toBe(before)
    expect(frame(harness)).toContain("↑0 ↓1")
  })

  it("shows git's message when there is no upstream to pull from", async () => {
    const harness = await startRepo()
    await renderApp(harness)

    await press(harness, "p")
    // Not a paraphrase of ours: git explains this better than a pre-check would.
    await waitForToast(harness, "no tracking information")
  })
})

describe("the sync.actions menu", () => {
  it("runs a fetch straight from the menu", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    await renderApp(harness)

    await press(harness, "S")
    await waitForFrame(harness, "Sync main")
    await press(harness, "f")

    await waitForToast(harness, "Fetched — ↑0 ↓1")
  })
})
