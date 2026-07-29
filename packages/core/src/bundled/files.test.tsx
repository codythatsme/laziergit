import { describe, expect, it } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  highlighted,
  installHarnessLifecycle,
  renderApp,
  settle,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

/** The same directory `main.tsx` hands the kernel as the bundled scope. */
const bundledExtensionDirectory = resolve(import.meta.dir, "..", "..", "..", "..", "extensions")

/**
 * `files` declares `needs: ["diff"]`. A repo-scope Extension named `diff` shadows the bundled
 * one (§0) and satisfies the need with a `DiffApi` that prints what it was shown.
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
 * A key press, and the real time its consequences take: the terminal parser only settles a
 * lone escape byte once it has waited for the sequence it could start, and a Command that
 * writes returns long before git does. The wait is inside `act`.
 */
async function press(harness: Harness, key: string): Promise<void> {
  await act(async () => {
    harness.setup.mockInput.pressKey(key)
    await Bun.sleep(150)
  })
  await settle(harness)
}

/**
 * Renders until `condition` holds, since a Command that writes returns long before git, the
 * store, and React have caught up. Timing out returns quietly, leaving the test's own
 * `expect` to report the failure.
 */
async function waitFor(harness: Harness, condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    await settle(harness)
    // Both the probe and the wait run inside `act`: the store publish that ends this loop
    // lands while one of them is awaiting.
    let satisfied = false
    await act(async () => {
      satisfied = await condition()
      if (!satisfied) await Bun.sleep(20)
    })
    if (satisfied || Date.now() > deadline) return
  }
}

/**
 * Focuses the files Pane — which is also the `files.focus` binding under test. It is already
 * the Layout's first cell, so pressing `2` is what keeps the binding exercised.
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
    expect(highlighted(harness)).toEqual([" M tracked.txt"])

    await press(harness, " ")
    await waitFor(harness, () => frame(harness).includes("M  tracked.txt"))
    expect(await staged(harness)).toEqual(["tracked.txt"])

    // The row's columns flipped and the cursor never moved, because it anchors on the path.
    expect(highlighted(harness)).toEqual(["M  tracked.txt"])
    await press(harness, " ")
    await waitFor(harness, () => frame(harness).includes(" M tracked.txt"))
    expect(await staged(harness)).toEqual([])

    for (const heading of ["Conflicted", "Staged", "Unstaged", "Untracked"]) {
      expect(frame(harness)).not.toContain(heading)
    }
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
    await waitFor(harness, () => frame(harness).includes("▶  src"))
    expect(frame(harness)).not.toContain("a.txt")

    await press(harness, "\r")
    await waitFor(harness, () => frame(harness).includes("??   a.txt"))
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
    await waitFor(harness, () => highlighted(harness).includes("??     b.txt"))

    // Collapse-all removes the row the cursor was on, so it lands on the deepest visible
    // ancestor rather than wherever the old index now points.
    await press(harness, "-")
    await waitFor(harness, () => highlighted(harness).includes("▶  src"))
  })

  it("stages a whole directory with space, and unstages it again", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/a.txt", "a\n")
    await write(harness, "src/nested/b.txt", "b\n")

    await renderApp(harness)
    await focusFiles(harness)

    await press(harness, " ")
    await waitFor(harness, async () => (await staged(harness)).length === 2)
    expect(await staged(harness)).toEqual(["src/a.txt", "src/nested/b.txt"])

    await press(harness, " ")
    await waitFor(harness, async () => (await staged(harness)).length === 0)
  })

  it("toggles between the tree and a flat list of full paths", async () => {
    const harness = await createFilesHarness()
    await write(harness, "src/nested/b.txt", "b\n")

    await renderApp(harness)
    await focusFiles(harness)
    expect(frame(harness)).toContain("▼  src/nested")

    await press(harness, "`")
    await waitFor(harness, () => frame(harness).includes("?? src/nested/b.txt"))
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
    await waitFor(harness, async () => (await staged(harness)).length === 2)

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
    // Staged and nothing since, which is why `d` has to unstage before it restores.
    expect(highlighted(harness)).toEqual(["M  tracked.txt"])

    await press(harness, "d")
    // The working tree already matches the index, so `git restore --worktree` alone would
    // change nothing: a danger confirmation followed by silence.
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
    expect(rendered).toMatch(/ {2}s {2,}Stage/)
    expect(rendered).toMatch(/ {2}d {2,}Discard changes/)
    expect(rendered).toMatch(/ {2}o {2,}Open in default application/)
    expect(rendered).toMatch(/ {2}a {2,}Stage all files/)
    // An untracked file is not in the index, and conflict items belong to conflicted rows.
    expect(rendered).not.toContain("  u  Unstage")
    expect(rendered).not.toContain("Stage resolved")
  })

  /** `o` is what a lazygit user reaches for; `e` stays reserved for editing in `$EDITOR`. */
  it("binds opening to o, in the pane as well as the menu", async () => {
    const harness = await createFilesHarness()
    await write(harness, "loose.txt", "untracked\n")

    await renderApp(harness)
    await focusFiles(harness)
    await press(harness, "?")

    const sheet = frame(harness)
    expect(sheet).toMatch(/ {2}o {2,}Open file in default application/)
    expect(sheet).not.toMatch(/ {2}e {2,}Open file/)
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

  it("draws a conflicted path with git's own pair, wherever it sits in the tree", async () => {
    const harness = await createFilesHarness()
    await conflict(harness)

    await renderApp(harness)

    // `UU` — both sides modified. Which side did what is the whole content of the row.
    expect(frame(harness)).toContain("UU shared.txt")
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
    expect(rendered).toMatch(/ {2}o {2,}Open in default application/)
    expect(rendered).toMatch(/ {2}m {2,}Stage resolved/)
    // Hidden, not greyed: half-resolving a conflict is not on offer here at all.
    expect(rendered).not.toMatch(/ {2}s {2,}Stage/)
    expect(rendered).not.toMatch(/ {2}d {2,}Discard changes/)
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

    await waitFor(harness, () => !frame(harness).includes("UU"))
    expect(frame(harness)).not.toContain("UU")
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

    expect(frame(harness)).toMatch(/ {2}m {2,}Stage resolved/)
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
    // The jump key reaches this Pane even though it starts behind the diff tab — a hidden
    // tab has a digit like any other Pane, and using it brings the tab to the front.
    await focusFiles(harness)
    await press(harness, "V")
    expect(frame(harness)).toContain("selected loose.txt")

    // `]` brings the diff tab up, which unmounts this Pane. A Pane that is not on screen has
    // no selection, and `FilesApi.selected()` must not keep naming the row it had.
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
    expect(frame(harness)).toContain("?? loose.txt new!")
    expect(frame(harness)).not.toContain("tracked.txt new!")

    // Rows are in path order, not group order, so `loose.txt` is first.
    await press(harness, "V")
    expect(frame(harness)).toContain("selected loose.txt")
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
    expect(frame(harness)).toContain("selected none")

    await press(harness, "j")
    await press(harness, "V")
    expect(frame(harness)).toContain("selected src/a.txt")
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
    await act(async () => {
      await harness.setup.mockInput.typeText("banana")
      await Bun.sleep(60)
    })
    await settle(harness)

    const rendered = frame(harness)
    expect(rendered).toContain("Filter: banana")
    expect(rendered).toContain("docs")
    expect(rendered).toContain("banana.md")
    expect(rendered).not.toContain("src")
    expect(rendered).not.toContain("apple.ts")
  })
})
