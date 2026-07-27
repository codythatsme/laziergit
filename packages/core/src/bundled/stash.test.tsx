import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, not a copy — the same directory `main.tsx` loads. */
const stashExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "stash")

/**
 * A `diff` that renders the target it was handed. The stash Pane's only observable effect
 * on the diff Pane is *which target it pushed*, so a stand-in that prints it is a sharper
 * instrument than the real one, whose output is a git diff.
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
      // Keyless, like the real one: core binds the digits over the Layout, and this Pane is
      // the first cell of it — so \`1\` reaches here and \`2\` reaches the stash Pane below it.
      ctx.commands.register({ id: "files.focus", title: "Focus files", run: () => pane.focus() })
    },
  })
`

/**
 * A consumer of the exported `StashApi`, which is the only vantage point the selection is
 * observable from: the Pane keeps its cursor to itself, and `selected()` is the whole of
 * what it publishes.
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
 *
 * Inside `act` because spawning git is the one thing here that takes real time while the
 * fingerprint poll is running: a refresh landing mid-spawn is a React update, and one that
 * happened outside `act` would be reported as a test that failed to wrap it.
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
 * One commit on `main`, with the three Extension scopes excluded first: they live inside
 * the repository root, so without this every `stash --include-untracked` would sweep up the
 * very sources the harness is loading Extensions from.
 */
