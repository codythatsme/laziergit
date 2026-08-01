import { describe, expect, it } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  highlighted,
  installHarnessLifecycle,
  press,
  renderApp,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

/** The same directory `main.tsx` hands the kernel as the bundled scope. */
const bundledExtensionDirectory = resolve(import.meta.dir, "..", "..", "..", "..", "extensions")

/**
 * `files` declares `needs: ["diff"]`. A repo-scope Extension named `diff` shadows the bundled
 * one and satisfies the need with a `DiffApi` that prints what it was shown.
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
  import { defineExtension, isUntracked } from "laziergit"

  export default defineExtension({
    name: "labels",
    needs: ["files"],
    activate(ctx) {
      const files = ctx.extensions.get("files")
      files.decorateRows((change) => (isUntracked(change) ? { badge: "new!", tone: "info" } : undefined))
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

/** Creates parent directories, so a fixture can spell a nested path and get a tree from it. */
async function write(harness: Harness, path: string, contents: string): Promise<void> {
  const full = join(harness.directory, path)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, contents)
}

/**
 * Paths git currently reports as staged — the assertion most of these tests really make. Read
 * only after the store or the frame has confirmed the write landed: `git diff` refreshes the
 * index, and its lock can fail a write still in flight.
 */
async function staged(harness: Harness): Promise<readonly string[]> {
  const output = await git(harness, "diff", "--cached", "--name-only")
  return output.split("\n").filter((line) => line.length > 0)
}

/** The store's view of which paths sit in the index, for waiting a staging write out. */
function stagedInStore(harness: Harness): readonly string[] {
  return harness.kernel.git
    .getSnapshot()
    .status.files.filter((file) => file.kind === "changed" && file.index !== null)
    .map((file) => file.path)
}

/** Side by side, which is what every test here reads unless it is about tabbing. */
const columnsLayout = `[["files"], ["diff"]]`
/** One cell, two tabs: the arrangement in which showing the diff *unmounts* the files Pane. */
const tabbedLayout = `[[["files", "diff"]]]`

/**
 * The poll is disabled: every change these tests make either predates the first read or goes
 * through laziergit, and a tick would only republish the same state outside React's `act`.
 */
function configOf(layout: string): string {
  return `{ "layout": { "columns": ${layout} }, "git": { "refreshIntervalMs": 60000 } }`
}

