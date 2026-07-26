import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The same directory `main.tsx` hands the kernel as the bundled scope. */
const bundledExtensionDirectory = resolve(import.meta.dir, "..", "..", "..", "..", "extensions")

/**
 * `files` declares `needs: ["diff"]`, and a bundled Extension being rewritten in a sibling
 * commit is no basis for this file's assertions. A repo-scope Extension named `diff`
 * shadows the bundled one (§0) and satisfies the need with a `DiffApi` that prints what it
 * was shown — which is exactly the fact under test when the cursor moves.
 */
const diffStub = `
  /** @jsxImportSource @opentui/react */
  import { createCell, defineExtension } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      const shown = createCell("nothing")
      function DiffPane() {
        return <text content={"showing " + shown.use()} />
      }
      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane, placement: { column: 1, order: 10 } })
      return {
        current: () => null,
        show: (target) => shown.set(target === null ? "nothing" : target.kind + " " + (target.path ?? "-")),
      }
    },
  })
`

/** A third-party consumer of `FilesApi`, to prove the exported RowSource is the real one. */
const decoratorStub = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "labels",
    needs: ["files"],
    activate(ctx) {
      const files = ctx.extensions.get("files")
      files.decorateRows((change) => (change.kind === "untracked" ? { badge: "new!", tone: "info" } : undefined))
      ctx.commands.register({
        id: "labels.report",
        title: "Report the files selection",
        keys: "shift+v",
        run: () => ctx.popups.notify("selected " + (files.selected()?.path ?? "none")),
      })
    },
  })
`

async function run(cwd: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...gitIsolationEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { stdout, exitCode }
}

/** Fixture git. A broken fixture is not a test result, so anything unexpected fails loudly. */
async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  const output = await run(harness.directory, args)
  if (output.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${output.exitCode}`)
  return output.stdout
}

function write(harness: Harness, path: string, contents: string): Promise<void> {
  return writeFile(join(harness.directory, path), contents)
}

/** Paths git currently reports as staged — the assertion most of these tests really make. */
async function staged(harness: Harness): Promise<readonly string[]> {
  const output = await git(harness, "diff", "--cached", "--name-only")
  return output.split("\n").filter((line) => line.length > 0)
}

/** Side by side, which is what every test here reads unless it is about tabbing. */
const columnsLayout = `[["files"], ["diff"]]`
/** One cell, two tabs: the arrangement in which showing the diff *unmounts* the files Pane. */
const tabbedLayout = `[[["files", "diff"]]]`

/**
 * The poll is disabled outright: every change these tests make either predates the first
 * read or goes through laziergit, which refreshes after its own writes. A tick landing
 * mid-test would only republish the same state from outside React's `act`.
 */
function configOf(layout: string): string {
  return `{ "layout": { "columns": ${layout} }, "git": { "refreshIntervalMs": 60000 } }`
}

/**
 * A harness whose repository root is the harness directory, with the real
 * `extensions/files` linked into the bundled scope. The `.gitignore` is committed first
 * because that directory is also the Extension and config home — its own scaffolding would
 * otherwise be untracked noise in the very Pane under test.
 */
async function createFilesHarness(layout: string = columnsLayout): Promise<Harness> {
  const harness = await createHarness({ git: true })
  await Promise.all([
    symlink(join(bundledExtensionDirectory, "files"), join(harness.bundled, "files")),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(harness.configFiles.repo, configOf(layout)),
    write(harness, ".gitignore", "bundled/\nglobal/\nrepo/\n*.json\n*.jsonc\n"),
  ])
  await git(harness, "add", ".gitignore")
  await git(harness, "commit", "--quiet", "--message", "seed")
  return harness
}

/** One commit, so the fixture has a HEAD to diff a modification against. */
async function commitTracked(harness: Harness, ...paths: readonly string[]): Promise<void> {
  await git(harness, "add", ...paths)
  await git(harness, "commit", "--quiet", "--message", "tracked")
}

/**
 * A key press, and the real time that has to pass before its consequences are over: the
 * terminal parser only settles a lone escape byte into a key once it has waited for the
 * sequence it could start, and a Command that writes returns long before git and the store
 * refresh behind it. The wait is inside `act`, so the render that lands mid-write is one
 * React knows about rather than a warning.
 */
async function press(harness: Harness, key: string): Promise<void> {
  await act(async () => {
    harness.setup.mockInput.pressKey(key)
    await Bun.sleep(150)
  })
  await settle(harness)
}

/**
 * Renders until `condition` holds. A Command that writes to the repository returns long
 * before git, the store refresh, and React have caught up, and a fixed sleep would either
 * be flaky or slow. Timing out returns quietly, so the test's own `expect` reports the
 * failure with its own message.
 */
