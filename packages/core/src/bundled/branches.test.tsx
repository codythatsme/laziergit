import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  pressEscape,
  refreshGit,
  renderApp,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

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
 * Renders with the real branches Extension loaded. Startup focus is the Layout's first cell,
 * so a test that needs the branches Pane unfocused writes a Layout putting the diff Pane in
 * front of it. `"tabbed"` puts both Panes in one cell, where `]` hides — and therefore
 * unmounts — the one that was showing. Mutations made behind the app's back reach the store
 * through {@link refreshGit}, so the fingerprint poll is parked out of every test's way.
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
    writeFile(
      harness.configFiles.repo,
      `{ "layout": { "columns": ${columns} }, "git": { "refreshIntervalMs": 60000 } }`,
    ),
  ])
  await renderApp(harness)
  if (focus === "branches") await press(harness, "1")
}

async function openMergeMenuForSecondBranch(harness: Harness, branch: string): Promise<void> {
  await press(harness, "j")
  await press(harness, "M")
  await waitForFrame(harness, `Merge ${branch} into main`)
}

describe("checking out", () => {
  it("switches to the selected branch, and says so rather than doing nothing on HEAD", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "other")

    await start(harness)

    // The cursor starts on HEAD, where a checkout would succeed and change nothing.
    await press(harness, " ")
    await waitForFrame(harness, "Already on main")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")

    await press(harness, "j")
    await press(harness, " ")
    // The marker moves because the store refreshed behind the write, which is why a checkout
    // goes through the porcelain helper rather than `raw`.
    await waitForFrame(harness, "* other")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other")
  }, 30_000)
})

