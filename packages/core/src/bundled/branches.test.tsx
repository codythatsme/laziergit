import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, linked into the bundled scope the way `main.tsx` loads it. */
const branchesExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "branches")

/**
 * Stands in for the diff Extension, which `branches` needs. A stub keeps this file about
 * branches: the {@link DiffTarget} the pane asks for is on screen where an assertion can see
 * it, and a sibling Extension's bugs cannot fail these tests.
 */
const diffStub = `
  /** @jsxImportSource @opentui/react */
  import { createCell, defineExtension } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      const target = createCell(null)

      function DiffPane() {
        const current = target.use()
        const ref = current === null ? "" : String(current.ref).slice(0, 7)
        return <text content={current === null ? "diff none" : "diff " + current.kind + " " + ref} />
      }

      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane })
      return { current: () => target.get(), show: (next) => target.set(next) }
    },
  })
`

async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: harness.directory,
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
  return stdout.trim()
}

/**
 * One commit on `main`. The harness directory is also the Extension, config and remote home,
 * so all of that scaffolding is ignored — otherwise every commit here would sweep it in.
 */
async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".gitignore"), "bundled/\nglobal/\nrepo/\norigin.git/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "work.txt"), "one\n")
  await git(harness, "add", ".gitignore", "work.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")
}

/** A bare repository inside the (ignored) harness directory, so it is cleaned up with it. */
async function addOrigin(harness: Harness): Promise<void> {
  await git(harness, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", "origin.git")
  await git(harness, "remote", "add", "origin", join(harness.directory, "origin.git"))
}

async function commit(harness: Harness, contents: string, message: string, date?: string): Promise<void> {
  await writeFile(join(harness.directory, "work.txt"), contents)
  await git(
    harness,
    "commit",
    "--quiet",
    "--all",
    ...(date === undefined ? [] : ["--date", date]),
    "--message",
    message,
  )
}

/**
 * A key press, plus enough real time for the terminal parser to disambiguate it — a lone
 * escape byte is only a key once the parser has waited for the sequence it could start.
 */
async function press(harness: Harness, action: () => void): Promise<void> {
  await act(async () => {
    action()
    await Bun.sleep(60)
  })
  await settle(harness)
}

/**
 * Renders with the real branches Extension loaded. Startup focus is the Layout's first cell,
 * so a test that needs the branches Pane unfocused writes a Layout putting the diff Pane in
 * front of it. `"tabbed"` puts both Panes in one cell, where `]` hides — and therefore
 * unmounts — the one that was showing.
 */
async function start(harness: Harness, focus: "branches" | "diff" | "tabbed" = "branches"): Promise<void> {
  const columns =
    focus === "tabbed"
      ? `[[["branches", "diff"]]]`
      : focus === "branches"
        ? `[["branches"], ["diff"]]`
        : `[["diff"], ["branches"]]`
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(harness.configFiles.repo, `{ "layout": { "columns": ${columns} } }`),
  ])
  await renderApp(harness)
  if (focus === "branches") await press(harness, () => harness.setup.mockInput.pressKey("1"))
}