async function seed(harness: Harness): Promise<void> {
  // The Extension scopes, the harness's config files, and the JSON schema the kernel writes
  // beside them all live inside the repository root.
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

async function start(harness: Harness, config?: string): Promise<void> {
  await Promise.all([
    symlink(stashExtension, join(harness.bundled, "stash")),
    writeFile(join(harness.repo, "diff.tsx"), diffSource),
    writeFile(join(harness.repo, "files.tsx"), filesSource),
    writeFile(join(harness.repo, "sync.tsx"), syncSource),
    writeFile(join(harness.repo, "consumer.tsx"), consumerSource),
    ...(config === undefined ? [] : [writeFile(harness.configFiles.repo, config)]),
  ])
  await renderApp(harness)
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
 * A keypress starts git in another process; what follows is only worth asserting once that
 * has landed, the store has republished, and React has painted. Polled rather than slept
 * for a fixed span, so the test is neither flaky on a loaded machine nor slow on an idle
 * one — and the failure carries the frame, because "timed out" alone explains nothing.
 */
async function settleUntil(harness: Harness, what: string, holds: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => {
      await Bun.sleep(10)
    })
    await settle(harness)
    if (await holds()) return
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame(harness)}`)
}

/** The frame, once it shows `text`. Fails the test if it never does. */
async function frameShowing(harness: Harness, text: string): Promise<string> {
  await settleUntil(harness, `the frame to show "${text}"`, () => frame(harness).includes(text))
  return frame(harness)
}

/**
 * Wide enough that a row's message, branch, and age all survive the column split. `height`
 * is a parameter so a test can make the list taller than the Pane without stashing dozens
 * of times to get there.
 */
async function stashHarness(height = 36): Promise<Harness> {
  const harness = await createHarness({ git: true, width: 140, height })
  await seed(harness)
  return harness
}

describe("stash actions", () => {
  it("applies the selected stash on space and keeps the entry", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey(" "))

    await settleUntil(harness, "the apply to reach the working tree", async () =>
      (await git(harness, "status", "--porcelain")).includes("seed.txt"),
    )
    expect(stashCount(await git(harness, "stash", "list"))).toBe(2)
    expect(frame(harness)).toContain("stash@{0} wip two")
  })

  it("shows git's own refusal when a write fails", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    // An uncommitted edit to the very file the stash touches, which `stash apply` refuses
    // to overwrite. Nothing in the Pane could have predicted that, so git's text is the
    // whole explanation the user gets.
    await writeFile(join(harness.directory, "seed.txt"), "local edit\n")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey(" "))

    // Git's first line, verbatim and attributed — a toast is one line, so the paths it goes
    // on to list are not on screen, but the sentence that explains the refusal is.
    expect(await frameShowing(harness, "would be overwritten")).toContain("stash: error:")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("pops on p while the pane is focused, leaving the global pull to every other pane", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("p"))

    expect(await frameShowing(harness, "stash@{0} wip one")).not.toContain("pull ran")

    // The global binding is not gone, only shadowed: it is back the moment focus moves.
    await press(harness, () => harness.setup.mockInput.pressKey("1"))
    await press(harness, () => harness.setup.mockInput.pressKey("p"))
    expect(frame(harness)).toContain("pull ran")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("names the message in the drop confirmation and keeps the entry when it is refused", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("d"))

    const asked = frame(harness)
    expect(asked).toContain("Drop stash@{0}?")
    expect(asked).toContain("wip two")

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    expect(stashCount(await git(harness, "stash", "list"))).toBe(2)

    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    await press(harness, () => harness.setup.mockInput.pressKey("y"))

    await frameShowing(harness, "stash@{0} wip one")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("acts on the row's own index, not the one it had when the pane was drawn", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    // Drop the top entry, wip two, which renumbers `wip one` from 1 to 0, then drop what is
    // now selected: acting on the index wip one was *drawn* with would take a `stash@{1}`
    // that no longer exists.
    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    // `wip two` was already on screen before the drop, so waiting on it proves nothing; wait
    // for it to *leave* — the moment the first drop lands and the cursor falls onto wip one.
    await settleUntil(harness, "the first drop to leave only wip one", () => !frame(harness).includes("wip two"))

    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    await press(harness, () => harness.setup.mockInput.pressKey("y"))

    await frameShowing(harness, "no stashes")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(0)
  })

  it("aims a confirmed drop at the entry it named, not at the slot that entry was in", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    // Fast enough for the app to notice an outside push while a popup is up; the shipped 2s
    // is a person's timescale, not a test's.
    await start(harness, `{ "git": { "refreshIntervalMs": 250 } }`)

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    expect(frame(harness)).toContain("Drop stash@{1}?")

    // Another process stashes while the confirmation waits — the case the 2s poll exists
    // for. `wip one` is stash@{2} now, and the slot the row was in holds `wip two`.
    await stash(harness, "from elsewhere")
    await settleUntil(harness, "the store to notice the outside stash", () =>
      frame(harness).includes("stash@{2} wip one"),
    )

    await press(harness, () => harness.setup.mockInput.pressKey("y"))

    // Waited on through the frame rather than by spawning git in a loop: with the store
    // settled the reads below are, and a read racing the refresh is a React update this
    // test never wrapped.
    await settleUntil(
      harness,
      "the drop to leave two entries",
      () => frame(harness).includes("stash@{1}") && !frame(harness).includes("stash@{2}"),
    )
    const remaining = await git(harness, "stash", "list")
    expect(remaining).toContain("wip two")
    expect(remaining).toContain("from elsewhere")
    expect(remaining).not.toContain("wip one")
  })
})

describe("stash menu", () => {
  it("offers the four actions on x and creates a branch that takes the entry with it", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    const menu = frame(harness)
    expect(menu).toContain("stash@{0} wip two")
    expect(menu).toContain("a  Apply")
    expect(menu).toContain("p  Pop")
    expect(menu).toContain("d  Drop")
    expect(menu).toContain("b  Create branch from this stash")

    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    expect(frame(harness)).toContain("Branch from stash@{0}")

    await press(harness, () => void harness.setup.mockInput.typeText("rescue"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await settleUntil(harness, "the rescue branch to exist", async () =>
      (await git(harness, "branch", "--list", "rescue")).includes("rescue"),
    )
    // `git stash branch` drops the entry once it has applied cleanly.
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)
  })

  it("branches from the entry the prompt named, not from the slot it was in", async () => {
    const harness = await stashHarness()
    await stash(harness, "wip one")
    await stash(harness, "wip two")
    await start(harness, `{ "git": { "refreshIntervalMs": 250 } }`)

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    expect(frame(harness)).toContain("Branch from stash@{1}")

    // The same outside push, against the prompt this time. `git stash branch` drops the
    // entry it applied, so aiming it at a slot destroys someone else's stash as surely as
    // `drop` does.
    await stash(harness, "from elsewhere")
    await settleUntil(harness, "the store to notice the outside stash", () =>
      frame(harness).includes("stash@{2} wip one"),
    )

    await press(harness, () => void harness.setup.mockInput.typeText("rescue"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    // Waited on through the frame rather than by spawning git in a loop: with the store
    // settled the reads below are, and a read racing the refresh is a React update this
    // test never wrapped.
    await settleUntil(
      harness,
      "the branch to take one of the three entries with it",
      () => frame(harness).includes("stash@{1}") && !frame(harness).includes("stash@{2}"),
    )
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

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    await press(harness, () => void harness.setup.mockInput.typeText("-f"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    expect(frame(harness)).toContain("A branch name cannot start with a dash")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(1)

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })
})

describe("stash.save in the files pane", () => {
  it("prompts for a message and stashes the working tree", async () => {
    const harness = await stashHarness()
    await writeFile(join(harness.directory, "seed.txt"), "edited\n")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("1"))
    await press(harness, () => harness.setup.mockInput.pressKey("s"))
    expect(frame(harness)).toContain("Stash message")

    await press(harness, () => void harness.setup.mockInput.typeText("from files"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await frameShowing(harness, "stash@{0} from files on main")
    expect(await git(harness, "status", "--porcelain")).toBe("")
  })

  it("asks before sweeping up untracked files, and stashes them when told to", async () => {
    const harness = await stashHarness()
    await writeFile(join(harness.directory, "seed.txt"), "edited\n")
    await writeFile(join(harness.directory, "scratch.txt"), "scratch\n")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("1"))
    await press(harness, () => harness.setup.mockInput.pressKey("s"))
    await press(harness, () => void harness.setup.mockInput.typeText("with untracked"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    expect(frame(harness)).toContain("1 untracked file would be stashed too")

    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await frameShowing(harness, "stash@{0} with untracked")

    expect(await Bun.file(join(harness.directory, "scratch.txt")).exists()).toBe(false)
    expect(await git(harness, "status", "--porcelain")).toBe("")
  })

  it("leaves untracked files alone when the confirmation is refused", async () => {
    const harness = await stashHarness()
    await writeFile(join(harness.directory, "seed.txt"), "edited\n")
    await writeFile(join(harness.directory, "scratch.txt"), "scratch\n")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("1"))
    await press(harness, () => harness.setup.mockInput.pressKey("s"))
    await press(harness, () => void harness.setup.mockInput.typeText("tracked only"))
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await press(harness, () => harness.setup.mockInput.pressKey("n"))

    await frameShowing(harness, "stash@{0} tracked only")
    expect(await Bun.file(join(harness.directory, "scratch.txt")).exists()).toBe(true)
  })

  it("refuses on a clean tree with a message instead of an error from git", async () => {
    const harness = await stashHarness()
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("1"))
    await press(harness, () => harness.setup.mockInput.pressKey("s"))

    expect(frame(harness)).toContain("Nothing to stash")
    // Refused before any popup: no prompt to dismiss, and nothing reached git.
    expect(frame(harness)).not.toContain("Stash message")
    expect(stashCount(await git(harness, "stash", "list"))).toBe(0)
  })
})
