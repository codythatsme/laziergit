import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

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

/** The shipped Extension itself, not a copy — the same directory `main.tsx` loads. */
const stashExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "stash")

/**
 * A `diff` that renders the target it was handed: the stash Pane's only observable effect on
 * the diff Pane is which target it pushed.
 */
const diffSource = `
  /** @jsxImportSource @opentui/react */
  import { createCell, defineExtension } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      const target = createCell(null)

      function DiffPane() {
        const shown = target.use()
        return <text content={"diff: " + (shown === null ? "nothing" : shown.kind + " " + shown.ref)} />
      }

      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane, placement: { column: 1, order: 10 } })
      return { current: () => target.get(), show: (next) => target.set(next) }
    },
  })
`

/** Just enough `files` to own a Pane the stash Extension can bind `s` inside. */
const filesSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "files",
    activate(ctx) {
      function FilesPane() {
        return <text content="files pane" />
      }

      const pane = ctx.panes.register({
        id: "files",
        title: "Files",
        component: FilesPane,
        placement: { column: 0, order: 20 },
      })
      // Keyless, like the real one: core binds the digits over the Layout.
      ctx.commands.register({ id: "files.focus", title: "Focus files", run: () => pane.focus() })
    },
  })
`

/**
 * A consumer of the exported `StashApi`, the only vantage point the selection is observable
 * from: the Pane keeps its cursor to itself.
 */
const consumerSource = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "watcher",
    needs: ["stash"],
    activate(ctx) {
      const stash = ctx.extensions.get("stash")
      ctx.commands.register({
        id: "watcher.report",
        title: "Report the selected stash",
        keys: "shift+r",
        run: () => ctx.popups.notify("selection is " + (stash.selected()?.message ?? "none")),
      })
    },
  })
`

/** The global `p` the stash Pane's own `p` has to shadow, and only while it is focused. */
const syncSource = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "sync",
    activate(ctx) {
      ctx.commands.register({ id: "sync.pull", title: "Pull", keys: "p", run: () => ctx.popups.notify("pull ran") })
    },
  })