async function waitFor(harness: Harness, condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    await settle(harness)
    // Both the probe and the wait run inside `act`, because the store publish that ends
    // this loop lands while one of them is awaiting — outside `act` it is a React warning
    // and a render this loop then fails to see.
    let satisfied = false
    await act(async () => {
      satisfied = await condition()
      if (!satisfied) await Bun.sleep(20)
    })
    if (satisfied || Date.now() > deadline) return
  }
}

/**
 * Focuses the files Pane — which is also the `files.focus` binding under test.
 *
 * It is already the Layout's first cell and therefore already focused at startup; pressing
 * `2` anyway is what keeps the binding exercised, and keeps every Pane-scoped keypress
 * below reading the same whether or not the default ever changes.
 */
async function focusFiles(harness: Harness): Promise<void> {
  await press(harness, "1")
}

describe("staging from the files pane", () => {
  it("stages the selected file with space, and unstages it with space again", async () => {
    const harness = await createFilesHarness()
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("Unstaged")

    await press(harness, " ")
    await waitFor(harness, () => frame(harness).includes("Staged"))
    expect(await staged(harness)).toEqual(["tracked.txt"])
    expect(frame(harness)).not.toContain("Unstaged")

    // The row changed group and the cursor followed it there, so the same key reverses it.
    await press(harness, " ")
    await waitFor(harness, () => frame(harness).includes("Unstaged"))
    expect(await staged(harness)).toEqual([])
  })

  it("stages everything with a, including untracked files", async () => {
    const harness = await createFilesHarness()
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)

    await press(harness, "a")
    await waitFor(harness, async () => (await staged(harness)).length === 2)

    expect(await staged(harness)).toEqual(["loose.txt", "tracked.txt"])
    expect(frame(harness)).not.toContain("Untracked")
  })
})

describe("discarding from the files pane", () => {
  it("names the file, and says that discarding an untracked one deletes it", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)

    await press(harness, "d")
    expect(frame(harness)).toContain("Delete untracked file?")
    expect(frame(harness)).toContain("loose.txt is untracked — discarding it")

    await press(harness, "y")
    await waitFor(harness, () => frame(harness).includes("working tree clean"))
    expect(await Bun.file(join(harness.directory, "loose.txt")).exists()).toBe(false)
  })

  it("takes a staged-only change out of the index too, and says so before it does", async () => {
    const harness = await createFilesHarness()
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")
    await git(harness, "add", "tracked.txt")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("Staged")

    await press(harness, "d")
    // The working tree already matches the index, so `git restore --worktree` on its own
    // changes nothing at all: a danger confirmation followed by silence.
    expect(frame(harness)).toContain("Unstage tracked.txt and throw away its changes")

    await press(harness, "y")
    await waitFor(harness, () => frame(harness).includes("working tree clean"))
    expect(await staged(harness)).toEqual([])
    expect(await Bun.file(join(harness.directory, "tracked.txt")).text()).toBe("one\n")
  })

  it("deletes a staged new file, because HEAD has no version of it to come back to", async () => {
    const harness = await createFilesHarness()
    await write(harness, "fresh.txt", "brand new\n")
    await git(harness, "add", "fresh.txt")

    await renderApp(harness)
    await focusFiles(harness)

    await press(harness, "d")
    expect(frame(harness)).toContain("fresh.txt is not in HEAD")

    await press(harness, "y")
    await waitFor(harness, () => frame(harness).includes("working tree clean"))
    expect(await staged(harness)).toEqual([])
    expect(await Bun.file(join(harness.directory, "fresh.txt")).exists()).toBe(false)
  })

  it("keeps a tracked file's changes when the confirmation is declined", async () => {
    const harness = await createFilesHarness()
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")

    await renderApp(harness)
    await focusFiles(harness)

    await press(harness, "d")
    expect(frame(harness)).toContain("Throw away working-tree changes to tracked.txt.")

    await press(harness, "n")
    expect(await Bun.file(join(harness.directory, "tracked.txt")).text()).toBe("two\n")
    expect(frame(harness)).toContain("M tracked.txt")
  })
})

describe("the files action menu", () => {
  it("offers the file and all-files actions on an ordinary row", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "x")

    const rendered = frame(harness)
    expect(rendered).toContain("File: loose.txt")
    expect(rendered).toContain("  s  Stage")
    expect(rendered).toContain("  d  Discard changes")
    expect(rendered).toContain("  a  Stage all files")
    // An untracked file is not in the index, and conflict items belong to conflicted rows.
    expect(rendered).not.toContain("  u  Unstage")
    expect(rendered).not.toContain("Stage resolved")
  })

  it("runs a menu item against the row it was opened for", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")
    await write(harness, "other.txt", "also untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "j")
    await press(harness, "x")
    expect(frame(harness)).toContain("File: other.txt")

    await press(harness, "s")
    await waitFor(harness, async () => (await staged(harness)).length === 1)
    expect(await staged(harness)).toEqual(["other.txt"])
  })
})

