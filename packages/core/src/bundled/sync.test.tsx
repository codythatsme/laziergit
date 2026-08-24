import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  refreshGit,
  renderApp,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

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
  /** Most Command tests isolate themselves from the Extension's startup/periodic fetch. */
  readonly autoFetch?: boolean
  readonly fetchIntervalMs?: number
}

/** A harness running the real `sync` Extension over a repository with one commit. */
async function startRepo(options: RepoOptions = {}): Promise<Harness> {
  const harness = await createHarness({ git: true })
  await symlink(syncExtension, join(harness.bundled, "sync"))
  // Mutations made from outside laziergit reach the store through `refreshGit`, so the
  // fingerprint poll is parked out of every test's way.
  await writeFile(
    harness.configFiles.repo,
    JSON.stringify({
      git: { refreshIntervalMs: 60000 },
      extensions: {
        sync: {
          autoFetch: options.autoFetch ?? false,
          fetchIntervalMs: options.fetchIntervalMs ?? 60000,
        },
      },
    }),
  )

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
 * Push, pull, and fetch each spawn git, so nothing they produce is available on the render
 * after the keypress; the toast queue is where their outcomes land. An uppercase letter
 * arrives as the shift stroke the Command bound (`"P"` → `shift+p`).
 */
function waitForToast(harness: Harness, fragment: string): Promise<void> {
  return waitFor(harness, () => toasts(harness).some((toast) => toast.includes(fragment)), `a toast saying ${fragment}`)
}

describe("sync.push", () => {
  it("pushes the current branch to its upstream", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await commitIn(harness.directory, "ahead.txt", "one\n")
    await renderApp(harness)

    // One commit ahead, and the segment says so before anything is pushed.
    await waitForFrame(harness, "↑1")

    await press(harness, "P")
    await waitForToast(harness, "Pushed main to origin/main")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(harness.directory, "rev-parse", "main"))
    // The store refreshed with the push, and an in-sync branch reports nothing rather than
    // `↑0 ↓0`.
    expect(frame(harness)).not.toContain("↑")
  })

  it("confirms before creating an upstream, and tracks it afterwards", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await git(harness.directory, "checkout", "--quiet", "-b", "feature")
    await commitIn(harness.directory, "feature.txt", "work\n")
    await renderApp(harness)

    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).toContain("sync.push-upstream")
    expect(commands).not.toContain("sync.push")
    await press(harness, "u")
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

    await press(harness, "u")
    await waitForFrame(harness, "Push feature to origin?")
    await press(harness, "n")
    await waitForFrame(harness, (screen) => !screen.includes("Push feature to origin?"))

    expect(await git(origin, "branch", "--list", "feature")).toBe("")
    expect(toasts(harness)).toEqual([])
  })

  it("pushes only the current branch, whatever push.default would have sent", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    // Under `matching`, git's oldest default, a bare `git push` sends every branch whose name
    // exists on the remote — so `other` would travel on the back of a push asked for on `main`.
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

  it("offers a known force push immediately without waiting for git to reject a normal push", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await commitIn(harness.directory, "discarded.txt", "discarded\n")
    await git(harness.directory, "push", "--quiet", "origin", "main")
    await git(harness.directory, "reset", "--hard", "HEAD^")
    await renderApp(harness)

    await waitForFrame(harness, "↓1")
    await press(harness, "P")
    await waitForFrame(harness, "Force-push main to origin/main?")
    expect(toasts(harness)).toEqual([])
    expect(frame(harness)).toContain("--force-with-lease")
    expect(frame(harness)).toContain("1 commit on origin/main will be destroyed.")

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
    // Pushed from a second clone, so this repository's `origin/main` still points at the old
    // commit. git says `fetch first` rather than `non-fast-forward`: nothing here can count
    // what a force would destroy, so it is not offered at all.
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

    // Force-with-lease remains a direct Command even when the safer push rejected first.
    await press(harness, "o")
    await waitForFrame(harness, "Force-push main to origin/main?")
    await press(harness, "y")
    await waitForToast(harness, "stale info")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(theirs, "rev-parse", "HEAD"))
  })

  it("pins the lease to the remote tip named by the warning", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await commitIn(harness.directory, "discarded.txt", "discarded\n")
    await git(harness.directory, "push", "--quiet", "origin", "main")
    await git(harness.directory, "reset", "--hard", "HEAD^")
    const theirs = await cloneOf(origin)
    await renderApp(harness)

    await waitForFrame(harness, "↓1")
    await press(harness, "P")
    await waitForFrame(harness, "1 commit on origin/main will be destroyed.")

    await commitIn(theirs, "new-after-warning.txt", "new\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    await act(async () => harness.kernel.git.raw(["fetch", "--all", "--no-write-fetch-head"]))

    await press(harness, "y")
    await waitForToast(harness, "stale info")

    expect(await git(origin, "rev-parse", "main")).toEqual(await git(theirs, "rev-parse", "HEAD"))
  })

  it("does not publish push or pull on a detached HEAD", async () => {
    const harness = await startRepo()
    await addOrigin(harness)
    await git(harness.directory, "checkout", "--quiet", "--detach")
    await renderApp(harness)

    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).not.toContain("sync.push")
    expect(commands).not.toContain("sync.push-upstream")
    expect(commands).not.toContain("sync.pull")
    await press(harness, "P")
    expect(toasts(harness)).toEqual([])
    expect(harness.kernel.popups.top).toBeUndefined()
  })

  it("does not publish push or pull on an unborn HEAD", async () => {
    const harness = await startRepo({ unborn: true })
    await renderApp(harness)

    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).not.toContain("sync.push")
    expect(commands).not.toContain("sync.push-upstream")
    expect(commands).not.toContain("sync.pull")
    await press(harness, "P")
    expect(toasts(harness)).toEqual([])
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
    // The segment's own composition: branch, then only the non-zero counts.
    expect(frame(harness)).toContain("main ↓1")
  })

  it("queues a pull pressed while an automatic fetch is still running", async () => {
    const harness = await startRepo({ autoFetch: true })
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    const before = await git(harness.directory, "rev-parse", "main")

    const fetchStarted = Promise.withResolvers<void>()
    const releaseFetch = Promise.withResolvers<void>()
    const realRaw = harness.kernel.git.raw.bind(harness.kernel.git)
    spyOn(harness.kernel.git, "raw").mockImplementation(async (args, options) => {
      if (args.includes("--no-write-fetch-head")) {
        fetchStarted.resolve()
        await releaseFetch.promise
      }
      return realRaw(args, options)
    })
    await renderApp(harness)

    const pullSettled = Promise.withResolvers<void>()
    const unsubscribe = harness.kernel.notifications.subscribe(() => {
      if (toasts(harness).some((toast) => toast.includes("Pulled main") || toast.startsWith("error:"))) {
        pullSettled.resolve()
      }
    })

    try {
      await fetchStarted.promise
      await press(harness, "p")

      expect(toasts(harness).join("\n")).not.toContain("try again when it finishes")
      expect(await git(harness.directory, "rev-parse", "main")).toBe(before)
    } finally {
      await act(async () => {
        releaseFetch.resolve()
        // Keep React's test boundary open through the fetch refresh, queued pull, and toast.
        await pullSettled.promise
      })
      unsubscribe()
    }

    expect(toasts(harness).join("\n")).toContain("Pulled main")
    expect(await git(harness.directory, "rev-parse", "main")).toEqual(await git(theirs, "rev-parse", "HEAD"))
  })

  it("automatically discovers remote commits while the app is open", async () => {
    const harness = await startRepo({ autoFetch: true, fetchIntervalMs: 250 })
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    const releaseScheduledFetch = Promise.withResolvers<void>()
    const discoveredSecondCommit = Promise.withResolvers<void>()
    const realRaw = harness.kernel.git.raw.bind(harness.kernel.git)
    let automaticFetches = 0
    spyOn(harness.kernel.git, "raw").mockImplementation(async (args, options) => {
      if (args.includes("--no-write-fetch-head")) {
        automaticFetches += 1
        if (automaticFetches === 2) await releaseScheduledFetch.promise
      }
      const output = await realRaw(args, options)
      const head = harness.kernel.git.getSnapshot().head
      if (args.includes("--no-write-fetch-head") && head.kind === "onBranch" && head.upstream?.behind === 2) {
        discoveredSecondCommit.resolve()
      }
      return output
    })

    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    await commitIn(theirs, "more.txt", "more\n")
    await renderApp(harness)

    // lazygit fetches once at startup rather than leaving the first interval stale.
    await waitForFrame(harness, "main ↓1")

    await git(theirs, "push", "--quiet", "origin", "main")

    // The next scheduled fetch discovers movement that happened after startup.
    await act(async () => {
      releaseScheduledFetch.resolve()
      await discoveredSecondCommit.promise
    })
    await waitForFrame(harness, "main ↓2")
  })

  it("shows git's message when there is no upstream to pull from", async () => {
    const harness = await startRepo()
    await renderApp(harness)

    await press(harness, "p")
    // Not a paraphrase of ours: git explains this better than a pre-check would.
    await waitForToast(harness, "no tracking information")
  })
})