`

/**
 * Reads the repository behind the app's back, so assertions test git and not the store.
 * Inside `act`, because a refresh landing mid-spawn is a React update.
 */
async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  let stdout = ""
  await act(async () => {
    const child = Bun.spawn(["git", ...args], {
      cwd: harness.directory,
      env: { ...process.env, ...gitIsolationEnv },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
    stdout = out
  })
  return stdout
}

function stashCount(list: string): number {
  return list.trim() === "" ? 0 : list.trim().split("\n").length
}

/**
 * One commit on `main`, with the three Extension scopes excluded first: they live inside the
 * repository root, so `stash --include-untracked` would otherwise sweep them up.
 */
async function seed(harness: Harness): Promise<void> {
  await writeFile(
    join(harness.directory, ".git", "info", "exclude"),
    "bundled/\nglobal/\nrepo/\n*.jsonc\nconfig.schema.json\n",
  )
  await writeFile(join(harness.directory, "seed.txt"), "seed\n")
  await git(harness, "add", "seed.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")
}

/** Edits the tracked file and stashes it, so the entry carries `message` and a branch. */
async function stash(harness: Harness, message: string): Promise<void> {
  await writeFile(join(harness.directory, "seed.txt"), `${message}\n`)
  await git(harness, "stash", "push", "--quiet", "--message", message)
}

/**
 * Stashes made from outside laziergit reach the store through {@link refreshGit}, so the
 * fingerprint poll is parked out of every test's way.
 */
async function start(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(stashExtension, join(harness.bundled, "stash")),
    writeFile(join(harness.repo, "diff.tsx"), diffSource),
    writeFile(join(harness.repo, "files.tsx"), filesSource),
    writeFile(join(harness.repo, "sync.tsx"), syncSource),
    writeFile(join(harness.repo, "consumer.tsx"), consumerSource),
    writeFile(harness.configFiles.repo, `{ "git": { "refreshIntervalMs": 60000 } }`),
  ])
  await renderApp(harness)
}

/**
 * Wide enough that a row's message, branch and age all survive the column split. `height` is
 * a parameter so a test can make the list taller than the Pane.
 */
async function stashHarness(height = 36): Promise<Harness> {
  const harness = await createHarness({ git: true, width: 140, height })
  await seed(harness)
  return harness
}

describe("stash pane", () => {
  it("shows only each stash's message and branch", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    expect(frame(harness)).toContain("wip two on main")
    expect(frame(harness)).toContain("wip one on main")
    expect(frame(harness)).not.toContain("stash@{")
  })
})

describe("stash actions", () => {
  it("applies the selected stash on space and keeps the entry", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, "2")
    await press(harness, " ")

    // Read from the store, not by polling `git status`: a concurrent status refreshes the
    // index, and its lock can fail the very apply being waited for. The store's own status
    // read runs after the write, in the refresh the porcelain helper awaits.
    await waitFor(
      harness,
      () => !harness.kernel.git.getSnapshot().status.isClean,
      "the apply to reach the working tree",
    )
    expect(await git(harness, "status", "--porcelain")).toContain("seed.txt")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(2)
    expect(frame(harness)).toContain("wip two on main")
  })

  it("shows git's own refusal when a write fails", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    // An uncommitted edit to the very file the stash touches, which `stash apply` refuses to
    // overwrite. Nothing in the Pane could have predicted that, so git's text is the answer.
    await writeFile(join(harness.directory, "seed.txt"), "local edit\n")
    await start(harness)

    await press(harness, "2")
    await press(harness, " ")

    // Git's first line, verbatim and attributed.
    await waitForFrame(harness, "would be overwritten")
    expect(frame(harness)).toContain("stash: error:")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("pops on p while the pane is focused, leaving the global pull to every other pane", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, "2")
    await press(harness, "p")

    // The popped entry leaving the list is the write's last effect; `wip one` alone remains.
    await waitForFrame(harness, (screen) => !screen.includes("wip two on main"))
    expect(frame(harness)).toContain("wip one on main")
    expect(frame(harness)).not.toContain("pull ran")

    // The global binding is not gone, only shadowed: it is back the moment focus moves.
    await press(harness, "1")
    await press(harness, "p")
    await waitForFrame(harness, "pull ran")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("names the message in the drop confirmation and keeps the entry when it is refused", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, "2")
    await press(harness, "d")
    await waitForFrame(harness, "Drop stash?")
    expect(frame(harness)).toContain("wip two on main")

    await press(harness, "n")
    await waitForFrame(harness, (screen) => !screen.includes("Drop stash?"))
    expect(stashCount(await git(harness, "stash", "list"))).toBe(2)

    await press(harness, "d")
    await waitForFrame(harness, "Drop stash?")
    await press(harness, "y")

    await waitForFrame(harness, (screen) => !screen.includes("wip two on main"))
    expect(frame(harness)).toContain("wip one on main")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("acts on the row's own index, not the one it had when the pane was drawn", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    // Dropping the top entry renumbers `wip one` from 1 to 0, so acting on the index the row
    // was drawn with would take a `stash@{1}` that no longer exists.
    await press(harness, "2")
    await press(harness, "d")
    await waitForFrame(harness, "Drop stash?")
    await press(harness, "y")
    // `wip two` was already on screen, so wait for it to leave rather than to appear.
    await waitForFrame(harness, (screen) => !screen.includes("wip two"))

    await press(harness, "d")
    await waitForFrame(harness, "Drop stash?")
    await press(harness, "y")

    await waitForFrame(harness, "no stashes")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(0)
  })

  it("aims a confirmed drop at the entry it named, not at the slot that entry was in", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, "2")
    await press(harness, "j")
    await press(harness, "d")
    await waitForFrame(harness, "Drop stash?")
    expect(frame(harness)).toContain("wip one on main")

    // Another process stashes while the confirmation waits: `wip one` is stash@{2} now, and
    // the slot the row was in holds `wip two`.
    await stash(harness, "from elsewhere")
    await refreshGit(harness)
    await waitForFrame(harness, "from elsewhere on main")

    await press(harness, "y")

    // Waited on through the frame rather than by spawning git in a loop: a read racing the
    // refresh is a React update this test never wrapped.
    await waitForFrame(harness, (screen) => screen.includes("wip two on main") && !screen.includes("wip one on main"))
    const remaining = await git(harness, "stash", "list")
    expect(remaining).toContain("wip two")
    expect(remaining).toContain("from elsewhere")
    expect(remaining).not.toContain("wip one")
  })
})

describe("contextual stash Commands", () => {
  it("publishes the four actions and creates a branch that takes the entry with it", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, "2")
    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).toContain("stash.apply")
    expect(commands).toContain("stash.pop")
    expect(commands).toContain("stash.drop")
    expect(commands).toContain("stash.branch")
    expect(commands).not.toContain("stash.menu")

    await press(harness, "b")
    await waitForFrame(harness, "Branch from wip two on main")

    await press(harness, () => void harness.setup.mockInput.typeText("rescue"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitFor(
      harness,
      () => {
        const state = harness.kernel.git.getSnapshot()
        return state.head.kind === "onBranch" && state.head.branch === "rescue" && state.stash.length === 1
      },
      "the rescue branch to exist and consume its stash",
    )
    // `git stash branch` drops the entry once it has applied cleanly.
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("branches from the entry the prompt named, not from the slot it was in", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, "2")
    await press(harness, "j")
    await press(harness, "b")
    await waitForFrame(harness, "Branch from wip one on main")

    // The same outside push, against the prompt. `git stash branch` drops the entry it
    // applied, so aiming it at a slot destroys someone else's stash as surely as `drop` does.
    await stash(harness, "from elsewhere")
    await refreshGit(harness)
    await waitForFrame(harness, "from elsewhere on main")

    await press(harness, () => void harness.setup.mockInput.typeText("rescue"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    // Waited on through the frame rather than by spawning git in a loop: a read racing the
    // refresh is a React update this test never wrapped.
    await waitForFrame(harness, (screen) => screen.includes("wip two on main") && !screen.includes("wip one on main"))
    expect(await git(harness, "branch", "--list", "rescue")).toContain("rescue")
    const remaining = await git(harness, "stash", "list")
    expect(remaining).toContain("wip two")
    expect(remaining).toContain("from elsewhere")
    expect(remaining).not.toContain("wip one")
  })

  it("refuses a branch name git would read as an option", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await start(harness)

    await press(harness, "2")
    await press(harness, "b")
    await waitForFrame(harness, "Branch from wip one on main")
    await press(harness, () => void harness.setup.mockInput.typeText("-f"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "A branch name cannot start with a dash")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)

    await pressEscape(harness)
  })
})

describe("stash.save in the files pane", () => {
  it("prompts for a message and stashes the working tree", async () => {
    const harness = await stashHarness()
    await writeFile(join(harness.directory, "seed.txt"), "edited\n")
    await start(harness)

    await press(harness, "1")
    await press(harness, "s")
    await waitForFrame(harness, "Stash message")

    await press(harness, () => void harness.setup.mockInput.typeText("from files"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "from files on main")
    expect(await git(harness, "status", "--porcelain")).toBe("")
  })

  it("asks before sweeping up untracked files, and stashes them when told to", async () => {
    const harness = await stashHarness()
    await writeFile(join(harness.directory, "seed.txt"), "edited\n")
    await writeFile(join(harness.directory, "scratch.txt"), "scratch\n")
    await start(harness)

    await press(harness, "1")
    await press(harness, "s")
    await waitForFrame(harness, "Stash message")
    await press(harness, () => void harness.setup.mockInput.typeText("with untracked"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "1 untracked file would be stashed too")

    await press(harness, "y")
    await waitForFrame(harness, "with untracked on main")

    expect(await Bun.file(join(harness.directory, "scratch.txt")).exists()).toBe(false)
    expect(await git(harness, "status", "--porcelain")).toBe("")
  })

  it("leaves untracked files alone when the confirmation is refused", async () => {
    const harness = await stashHarness()
    await writeFile(join(harness.directory, "seed.txt"), "edited\n")
    await writeFile(join(harness.directory, "scratch.txt"), "scratch\n")
    await start(harness)

    await press(harness, "1")
    await press(harness, "s")
    await waitForFrame(harness, "Stash message")
    await press(harness, () => void harness.setup.mockInput.typeText("tracked only"))
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "1 untracked file would be stashed too")
    await press(harness, "n")

    await waitForFrame(harness, "tracked only on main")
    expect(await Bun.file(join(harness.directory, "scratch.txt")).exists()).toBe(true)
  })

  it("refuses on a clean tree with a message instead of an error from git", async () => {
    const harness = await stashHarness()
    await start(harness)

    await press(harness, "1")
    await press(harness, "s")

    await waitForFrame(harness, "Nothing to stash")
    // Refused before any popup: no prompt to dismiss, and nothing reached git.
    expect(frame(harness)).not.toContain("Stash message")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(0)
  })
})
