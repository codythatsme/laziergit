import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

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

const branchesExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "branches")
const commitsExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commits")
const commitFlowExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commit-flow")
const operationsExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "operations")

const diffSource = `
  /** @jsxImportSource @opentui/react */
  import { createCell, defineExtension } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      const target = createCell(null)
      function DiffPane() {
        const shown = target.use()
        return <text content={shown === null ? "diff nothing" : "diff " + shown.kind + " " + shown.ref} />
      }
      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane })
      return { current: () => target.get(), show: (next) => target.set(next) }
    },
  })
`

const stashSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "stash",
    activate(ctx) {
      function StashPane() {
        return <text content="stash pane" />
      }
      ctx.panes.register({ id: "stash", title: "Stash", component: StashPane })
    },
  })
`

const filesSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "files",
    activate(ctx) {
      function FilesPane() {
        return <text content="conflicted files" />
      }
      const pane = ctx.panes.register({ id: "files", title: "Files", component: FilesPane })
      ctx.commands.register({ id: "files.focus", title: "Focus files", run: () => pane.focus() })
      ctx.commands.register({ id: "files.focus-conflict", title: "Focus first conflict", run: () => pane.focus() })
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
  return stdout
}

async function start(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    symlink(commitsExtension, join(harness.bundled, "commits")),
    symlink(commitFlowExtension, join(harness.bundled, "commit-flow")),
    symlink(operationsExtension, join(harness.bundled, "operations")),
    writeFile(join(harness.repo, "diff.tsx"), diffSource),
    writeFile(join(harness.repo, "stash.tsx"), stashSource),
    writeFile(join(harness.repo, "files.tsx"), filesSource),
    writeFile(
      harness.configFiles.repo,
      JSON.stringify({
        layout: {
          columns: [[["branches", "commits"], ["stash", "commits.cherry-pick"], "files"], ["diff"]],
          focus: "branches",
        },
        git: { refreshIntervalMs: 60_000 },
      }),
    ),
  ])
  await renderApp(harness)
}

async function seedIndependentCommits(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".gitignore"), "bundled/\nglobal/\nrepo/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "base.txt"), "base\n")
  await git(harness, "add", "--all")
  await git(harness, "commit", "--quiet", "--message", "base")
  await git(harness, "checkout", "--quiet", "-b", "source")
  await writeFile(join(harness.directory, "one.txt"), "one\n")
  await git(harness, "add", "one.txt")
  await git(harness, "commit", "--quiet", "--message", "source one")
  await writeFile(join(harness.directory, "two.txt"), "two\n")
  await git(harness, "add", "two.txt")
  await git(harness, "commit", "--quiet", "--message", "source two")
  await git(harness, "checkout", "--quiet", "main")
}

async function seedConflict(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".gitignore"), "bundled/\nglobal/\nrepo/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "shared.txt"), "base\n")
  await git(harness, "add", "--all")
  await git(harness, "commit", "--quiet", "--message", "base")
  await git(harness, "checkout", "--quiet", "-b", "source")
  await writeFile(join(harness.directory, "shared.txt"), "source\n")
  await git(harness, "commit", "--quiet", "--all", "--message", "source conflict")
  await git(harness, "checkout", "--quiet", "main")
  await writeFile(join(harness.directory, "shared.txt"), "target\n")
  await git(harness, "commit", "--quiet", "--all", "--message", "target conflict")
}

async function openSourceHistory(harness: Harness, expectedSubject = "source two"): Promise<void> {
  await press(harness, "j")
  await waitForFrame(harness, "source")
  await press(harness, "\r")
  await waitForFrame(harness, (screen) => screen.includes("source commits") && screen.includes(expectedSubject))
}

async function confirmPaste(harness: Harness): Promise<void> {
  await press(harness, "V")
  await waitForFrame(harness, "will be applied to main in the order shown")
  await press(harness, "y")
}

describe("cherry-pick queue", () => {
  it("reveals the Stash companion tab, survives tab switches, and drops an accidental commit", async () => {
    const harness = await createHarness({ git: true, width: 150, height: 36 })
    await seedIndependentCommits(harness)
    await start(harness)
    await openSourceHistory(harness)

    // Queue oldest first so the visible list is also the execution order.
    await press(harness, "j")
    await press(harness, "C")
    await waitForFrame(harness, "Stash - [Cherry Pick]")
    await waitForFrame(harness, "1. ")
    expect(frame(harness)).toContain("source one")

    await press(harness, "k")
    await press(harness, "C")
    await waitForFrame(harness, "2. ")
    expect(frame(harness)).toContain("source two")

    await press(harness, "2")
    await press(harness, "2")
    await waitForFrame(harness, "[Stash] - Cherry Pick")
    await press(harness, "2")
    await waitForFrame(harness, "Stash - [Cherry Pick]")

    await press(harness, "d")
    await waitForFrame(harness, (screen) => screen.includes("1. ") && !screen.includes("2. "))
    expect(frame(harness)).toContain("1. ")
    expect(frame(harness)).toContain("source two")
    expect(await git(harness, "log", "--format=%s")).toBe("base\n")
    await press(harness, "3")
    expect(harness.kernel.layout.focusedPaneId).toBe("files")
  })

  it("pastes in the shown order, clears the queue, and restores an automatic stash", async () => {
    const harness = await createHarness({ git: true, width: 150, height: 36 })
    await seedIndependentCommits(harness)
    await start(harness)
    await openSourceHistory(harness)

    await press(harness, "j")
    await press(harness, "C")
    await press(harness, "k")
    await press(harness, "C")
    await press(harness, "2")

    await writeFile(join(harness.directory, "base.txt"), "unfinished target work\n")
    await writeFile(join(harness.directory, "scratch.txt"), "untracked target work\n")
    await refreshGit(harness)
    await confirmPaste(harness)

    await waitForFrame(harness, "Cherry-picked 2 commits")
    await waitForFrame(harness, "no commits queued")
    expect(await git(harness, "log", "--format=%s")).toBe("source two\nsource one\nbase\n")
    expect(await Bun.file(join(harness.directory, "base.txt")).text()).toBe("unfinished target work\n")
    expect(await Bun.file(join(harness.directory, "scratch.txt")).text()).toBe("untracked target work\n")
    expect(await git(harness, "stash", "list")).toBe("")
    await press(harness, "3")
    expect(harness.kernel.layout.focusedPaneId).toBe("files")
  })

  it("retains the queue after abort and clears it after conflict continuation completes", async () => {
    const harness = await createHarness({ git: true, width: 150, height: 36 })
    await seedConflict(harness)
    const originalHead = (await git(harness, "rev-parse", "HEAD")).trim()
    await start(harness)
    await openSourceHistory(harness, "source conflict")

    await press(harness, "C")
    await press(harness, "2")
    await confirmPaste(harness)
    await waitFor(
      harness,
      () => harness.kernel.git.getSnapshot().operation.effective === "cherryPick",
      "the cherry-pick conflict to enter operation state",
    )
    await waitForFrame(harness, "Cherry-pick stopped with conflicts")
    expect(frame(harness)).toContain("source conflict")

    await press(harness, "m")
    await waitForFrame(harness, "Cherry-pick options")
    await press(harness, () => harness.setup.mockInput.pressArrow("down"))
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "cherry-pick aborted")
    await waitFor(harness, () => harness.kernel.git.getSnapshot().operation.effective === null, "the abort to finish")
    expect((await git(harness, "rev-parse", "HEAD")).trim()).toBe(originalHead)
    expect(frame(harness)).toContain("source conflict")

    await press(harness, "2")
    await confirmPaste(harness)
    await waitFor(
      harness,
      () => harness.kernel.git.getSnapshot().operation.effective === "cherryPick",
      "the retried cherry-pick to stop",
    )
    await writeFile(join(harness.directory, "shared.txt"), "resolved\n")
    await git(harness, "add", "shared.txt")
    await refreshGit(harness)
    await waitForFrame(harness, "All conflicts resolved")
    await press(harness, "y")

    await waitForFrame(harness, "cherry-pick continued")
    await waitForFrame(harness, "no commits queued")
    expect(await git(harness, "log", "-2", "--format=%s")).toBe("source conflict\ntarget conflict\n")
    expect(await Bun.file(join(harness.directory, "shared.txt")).text()).toBe("resolved\n")
  })
})