describe("conflicts, shown and delegated", () => {
  /** An ordinary both-modified conflict: one file, two branches, one merge. */
  async function conflict(harness: Harness): Promise<void> {
    await write(harness, "shared.txt", "base\n")
    await commitTracked(harness, "shared.txt")
    await git(harness, "checkout", "--quiet", "-b", "theirs")
    await write(harness, "shared.txt", "theirs\n")
    await git(harness, "commit", "--quiet", "--all", "--message", "theirs")
    await git(harness, "checkout", "--quiet", "main")
    await write(harness, "shared.txt", "ours\n")
    await git(harness, "commit", "--quiet", "--all", "--message", "ours")
    // Expected to fail. The conflict is the point, so the exit code is not checked.
    await run(harness.directory, ["merge", "theirs"])
  }

  it("gives conflicted paths a group of their own", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)

    await renderApp(harness)

    expect(frame(harness)).toContain("Conflicted")
    expect(frame(harness)).toContain("! shared.txt")
  })

  it("hides staging and discarding on a conflicted row, and offers the two delegating items", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "x")

    const rendered = frame(harness)
    expect(rendered).toContain("File: shared.txt")
    expect(rendered).toContain("Conflict")
    expect(rendered).toContain("  o  Open in default application")
    expect(rendered).toContain("  m  Stage resolved")
    // Hidden, not greyed: half-resolving a conflict is not on offer here at all.
    expect(rendered).not.toContain("  s  Stage")
    expect(rendered).not.toContain("  d  Discard changes")
  })

  it("records a resolution when the menu's stage-resolved runs", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)
    // What resolving in the editor looks like from laziergit's side.
    await write(harness, "shared.txt", "ours and theirs\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "x")
    await press(harness, "m")

    await waitFor(harness, () => !frame(harness).includes("Conflicted"))
    expect(frame(harness)).not.toContain("Conflicted")
    expect(await staged(harness)).toEqual(["shared.txt"])
  })

  it("makes the key of an item whose when() is false inert rather than destructive", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "x")
    // `d` is "Discard changes", hidden on this row — so it does nothing at all.
    await press(harness, "d")

    expect(frame(harness)).toContain("  m  Stage resolved")
    expect(frame(harness)).not.toContain("Discard changes?")
  })
})

describe("what the files pane publishes", () => {
  it("shows the selection in the diff pane, and which side of it to diff", async () => {
    const harness = await createFilesHarness()
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("showing workingTree tracked.txt")

    await press(harness, " ")
    // Staged now, so the same path wants the other side of the diff.
    await waitFor(harness, () => frame(harness).includes("showing staged tracked.txt"))
    expect(frame(harness)).toContain("showing staged tracked.txt")
  })

  it("leaves the diff alone while another pane is focused", async () => {
    const harness = await createFilesHarness()
    await write(harness, "first.txt", "a\n")
    await write(harness, "second.txt", "b\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("showing workingTree first.txt")

    await press(harness, "\t")
    await press(harness, "j")

    // `j` belongs to the files pane, so the cursor never moved and nothing was pushed.
    expect(frame(harness)).toContain("❯ ? first.txt")
    expect(frame(harness)).toContain("showing workingTree first.txt")
  })

  it("stops naming a row once the layout has tabbed the pane away", async () => {
    const harness = await createFilesHarness(tabbedLayout)
    await writeFile(join(harness.repo, "labels.tsx"), decoratorStub)
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "V")
    expect(frame(harness)).toContain("selected loose.txt")

    // `]` brings the diff tab up, which unmounts this Pane. A Pane that is not on screen
    // has no selection, and `FilesApi.selected()` must not keep naming the row it had —
    // the same window a hot reload opens between unmount and scope disposal.
    await press(harness, "]")
    await press(harness, "V")

    expect(frame(harness)).toContain("selected none")
  })

  it("exports a row source another extension decorates and reads the selection from", async () => {
    const harness = await createFilesHarness()
    await writeFile(join(harness.repo, "labels.tsx"), decoratorStub)
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("? loose.txt new!")
    expect(frame(harness)).not.toContain("tracked.txt new!")

    await press(harness, "V")
    expect(frame(harness)).toContain("selected tracked.txt")
  })
})