describe("creating a branch", () => {
  it("refuses a nameless branch, then creates one at the selected branch and checks it out", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, "n")
    await waitForFrame(harness, "New branch at main")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "Name the branch")

    await press(harness, () => void harness.setup.mockInput.typeText("feature/x"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "* feature/x")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x")
    // Created *at* the selected branch, which is what "here" in the menu label means.
    expect(await git(harness, "rev-parse", "feature/x")).toBe(await git(harness, "rev-parse", "main"))
  }, 30_000)

  it("refuses a name with a space in it, which git would only reject later", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, "n")
    await waitForFrame(harness, "New branch at main")
    await press(harness, () => void harness.setup.mockInput.typeText("two words"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "cannot contain spaces")
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

    await press(harness, "M")
    await waitForFrame(harness, "Cannot merge main into itself")

    await openMergeMenuForSecondBranch(harness, "topic")
    expect(frame(harness)).toContain("Regular merge (fast-forward)")
    expect(frame(harness)).toContain("Regular merge (with merge commit)")
    expect(frame(harness)).toContain("Squash merge and leave uncommitted")

    await press(harness, "m")
    // The toast is the command's last act, after the write and its follow-up refresh, so
    // once it shows the repository below is in its final state.
    await waitForFrame(harness, "Merged topic into main")
    expect(await git(harness, "rev-parse", "main")).toBe(target)
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("creates a merge commit when the histories have diverged", async () => {
    const harness = await createHarness({ git: true })
    await withDivergedTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")

    expect(frame(harness)).toContain("Regular merge (with merge commit)")
    expect(frame(harness)).not.toContain("Regular merge (fast-forward)")

    await press(harness, "m")
    await waitForFrame(harness, "Merged topic into main")
    expect((await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ")).toHaveLength(2)
    expect(await git(harness, "log", "-1", "--format=%s")).toBe("Merge branch 'topic'")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("can squash into the index without moving HEAD", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)
    const before = await git(harness, "rev-parse", "HEAD")

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, "s")

    await waitForFrame(harness, "Squash-merged topic; the changes are staged")
    expect(await git(harness, "diff", "--cached", "--name-only")).toBe("work.txt")
    expect(await git(harness, "rev-parse", "HEAD")).toBe(before)
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("one")
  }, 30_000)

  it("can commit a squash with a message naming both branches", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, "S")

    await waitForFrame(harness, "Squash-merged topic into main")
    expect(await git(harness, "log", "-1", "--format=%s")).toBe("Squash merge topic into main")
    expect((await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ")).toHaveLength(1)
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("offers the conflicted files and can abort a stopped merge", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, "m")
    await waitForFrame(harness, "Merge topic stopped with conflicts")

    expect(frame(harness)).toContain("View conflicted files")
    expect(frame(harness)).toContain("Abort merge")
    expect(await git(harness, "diff", "--name-only", "--diff-filter=U")).toBe("work.txt")

    await press(harness, "a")
    await waitForFrame(harness, "Merge aborted")
    expect(await git(harness, "status", "--porcelain")).toBe("")
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("main")
  }, 30_000)

  it("restores the pre-merge tree when a conflicted squash is aborted", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, "s")
    await waitForFrame(harness, "Merge topic stopped with conflicts")
    expect(frame(harness)).toContain("Abort squash merge")

    await press(harness, "a")
    await waitForFrame(harness, "Abort the squash merge?")
    await press(harness, "y")
    await waitForFrame(harness, "Squash merge aborted")
    expect(await git(harness, "status", "--porcelain")).toBe("")
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("main")
  }, 30_000)

  it("recovers an in-progress merge and commits after its conflicts are resolved", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await press(harness, "m")
    await waitForFrame(harness, "Merge topic stopped with conflicts")
    await pressEscape(harness)

    await writeFile(join(harness.directory, "work.txt"), "resolved\n")
    await git(harness, "add", "work.txt")
    await refreshGit(harness)

    await press(harness, "M")
    await waitForFrame(harness, "Merge in progress on main")
    expect(frame(harness)).toContain("Continue merge")
    expect(frame(harness)).toContain("Abort merge")

    await press(harness, "c")
    await waitForFrame(harness, "Merge completed")
    expect((await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ")).toHaveLength(2)
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
    await press(harness, "j")
    await press(harness, "d")
    await waitForFrame(harness, "Delete wip?")

    await press(harness, "y")
    // git's refusal is read, not assumed: the second confirm only appears because the branch
    // is unmerged.
    await waitForFrame(harness, "Force delete wip?")
    expect(frame(harness)).toContain("commits no other branch has")

    await press(harness, "y")
    // The row leaving the screen is the store publishing the delete, which is the write's
    // last effect.
    await waitForFrame(harness, (screen) => !screen.includes("wip"))
    expect(await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")).toBe("")
  }, 30_000)

  it("keeps the branch when the force confirm is declined", async () => {
    const harness = await createHarness({ git: true })
    await withUnmergedBranch(harness)

    await start(harness)
    await press(harness, "j")
    await press(harness, "d")
    await waitForFrame(harness, "Delete wip?")
    await press(harness, "y")
    await waitForFrame(harness, "Force delete wip?")

    await press(harness, "n")
    await waitForFrame(harness, (screen) => !screen.includes("Force delete wip?"))
    expect(await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")).toBe("wip")
  }, 30_000)

  it("refuses to delete the branch you are on, without asking git", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)
    await press(harness, "d")

    await waitForFrame(harness, "you are on it")
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
    await press(harness, "x")
    await waitForFrame(harness, "Branch: main")

    const onHead = frame(harness)
    expect(onHead).toContain("Create branch here")
    // Nothing that would act on the branch you are standing on.
    expect(onHead).not.toContain("Check out")
    expect(onHead).not.toContain("Delete")
    expect(onHead).not.toContain("Merge into current branch")
    // In sync is not behind, so there is nothing to fast-forward.
    expect(onHead).not.toContain("Fast-forward")

    await pressEscape(harness)
    await press(harness, "j")
    await press(harness, "x")
    await waitForFrame(harness, "Branch: stale")

    const onStale = frame(harness)
    expect(onStale).toContain("Check out")
    expect(onStale).toContain("Merge into current branch")
    expect(onStale).toContain("Force delete")
    expect(onStale).toContain("Fast-forward")
    // It has an upstream already, so there is nothing to set one up for.
    expect(onStale).not.toContain("Push, setting upstream")

    await pressEscape(harness)
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
    await press(harness, "x")
    await waitForFrame(harness, "Branch: main")

    expect(frame(harness)).not.toContain("Open a pull request")

    await pressEscape(harness)
  }, 30_000)

  it("offers a pull request when the remote is a hosting service", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "remote", "add", "origin", "git@github.com:acme/tools.git")

    await start(harness)
    await press(harness, "x")
    await waitForFrame(harness, "Open a pull request")

    await pressEscape(harness)
  }, 30_000)

  it("fast-forwards a branch that is not checked out", async () => {
    const harness = await createHarness({ git: true })
    await withBehindBranch(harness)
    const target = await git(harness, "rev-parse", "main")
    expect(await git(harness, "rev-parse", "stale")).not.toBe(target)

    await start(harness)
    // The behind marker is what the fast-forward erases, so its presence is the baseline.
    await waitForFrame(harness, "↓1")
    await press(harness, "j")
    await press(harness, "x")
    await waitForFrame(harness, "Branch: stale")
    await press(harness, "f")

    await waitForFrame(harness, (screen) => !screen.includes("↓1"))
    expect(await git(harness, "rev-parse", "stale")).toBe(target)
    // The user never left the branch they were on.
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("offers to push a branch that has no upstream, and sets one", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)

    await start(harness)
    await press(harness, "x")
    await waitForFrame(harness, "Push, setting upstream")

    await press(harness, "p")
    // A row says nothing about an upstream that is in sync, so the outcome is read from the
    // store rather than from the frame. Waiting for the store also waits for the write's
    // follow-up refresh, not merely for git's first on-disk side effect.
    await waitFor(
      harness,
      () => {
        const upstream = harness.kernel.git.getSnapshot().branches.find((branch) => branch.name === "main")?.upstream
        return upstream?.remote === "origin" && upstream.branch === "main"
      },
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
    await waitForFrame(harness, "diff branch main")

    await press(harness, "j")
    await waitForFrame(harness, "diff branch topic")

    await press(harness, "x")
    await waitForFrame(harness, "Branch: topic")
    await press(harness, "u")
    await waitForFrame(harness, "Upstream for topic")
    expect(frame(harness)).toContain("origin/topic")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitFor(
      harness,
      () => {
        const upstream = harness.kernel.git.getSnapshot().branches.find((branch) => branch.name === "topic")?.upstream
        return upstream?.remote === "origin" && upstream.branch === "topic"
      },
      "the upstream to be configured",
    )
    expect(await git(harness, "config", "--get", "branch.topic.merge")).toBe("refs/heads/topic")
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
    await waitForFrame(harness, "↑1")
    expect(frame(harness)).toContain("* main")
    expect(frame(harness)).not.toContain("↓")

    await git(harness, "push", "--quiet")
    await refreshGit(harness)
    await waitForFrame(harness, (screen) => !screen.includes("↑1"))
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
    await waitForFrame(harness, "abandoned")

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
    await waitForFrame(harness, "feature/PROJ")

    // Clipped, not wrapped: the tail of the name is absent, and no row below it moved down.
    const lines = frame(harness).split("\n")
    const index = lines.findIndex((line) => line.includes("feature/PROJ"))
    expect(index).toBeGreaterThan(-1)
    expect(frame(harness)).not.toContain("narrow-column")
    expect(lines[index + 1]).not.toContain("cannot-fit")
  }, 30_000)
})