/**
 * A harness whose repository root is the harness directory, with the real `extensions/files`
 * linked into the bundled scope. The `.gitignore` is committed first because that directory
 * is also the Extension and config home.
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
 * Focuses the files Pane — which is also the `files.focus` binding under test. It is already
 * the Layout's first cell, so pressing `1` is what keeps the binding exercised.
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
    // Two status columns, `X` then `Y`, as git spells them: the change is in the working
    // tree, so the letter is in the second column.
    await waitFor(harness, () => highlighted(harness).length > 0, "the focused pane to light its cursor")
    expect(highlighted(harness)).toEqual([" M tracked.txt"])

    await press(harness, " ")
    await waitForFrame(harness, "M  tracked.txt")
    expect(await staged(harness)).toEqual(["tracked.txt"])

    // The row's columns flipped and the cursor never moved, because it anchors on the path.
    expect(highlighted(harness)).toEqual(["M  tracked.txt"])
    await press(harness, " ")
    await waitForFrame(harness, " M tracked.txt")
    expect(await staged(harness)).toEqual([])

    for (const heading of ["Conflicted", "Staged", "Unstaged", "Untracked"]) {
      expect(frame(harness)).not.toContain(heading)
    }
  })

  it("unstages a partially staged file with u without losing its working-tree edit", async () => {
    const harness = await createFilesHarness()
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")
    await git(harness, "add", "tracked.txt")
    await write(harness, "tracked.txt", "three\n")

    await renderApp(harness)
    await focusFiles(harness)
    await waitForFrame(harness, "MM tracked.txt")

    await press(harness, "u")
    await waitFor(harness, () => stagedInStore(harness).length === 0, "the selected file to leave the index")
    expect(await staged(harness)).toEqual([])
    expect(await Bun.file(join(harness.directory, "tracked.txt")).text()).toBe("three\n")
    expect(frame(harness)).toContain(" M tracked.txt")
  })

  it("draws one row per path under its directory, indented", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/a.txt", "a\n")
    await write(harness, "src/nested/b.txt", "b\n")
    await write(harness, "top.txt", "top\n")

    await renderApp(harness)
    await focusFiles(harness)

    const rendered = frame(harness)
    // The `XY` pair sits in the same two columns on every row and only the name indents, so
    // the column you scan for "is this staged?" never moves with folder depth.
    expect(rendered).toContain("▼  src")
    expect(rendered).toContain("??   a.txt")
    expect(rendered).toContain("▼    nested")
    expect(rendered).toContain("??     b.txt")
    expect(rendered).toContain("?? top.txt")
    // Folders first, then paths: `nested` precedes its sibling file, and the root file is
    // last rather than first.
    expect(rendered.indexOf("nested")).toBeLessThan(rendered.indexOf("a.txt"))
    expect(rendered.indexOf("a.txt")).toBeLessThan(rendered.indexOf("top.txt"))
  })

  it("compresses a single-child directory chain into one row", async () => {
    const harness = await createFilesHarness()
    await write(harness, "a/b/c.txt", "c\n")

    await renderApp(harness)
    await focusFiles(harness)

    expect(frame(harness)).toContain("▼  a/b")
    expect(frame(harness)).toContain("??   c.txt")
  })

  it("collapses a directory with return and hides its descendants", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/a.txt", "a\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("??   a.txt")

    await press(harness, "\r")
    await waitForFrame(harness, "▶  src")
    expect(frame(harness)).not.toContain("a.txt")

    await press(harness, "\r")
    await waitForFrame(harness, "??   a.txt")
  })

  it("keeps the cursor on the same node when a directory above it collapses", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/a.txt", "a\n")
    await write(harness, "src/nested/b.txt", "b\n")

    await renderApp(harness)
    await focusFiles(harness)
    // Folders before files, so the nested chain comes before `a.txt` rather than after it.
    await press(harness, "j")
    await press(harness, "j")
    await waitFor(harness, () => highlighted(harness).includes("??     b.txt"), "the cursor to reach b.txt")

    // Collapse-all removes the row the cursor was on, so it lands on the deepest visible
    // ancestor rather than wherever the old index now points.
    await press(harness, "-")
    await waitFor(harness, () => highlighted(harness).includes("▶  src"), "the cursor to land on the folded folder")
  })

  it("stages a whole directory with space, and unstages it again", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/a.txt", "a\n")
    await write(harness, "src/nested/b.txt", "b\n")

    await renderApp(harness)
    await focusFiles(harness)

    await press(harness, " ")
    await waitFor(harness, () => stagedInStore(harness).length === 2, "both files to reach the index")
    expect(await staged(harness)).toEqual(["src/a.txt", "src/nested/b.txt"])

    await press(harness, " ")
    await waitFor(harness, () => stagedInStore(harness).length === 0, "the directory to leave the index")
    expect(await staged(harness)).toEqual([])
  })

  it("unstages the staged part of a mixed directory with u", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/staged.txt", "one\n")
    await write(harness, "src/unstaged.txt", "one\n")
    await commitTracked(harness, "src/staged.txt", "src/unstaged.txt")
    await write(harness, "src/staged.txt", "two\n")
    await git(harness, "add", "src/staged.txt")
    await write(harness, "src/unstaged.txt", "two\n")

    await renderApp(harness)
    await focusFiles(harness)
    await waitForFrame(harness, "▼~ src")

    await press(harness, "u")
    await waitFor(harness, () => stagedInStore(harness).length === 0, "the selected directory to leave the index")
    expect(await staged(harness)).toEqual([])
    expect(await Bun.file(join(harness.directory, "src/unstaged.txt")).text()).toBe("two\n")
  })

  it("toggles between the tree and a flat list of full paths", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/nested/b.txt", "b\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("▼  src/nested")

    await press(harness, "`")
    await waitForFrame(harness, "?? src/nested/b.txt")
    expect(frame(harness)).not.toContain("▼")
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
    await waitFor(harness, () => stagedInStore(harness).length === 2, "both files to reach the index")

    expect(await staged(harness)).toEqual(["loose.txt", "tracked.txt"])
    // Nothing is left on the working-tree side, so no row draws git's untracked pair.
    expect(frame(harness)).not.toContain("??")
  })
})

describe("discarding from the files pane", () => {
  it("names the file, and says that discarding an untracked one deletes it", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)

    await press(harness, "d")
    await waitForFrame(harness, "Delete untracked file?")
    expect(frame(harness)).toContain("loose.txt is untracked — discarding it")

    await press(harness, "y")
    await waitForFrame(harness, "working tree clean")
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
    // Staged and nothing since, which is why `d` has to unstage before it restores.
    await waitFor(harness, () => highlighted(harness).length > 0, "the focused pane to light its cursor")
    expect(highlighted(harness)).toEqual(["M  tracked.txt"])

    await press(harness, "d")
    // The working tree already matches the index, so `git restore --worktree` alone would
    // change nothing: a danger confirmation followed by silence.
    await waitForFrame(harness, "Unstage tracked.txt and throw away its changes")

    await press(harness, "y")
    await waitForFrame(harness, "working tree clean")
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
    await waitForFrame(harness, "fresh.txt is not in HEAD")

    await press(harness, "y")
    await waitForFrame(harness, "working tree clean")
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
    await waitForFrame(harness, "Throw away working-tree changes to tracked.txt.")

    await press(harness, "n")
    // The popup leaving is the decline's only effect; nothing reaches git behind it.
    await waitForFrame(harness, (screen) => !screen.includes("Throw away working-tree changes"))
    expect(await Bun.file(join(harness.directory, "tracked.txt")).text()).toBe("two\n")
    expect(frame(harness)).toContain("M tracked.txt")
  })
})

describe("the files Command catalog", () => {
  it("publishes the file and all-files actions without an x menu", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    await waitForFrame(harness, "loose.txt")

    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).toContain("files.toggle-stage")
    expect(commands).not.toContain("files.unstage-selected")
    expect(commands).toContain("files.discard")
    expect(commands).toContain("files.open")
    expect(commands).toContain("files.stage-all")
    expect(commands).toContain("files.unstage-all")
    expect(commands).toContain("files.discard-all")
    expect(commands).not.toContain("files.menu")

    await press(harness, "x")
    expect(harness.kernel.popups.top).toBeUndefined()
  })

  /** `o` is what a lazygit user reaches for; `e` stays reserved for editing in `$EDITOR`. */
  it("binds opening to o in the pane", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "?")
    await waitForFrame(harness, "Open selected path in default application")

    const sheet = frame(harness)
    expect(sheet).toMatch(/ {2}o {2,}Open selected path in default application/)
    expect(sheet).not.toMatch(/ {2}e {2,}Open file/)
  })

  it("runs the direct stage Command against the selected row", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")
    await write(harness, "other.txt", "also untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "j")
    await waitForFrame(harness, "showing workingTree other.txt")

    await press(harness, " ")
    await waitFor(harness, () => stagedInStore(harness).length === 1, "the staging to reach the index")
    expect(await staged(harness)).toEqual(["other.txt"])
  })

  it("runs the former all-files actions directly with r and shift+d", async () => {
    const harness = await createFilesHarness()
    await write(harness, "tracked.txt", "one\n")
    await commitTracked(harness, "tracked.txt")
    await write(harness, "tracked.txt", "two\n")
    await git(harness, "add", "tracked.txt")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "r")
    await waitFor(harness, () => stagedInStore(harness).length === 0, "unstage-all to reach the index")
    expect(harness.kernel.popups.top).toBeUndefined()

    await press(harness, "D")
    await waitForFrame(harness, "Discard all working-tree changes?")
    await press(harness, "y")
    await waitFor(harness, () => harness.kernel.git.getSnapshot().status.files.length === 0, "discard-all to finish")
    expect(await Bun.file(join(harness.directory, "tracked.txt")).text()).toBe("one\n")
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

  it("draws a conflicted path with git's own pair, wherever it sits in the tree", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)

    await renderApp(harness)

    // `UU` — both sides modified. Which side did what is the whole content of the row.
    expect(frame(harness)).toContain("UU shared.txt")
  })

  it("keeps conflict handling in direct Commands, without opening an x menu", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "x")
    expect(harness.kernel.popups.top).toBeUndefined()
    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).toContain("files.toggle-stage")
    expect(commands).toContain("files.open")
    expect(commands).not.toContain("files.discard")
    expect(commands).not.toContain("files.menu")
  })

  it("records a resolution when the direct stage Command runs", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)
    // What resolving in the editor looks like from laziergit's side.
    await write(harness, "shared.txt", "ours and theirs\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, " ")

    // Waited on through the store rather than the frame: the popup can cover the row, so the
    // conflict pair leaving the screen would not prove the write landed.
    await waitFor(
      harness,
      () => harness.kernel.git.getSnapshot().status.files.every((file) => file.kind !== "conflicted"),
      "the resolution to reach the index",
    )
    expect(frame(harness)).not.toContain("UU")
    expect(await staged(harness)).toEqual(["shared.txt"])
  })

  it("leaves the retired x key inert on a conflicted row", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "x")

    expect(harness.kernel.popups.top).toBeUndefined()
    expect(frame(harness)).toContain("UU shared.txt")
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
    await waitForFrame(harness, "showing workingTree tracked.txt")

    await press(harness, " ")
    // Staged now, so the same path wants the other side of the diff.
    await waitForFrame(harness, "showing staged tracked.txt")
  })

  it("leaves the diff alone while another pane is focused", async () => {
    const harness = await createFilesHarness()
    await write(harness, "first.txt", "a\n")
    await write(harness, "second.txt", "b\n")

    await renderApp(harness)
    await focusFiles(harness)
    await waitForFrame(harness, "showing workingTree first.txt")

    await press(harness, "\t")
    await waitFor(harness, () => highlighted(harness).length === 0, "focus to leave the files pane")
    await press(harness, "j")

    // `j` belongs to the files pane, so the cursor never moved. The pane is unfocused now,
    // so the diff it last published is the only witness.
    expect(highlighted(harness)).toEqual([])
    expect(frame(harness)).toContain("showing workingTree first.txt")
  })

  it("stops naming a row once the layout has tabbed the pane away", async () => {
    const harness = await createFilesHarness(tabbedLayout)
    await writeFile(join(harness.repo, "labels.tsx"), decoratorStub)
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    // Diff activates first because Files depends on it, so the cell initially remembers Diff.
    // Repeating the cell's digit cycles to Files.
    await focusFiles(harness)
    await press(harness, "V")
    await waitForFrame(harness, "selected loose.txt")

    // `]` brings the diff tab up, which unmounts this Pane. A Pane that is not on screen has
    // no selection, and `FilesApi.selected()` must not keep naming the row it had.
    await press(harness, "]")
    await waitForFrame(harness, (screen) => !screen.includes("?? loose.txt"))
    await press(harness, "V")

    await waitForFrame(harness, "selected none")
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
    expect(frame(harness)).toContain("?? loose.txt new!")
    expect(frame(harness)).not.toContain("tracked.txt new!")

    // Rows are in path order, not group order, so `loose.txt` is first.
    await press(harness, "V")
    await waitForFrame(harness, "selected loose.txt")
  })

  it("publishes no selection while the cursor is on a directory row", async () => {
    const harness = await createFilesHarness()
    await writeFile(join(harness.repo, "labels.tsx"), decoratorStub)
    await write(harness, "src/a.txt", "a\n")

    await renderApp(harness)
    await focusFiles(harness)

    // A directory is not a `FileChange`, so `FilesApi.selected()` has nothing to return for
    // one — and a `decorateRows` provider is never handed a folder.
    await press(harness, "V")
    await waitForFrame(harness, "selected none")

    await press(harness, "j")
    await press(harness, "V")
    await waitForFrame(harness, "selected src/a.txt")
  })
})

describe("filtering the files pane", () => {
  it("filters paths live while retaining the matching file's directory row", async () => {
    const harness = await createFilesHarness()
    await write(harness, "docs/banana.md", "banana\n")
    await write(harness, "src/apple.ts", "apple\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("banana.md")
    expect(frame(harness)).toContain("apple.ts")

    await press(harness, "/")
    await waitForFrame(harness, "Filter:")
    await press(harness, () => void harness.setup.mockInput.typeText("banana"))
    await waitForFrame(harness, "Filter: banana")

    const rendered = frame(harness)
    expect(rendered).toContain("docs")
    expect(rendered).toContain("banana.md")
    expect(rendered).not.toContain("src")
    expect(rendered).not.toContain("apple.ts")
  })
})
