import { expect, it } from "bun:test"
import { CliRenderEvents } from "@opentui/core"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/**
 * The M3 gate, end to end: a Pane rendered by the real renderer, reading the real store,
 * tracking real `git` commands run outside laziergit.
 */
const livePane = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useGit } from "laziergit"

  export default defineExtension({
    name: "live",
    activate(ctx) {
      function LivePane() {
        const branch = useGit((state) => state.head.branch)
        const commits = useGit((state) => state.commits.length)
        const clean = useGit((state) => state.status.isClean)
        return <text content={"on " + (branch ?? "detached") + " " + commits + "c " + (clean ? "clean" : "dirty")} />
      }
      ctx.panes.register({ id: "live", title: "Live", component: LivePane })
    },
  })
`

async function git(harness: Harness, ...args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: harness.directory,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr}`)
}

/**
 * Renders repeatedly until the screen catches up, so the assertion is about the pixels
 * rather than the store. The sleep is inside `act` because the update that ends this loop
 * arrives on the poll timer, outside any React event.
 */
async function waitForFrame(harness: Harness, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    await settle(harness)
    last = frame(harness)
    if (last.includes(expected)) return
    await act(async () => {
      await Bun.sleep(30)
    })
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} on screen. Last frame:\n${last}`)
}

it("renders live branch and status, and tracks git commands run outside laziergit", async () => {
  const harness = await createHarness({ git: true })
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": [["live"]] }, "git": { "refreshIntervalMs": 250 } }`,
  )
  await writeFile(join(harness.repo, "live.tsx"), livePane)
  // The harness directory is also the Extension and config home — and where the kernel
  // publishes config.schema.json — so its own scaffolding would otherwise show up as
  // untracked noise in the very status this test asserts on.
  await writeFile(join(harness.directory, ".gitignore"), "global/\nrepo/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "tracked.txt"), "one\n")
  await git(harness, "add", ".gitignore", "tracked.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")

  await renderApp(harness)
  // The store is loaded before Extensions activate, so the first frame is already real.
  expect(frame(harness)).toContain("on main 1c clean")

  // Exactly the gate: a commit made in another terminal.
  await writeFile(join(harness.directory, "tracked.txt"), "two\n")
  await git(harness, "commit", "--quiet", "--all", "--message", "second commit")
  await waitForFrame(harness, "on main 2c clean")

  // And a bare working-tree edit, which moves nothing under .git at all.
  await writeFile(join(harness.directory, "tracked.txt"), "three\n")
  await waitForFrame(harness, "on main 2c dirty")

  // And a branch switch.
  await git(harness, "checkout", "--quiet", "-b", "elsewhere")
  await waitForFrame(harness, "on elsewhere 2c dirty")
}, 30_000)

it("refreshes when the terminal regains focus, without waiting for the next poll", async () => {
  const harness = await createHarness({ git: true })
  // Far longer than this test: only the focus event can move the screen here.
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": [["live"]] }, "git": { "refreshIntervalMs": 60000 } }`,
  )
  await writeFile(join(harness.repo, "live.tsx"), livePane)
  await writeFile(join(harness.directory, ".gitignore"), "global/\nrepo/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "tracked.txt"), "one\n")
  await git(harness, "add", ".gitignore", "tracked.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")

  await renderApp(harness)
  expect(frame(harness)).toContain("on main 1c clean")

  await writeFile(join(harness.directory, "tracked.txt"), "two\n")
  await git(harness, "commit", "--quiet", "--all", "--message", "second commit")
  await settle(harness)
  expect(frame(harness)).toContain("on main 1c clean")

  // Coming back from the terminal the commit was made in.
  harness.setup.renderer.emit(CliRenderEvents.FOCUS)
  await waitForFrame(harness, "on main 2c clean")
}, 30_000)

it("renders an empty store, without polling, outside a repository", async () => {
  const harness = await createHarness()
  await writeFile(harness.configFiles.repo, `{ "layout": { "columns": [["live"]] } }`)
  await writeFile(join(harness.repo, "live.tsx"), livePane)

  await renderApp(harness)
  // Degraded, not broken: `useGit` still resolves and the Pane still renders.
  expect(frame(harness)).toContain("on detached 0c clean")
  expect(harness.kernel.git.available).toBe(false)
  expect(harness.kernel.diagnostics.getSnapshot()).toEqual([])
})