/** Waits for work a keypress started — a git write, then the refresh and render behind it. */
async function waitUntil(
  harness: Harness,
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await settle(harness)
    // Inside `act`, because the condition shells out to git: the store can publish and the
    // Panes re-render while it is running.
    let met = false
    await act(async () => {
      met = await condition()
    })
    if (met) return
    await act(async () => {
      await Bun.sleep(30)
    })
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame(harness)}`)
}

async function openMergeMenuForSecondBranch(harness: Harness, branch: string): Promise<void> {
  await press(harness, () => harness.setup.mockInput.pressKey("j"))
  await press(harness, () => harness.setup.mockInput.pressKey("M"))
  await waitUntil(
    harness,
    async () => frame(harness).includes(`Merge ${branch} into main`),
    `the merge menu for ${branch}`,
  )
}

describe("checking out", () => {
  it("switches to the selected branch, and says so rather than doing nothing on HEAD", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "other")

    await start(harness)

    // The cursor starts on HEAD, where a checkout would succeed and change nothing.
    await press(harness, () => harness.setup.mockInput.pressKey(" "))
    expect(frame(harness)).toContain("Already on main")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey(" "))
    // The marker moves because the store refreshed behind the write, which is why a checkout
    // goes through the porcelain helper rather than `raw`.
    await waitUntil(harness, async () => frame(harness).includes("* other"), "the pane to follow the checkout")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other")
  }, 30_000)
})

describe("creating a branch", () => {
  it("refuses a nameless branch, then creates one at the selected branch and checks it out", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    expect(frame(harness)).toContain("New branch at main")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    expect(frame(harness)).toContain("Name the branch")

    await press(harness, () => void harness.setup.mockInput.typeText("feature/x"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitUntil(
      harness,
      async () => (await git(harness, "rev-parse", "--abbrev-ref", "HEAD")) === "feature/x",
      "the new branch to be checked out",
    )
    // Created *at* the selected branch, which is what "here" in the menu label means.
    expect(await git(harness, "rev-parse", "feature/x")).toBe(await git(harness, "rev-parse", "main"))
  }, 30_000)

  it("refuses a name with a space in it, which git would only reject later", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    await press(harness, () => void harness.setup.mockInput.typeText("two words"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    expect(frame(harness)).toContain("cannot contain spaces")
    expect(await git(harness, "branch", "--list", "--format=%(refname:short)")).toBe("main")
  }, 30_000)
})

describe("merging a branch into the checked-out branch", () => {
  async function withFastForwardTopic(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await commit(harness, "topic\n", "topic work")
    await git(harness, "checkout", "--quiet", "main")
  }

  async function withDivergedTopic(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await writeFile(join(harness.directory, "topic.txt"), "topic\n")
    await git(harness, "add", "topic.txt")
    await git(harness, "commit", "--quiet", "--message", "topic work")
    await git(harness, "checkout", "--quiet", "main")
    await writeFile(join(harness.directory, "main.txt"), "main\n")
    await git(harness, "add", "main.txt")
    await git(harness, "commit", "--quiet", "--message", "main work")
  }

  async function withConflictingTopic(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await commit(harness, "topic\n", "topic work")
    await git(harness, "checkout", "--quiet", "main")
    await commit(harness, "main\n", "main work")
  }

  it("opens with M, refuses HEAD, and fast-forwards without switching branches", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)
    const target = await git(harness, "rev-parse", "topic")

    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("M"))
    expect(frame(harness)).toContain("Cannot merge main into itself")

    await openMergeMenuForSecondBranch(harness, "topic")
    expect(frame(harness)).toContain("Regular merge (fast-forward)")
    expect(frame(harness)).toContain("Regular merge (with merge commit)")
    expect(frame(harness)).toContain("Squash merge and leave uncommitted")

    await press(harness, () => harness.setup.mockInput.pressKey("m"))
    await waitUntil(
      harness,
      async () => (await git(harness, "rev-parse", "main")) === target,
      "main to fast-forward to topic",
    )
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("creates a merge commit when the histories have diverged", async () => {
    const harness = await createHarness({ git: true })
    await withDivergedTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")

    expect(frame(harness)).toContain("Regular merge (with merge commit)")
    expect(frame(harness)).not.toContain("Regular merge (fast-forward)")

    await press(harness, () => harness.setup.mockInput.pressKey("m"))
    await waitUntil(
      harness,
      async () => (await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ").length === 2,
      "the merge commit",
    )
    expect(await git(harness, "log", "-1", "--format=%s")).toBe("Merge branch 'topic'")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("can squash into the index without moving HEAD", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)
    const before = await git(harness, "rev-parse", "HEAD")

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, () => harness.setup.mockInput.pressKey("s"))

    await waitUntil(
      harness,
      async () => (await git(harness, "diff", "--cached", "--name-only")) === "work.txt",
      "the squash result to be staged",
    )
    expect(await git(harness, "rev-parse", "HEAD")).toBe(before)
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("one")
  }, 30_000)

  it("can commit a squash with a message naming both branches", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, () => harness.setup.mockInput.pressKey("S"))

    await waitUntil(
      harness,
      async () => (await git(harness, "log", "-1", "--format=%s")) === "Squash merge topic into main",
      "the squash commit",
    )
    expect((await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ")).toHaveLength(1)
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("offers the conflicted files and can abort a stopped merge", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, () => harness.setup.mockInput.pressKey("m"))
    await waitUntil(
      harness,
      async () => frame(harness).includes("Merge topic stopped with conflicts"),
      "the conflict menu",
    )

    expect(frame(harness)).toContain("View conflicted files")
    expect(frame(harness)).toContain("Abort merge")
    expect(await git(harness, "diff", "--name-only", "--diff-filter=U")).toBe("work.txt")

    await press(harness, () => harness.setup.mockInput.pressKey("a"))
    await waitUntil(
      harness,
      async () => (await git(harness, "status", "--porcelain")) === "",
      "the merge abort to restore the working tree",
    )
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("main")
  }, 30_000)

  it("restores the pre-merge tree when a conflicted squash is aborted", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, () => harness.setup.mockInput.pressKey("s"))
    await waitUntil(
      harness,
      async () => frame(harness).includes("Merge topic stopped with conflicts"),
      "the squash conflict menu",
    )
    expect(frame(harness)).toContain("Abort squash merge")

    await press(harness, () => harness.setup.mockInput.pressKey("a"))
    expect(frame(harness)).toContain("Abort the squash merge?")
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitUntil(
      harness,
      async () => (await git(harness, "status", "--porcelain")) === "",
      "the squash abort to restore the working tree",
    )
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("main")
  }, 30_000)

  it("recovers an in-progress merge and commits after its conflicts are resolved", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, () => harness.setup.mockInput.pressKey("m"))
    await waitUntil(
      harness,
      async () => frame(harness).includes("Merge topic stopped with conflicts"),
      "the conflict menu",
    )
    await press(harness, () => harness.setup.mockInput.pressEscape())

    await writeFile(join(harness.directory, "work.txt"), "resolved\n")
    await git(harness, "add", "work.txt")
    await act(async () => {
      await harness.kernel.git.refresh()
    })
    await settle(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("M"))
    await waitUntil(
      harness,
      async () => frame(harness).includes("Merge in progress on main"),
      "the merge recovery menu",
    )
    expect(frame(harness)).toContain("Continue merge")
    expect(frame(harness)).toContain("Abort merge")

    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    await waitUntil(
      harness,
      async () => (await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ").length === 2,
      "the continued merge commit",
    )
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("resolved")
  }, 30_000)
})

describe("deleting a branch", () => {
  /** `wip` carries a commit no other branch has, which is what `-d` refuses. */
  async function withUnmergedBranch(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "wip")
    await commit(harness, "wip\n", "unmerged work")
    await git(harness, "checkout", "--quiet", "main")
  }

  it("offers a force delete when git refuses an unmerged branch", async () => {
    const harness = await createHarness({ git: true })
    await withUnmergedBranch(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    expect(frame(harness)).toContain("Delete wip?")

    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    // git's refusal is read, not assumed: the second confirm only appears because the branch
    // is unmerged.
    await waitUntil(harness, async () => frame(harness).includes("Force delete wip?"), "the force confirm to open")
    expect(frame(harness)).toContain("commits no other branch has")

    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitUntil(
      harness,
      async () => (await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")) === "",
      "the branch to be deleted",
    )
  }, 30_000)

  it("keeps the branch when the force confirm is declined", async () => {
    const harness = await createHarness({ git: true })
    await withUnmergedBranch(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitUntil(harness, async () => frame(harness).includes("Force delete wip?"), "the force confirm to open")

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    await settle(harness)

    expect(await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")).toBe("wip")
    expect(frame(harness)).not.toContain("Force delete wip?")
  }, 30_000)

  it("refuses to delete the branch you are on, without asking git", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("d"))

    expect(frame(harness)).toContain("you are on it")
    expect(frame(harness)).not.toContain("Delete main?")
  }, 30_000)
})

describe("the branch menu", () => {
  /**
   * `stale` sits one commit behind `origin/main` with nothing of its own — the only shape a
   * fast-forward is legal for. `main` is in sync, and is HEAD.
   */
  async function withBehindBranch(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "branch", "stale")
    await commit(harness, "two\n", "second commit")
    await addOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    await git(harness, "branch", "--set-upstream-to", "origin/main", "--", "stale")
  }

  it("hides what does not apply to the branch it was opened for", async () => {
    const harness = await createHarness({ git: true })
    await withBehindBranch(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    const onHead = frame(harness)
    expect(onHead).toContain("Branch: main")
    expect(onHead).toContain("Create branch here")
    // Nothing that would act on the branch you are standing on.
    expect(onHead).not.toContain("Check out")
    expect(onHead).not.toContain("Delete")
    expect(onHead).not.toContain("Merge into current branch")
    // In sync is not behind, so there is nothing to fast-forward.
    expect(onHead).not.toContain("Fast-forward")

    await press(harness, () => harness.setup.mockInput.pressEscape())
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    const onStale = frame(harness)
    expect(onStale).toContain("Branch: stale")
    expect(onStale).toContain("Check out")
    expect(onStale).toContain("Merge into current branch")
    expect(onStale).toContain("Force delete")
    expect(onStale).toContain("Fast-forward")
    // It has an upstream already, so there is nothing to set one up for.
    expect(onStale).not.toContain("Push, setting upstream")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  }, 30_000)

  /**
   * The URL itself is `pull-request.test.ts`'s subject; what this pins is the offer. `addOrigin`
   * points `origin` at a bare directory, which is a remote with no web page at all.
   */
  it("hides the pull-request item when the remote is a directory nobody can browse", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    expect(frame(harness)).toContain("Branch: main")
    expect(frame(harness)).not.toContain("Open a pull request")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  }, 30_000)

  it("offers a pull request when the remote is a hosting service", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "remote", "add", "origin", "git@github.com:acme/tools.git")

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    expect(frame(harness)).toContain("Open a pull request")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  }, 30_000)

  it("fast-forwards a branch that is not checked out", async () => {
    const harness = await createHarness({ git: true })
    await withBehindBranch(harness)
    const target = await git(harness, "rev-parse", "main")
    expect(await git(harness, "rev-parse", "stale")).not.toBe(target)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("f"))

    await waitUntil(
      harness,
      async () => (await git(harness, "rev-parse", "stale")) === target,
      "stale to catch up with its upstream",
    )
    // The user never left the branch they were on.
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("offers to push a branch that has no upstream, and sets one", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    expect(frame(harness)).toContain("Push, setting upstream")

    await press(harness, () => harness.setup.mockInput.pressKey("p"))
    // A row says nothing about an upstream that is in sync, so the outcome is read from the
    // repository rather than from the frame.
    await waitUntil(
      harness,
      async () => (await git(harness, "config", "--get", "branch.main.remote")) === "origin",
      "the branch to report an upstream",
    )
    expect(await git(harness, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/main")).toBe(
      "origin/main",
    )
  }, 30_000)

  it("sets an upstream from a prompt prefilled with the ref a push would have used", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)
    // Pushed once, then untracked: `origin/topic` exists, but the branch does not know it.
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "topic")
    await git(harness, "branch", "--unset-upstream", "topic")
    await git(harness, "checkout", "--quiet", "main")

    await start(harness)
    // The stub prints the DiffTarget it was handed, so this pins the kind the Pane pushes:
    // `branch`, which is what lets the detail view name what a clipped row cut off.
    expect(frame(harness)).toContain("diff branch main")

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await waitUntil(
      harness,
      async () => frame(harness).includes("diff branch topic"),
      "the diff to follow the cursor onto topic",
    )

    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("u"))
    expect(frame(harness)).toContain("Upstream for topic")
    expect(frame(harness)).toContain("origin/topic")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitUntil(
      harness,
      async () => (await git(harness, "config", "--get", "branch.topic.merge")) === "refs/heads/topic",
      "the upstream to be configured",
    )
  }, 30_000)
})

describe("what a row says about its upstream", () => {
  it("prints only the counts that are not zero, and nothing at all when in sync", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    await commit(harness, "two\n", "local work")

    await start(harness)

    // Ahead by one, behind by none: the row says `↑1` and stops there.
    await waitUntil(harness, async () => frame(harness).includes("* main"), "the branch row")
    const ahead = frame(harness)
    expect(ahead).toContain("↑1")
    expect(ahead).not.toContain("↓")

    await git(harness, "push", "--quiet")
    await waitUntil(harness, async () => !frame(harness).includes("↑1"), "the push to land in the row")
    // In sync now, so the whole column goes away rather than becoming a tick.
    const synced = frame(harness)
    expect(synced).toContain("* main")
    expect(synced).not.toContain("↑")
    expect(synced).not.toContain("✓")
  }, 30_000)

  it("draws a branch whose upstream was deleted in the danger colour", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)
    await git(harness, "checkout", "--quiet", "-b", "abandoned")
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "abandoned")
    await git(harness, "push", "--quiet", "--delete", "origin", "abandoned")
    await git(harness, "fetch", "--quiet", "--prune")

    await start(harness)
    await waitUntil(harness, async () => frame(harness).includes("abandoned"), "the branch row")

    // `gone` is reported by git as `↑0 ↓0`, byte-identical to a branch in sync, so colour is
    // the whole signal — and the char frame cannot see it. Spans can.
    const nameSpan = (needle: string) =>
      harness.setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes(needle))

    const danger = RGBA.fromHex(harness.kernel.theme.getSnapshot().danger)
    expect(nameSpan("abandoned")?.fg?.equals(danger)).toBe(true)
    // And the contrast, or the assertion above would pass in a theme that painted everything
    // red: `main` is here too, tracking nothing, and its name is ordinary text.
    expect(nameSpan("main")?.fg?.equals(danger)).toBe(false)
  }, 30_000)

  it("keeps a branch name too long for its column on one line", async () => {
    const harness = await createHarness({ git: true, width: 60 })
    await seed(harness)
    const long = "feature/PROJ-1234-a-name-that-cannot-fit-in-a-narrow-column"
    await git(harness, "branch", long)

    await start(harness)
    await waitUntil(harness, async () => frame(harness).includes("feature/PROJ"), "the long branch row")

    // Clipped, not wrapped: the tail of the name is absent, and no row below it moved down.
    const lines = frame(harness).split("\n")
    const index = lines.findIndex((line) => line.includes("feature/PROJ"))
    expect(index).toBeGreaterThan(-1)
    expect(frame(harness)).not.toContain("narrow-column")
    expect(lines[index + 1]).not.toContain("cannot-fit")
  }, 30_000)
})