describe("the additional sync Commands", () => {
  it("fetches and prunes without a persistent action menu", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    const theirs = await cloneOf(origin)
    await commitIn(theirs, "theirs.txt", "theirs\n")
    await git(theirs, "push", "--quiet", "origin", "main")
    await renderApp(harness)

    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).toContain("sync.fetch-prune")
    expect(commands).not.toContain("sync.actions")
    await press(harness, "n")

    await waitForToast(harness, "Fetched — ↑0 ↓1")
  })
})

/** The status line is where HEAD lives, so these are responsibilities `sync` inherited. */
describe("the status line segment", () => {
  it("names the branch, and the divergence only when there is one", async () => {
    const harness = await startRepo()
    await addOrigin(harness)
    await renderApp(harness)

    await waitForFrame(harness, "main")
    // In sync, so the branch stands alone rather than carrying a standing `↑0 ↓0`.
    expect(frame(harness)).not.toContain("↑")

    await commitIn(harness.directory, "ahead.txt", "one\n")
    await refreshGit(harness)
    await waitForFrame(harness, "main ↑1")
  })

  it("says where a detached HEAD is, since no row can mark it", async () => {
    const harness = await startRepo()
    await commitIn(harness.directory, "second.txt", "two\n")
    const oid = (await git(harness.directory, "rev-parse", "HEAD")).trim()
    await git(harness.directory, "checkout", "--quiet", "--detach", "HEAD")
    await renderApp(harness)

    await waitForFrame(harness, `detached at ${oid.slice(0, 7)}`)
  })

  it("says outright that the remote deleted the branch", async () => {
    const harness = await startRepo()
    const origin = await addOrigin(harness)
    await git(origin, "update-ref", "-d", "refs/heads/main")
    await git(harness.directory, "fetch", "--quiet", "--prune")
    await renderApp(harness)

    // `gone` is `↑0 ↓0` in git's own data, so a segment reading the numbers would report
    // "everything is pushed" for a branch whose remote no longer exists.
    await waitForFrame(harness, "gone")
    expect(frame(harness)).toContain("main")
  })

  it("puts an operation action at the bottom-right without duplicating its animation", async () => {
    const harness = await startRepo()
    await addOrigin(harness)
    await commitIn(harness.directory, "ahead.txt", "one\n")
    await renderApp(harness)
    await waitForFrame(harness, "main ↑1")

    const end = harness.kernel.git.activity.begin("committing")
    await waitFor(harness, () => harness.kernel.git.activity.getSnapshot().length === 1, "activity to be revealed")
    await waitForFrame(harness, "main ↑1 committing")
    const status = frame(harness)
      .split("\n")
      .find((line) => line.includes("main ↑1 committing"))
    if (status === undefined) throw new Error("Expected the bottom status line")
    expect(status.trimEnd()).toEndWith("committing")
    expect(status).not.toMatch(/[\u2800-\u28ff]/u)

    act(() => end())
    await waitForFrame(harness, (screen) => !screen.includes("committing"))
  })

  it("puts the complete fetch loader at the bottom-right", async () => {
    const harness = await startRepo()
    await addOrigin(harness)
    await renderApp(harness)
    await waitForFrame(harness, "main")

    const end = harness.kernel.git.activity.begin("fetching")
    await waitForFrame(harness, (screen) =>
      screen.split("\n").some((line) => line.includes("main") && /[\u2800-\u28ff]{3} fetching/u.test(line)),
    )
    const status = frame(harness)
      .split("\n")
      .find((line) => line.includes("main") && line.includes("fetching"))
    if (status === undefined) throw new Error("Expected the bottom status line")
    expect(status.trimEnd()).toEndWith("fetching")
    expect(status).toMatch(/[\u2800-\u28ff]{3} fetching/u)

    act(() => end())
    await waitForFrame(harness, (screen) => !screen.includes("fetching"))
  })

  it("survives a fetch, which used to collapse it for the rest of the session", async () => {
    const harness = await startRepo()
    await addOrigin(harness)
    await renderApp(harness)
    await waitForFrame(harness, "main")

    // React reuses one renderable across both forms, so a state rendering `content` where the
    // others render children leaves OpenTUI's text buffer with no chunks, and the slot's error
    // boundary hides the segment for good.
    await press(harness, "f")
    await waitForToast(harness, "Fetched")
    await waitForFrame(harness, "main")
    expect(harness.kernel.diagnostics.getSnapshot()).toEqual([])
  })
})
