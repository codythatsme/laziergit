import { describe, expect, it, spyOn } from "bun:test"
import { rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { fetchFor } from "../../../../extensions/diff/fetch"
import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  renderApp,
  runCommand,
  settle,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

/** The same directory `main.tsx` hands the kernel as the bundled scope. */
const bundledExtensionDirectory = resolve(import.meta.dir, "..", "..", "..", "..", "extensions")

/**
 * Stands in for the four list Panes: `show` is the only way into the `diff` Extension, and it
 * has to be called from another Extension's own `activate` scope.
 */
const driverSource = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "driver",
    needs: ["diff"],
    activate(ctx) {
      const diff = ctx.extensions.get("diff")
      const head = () => {
        const state = ctx.git.state.head
        return state.kind === "onBranch" ? state.oid : ""
      }

      ctx.commands.register({
        id: "driver.working-file",
        title: "Diff a working-tree file",
        run: () => diff.show({ kind: "workingTree", path: "tracked.txt" }),
      })
      ctx.commands.register({
        id: "driver.working-tree",
        title: "Diff the whole working tree",
        run: () => diff.show({ kind: "workingTree", path: null }),
      })
      ctx.commands.register({
        id: "driver.glob-file",
        title: "Diff a file whose name reads as a glob",
        run: () => diff.show({ kind: "workingTree", path: "glob[1].txt" }),
      })
      ctx.commands.register({
        id: "driver.untracked",
        title: "Diff an untracked file",
        run: () => diff.show({ kind: "workingTree", path: "untracked.txt" }),
      })
      ctx.commands.register({
        id: "driver.staged-file",
        title: "Diff a staged file",
        run: () => diff.show({ kind: "staged", path: "tracked.txt" }),
      })
      ctx.commands.register({
        id: "driver.open-staging",
        title: "Open interactive staging",
        run: () => diff.openStaging?.("tracked.txt"),
      })
      ctx.commands.register({
        id: "driver.open-new-staging",
        title: "Open interactive staging for a new file",
        run: () => diff.openStaging?.("new.txt"),
      })
      ctx.commands.register({
        id: "driver.open-conflict",
        title: "Open conflict picker",
        run: () => diff.openConflict?.("tracked.txt"),
      })
      ctx.commands.register({
        id: "driver.head-commit",
        title: "Diff the HEAD commit",
        run: () => diff.show({ kind: "commit", ref: head(), path: null }),
      })
      ctx.commands.register({
        id: "driver.head-commit-file",
        title: "Diff one path in the HEAD commit",
        run: () => diff.show({ kind: "commit", ref: head(), path: "tracked.txt" }),
      })
      ctx.commands.register({
        id: "driver.stash",
        title: "Diff the top stash entry",
        run: () => diff.show({ kind: "stash", ref: "stash@{0}", path: null }),
      })
      ctx.commands.register({
        id: "driver.stash-file",
        title: "Diff one path in the top stash entry",
        run: () => diff.show({ kind: "stash", ref: "stash@{0}", path: "tracked.txt" }),
      })
    },
  })
`

function realGit(): string {
  const found = Bun.which("git")
  if (found === null) throw new Error("git is not on PATH")
  return found
}

/** Fixture git, run through the real binary so it never lands in the recording below. */
async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn([realGit(), ...args], {
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
  // A broken fixture is not a test result, so it fails here rather than as a puzzling argv.
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
  return stdout
}

async function gitAllowFailure(harness: Harness, ...args: readonly string[]): Promise<number> {
  const child = Bun.spawn([realGit(), ...args], {
    cwd: harness.directory,
    env: { ...process.env, ...gitIsolationEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return exitCode
}

interface DiffHarness {
  readonly harness: Harness
  show(command: string): Promise<void>
}

/**
 * The diff Pane and the driver over a repository with one commit. The `.gitignore` covers the
 * harness's own scaffolding, which would otherwise show up as untracked files.
 */
async function createDiffHarness(): Promise<DiffHarness> {
  const harness = await createHarness({ git: true })
  await symlink(join(bundledExtensionDirectory, "diff"), join(harness.bundled, "diff"))
  await writeFile(join(harness.repo, "driver.ts"), driverSource)
  await writeFile(
    harness.configFiles.repo,
    // The poll is off: every fixture is complete before the kernel starts, so a tick could
    // only issue an unrelated second fetch while an integration assertion reads the frame.
    `{ "layout": { "columns": [["diff"]] }, "git": { "refreshIntervalMs": 60000 } }`,
  )
  await writeFile(join(harness.directory, ".gitignore"), "global/\nrepo/\nbundled/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "seed.txt"), "seed\n")
  await writeFile(join(harness.directory, "tracked.txt"), "one\ntwo\nthree\n")
  // A file whose name is also a pathspec pattern, and the file that pattern would catch.
  await writeFile(join(harness.directory, "glob[1].txt"), "bracket\n")
  await writeFile(join(harness.directory, "glob1.txt"), "decoy\n")
  await git(harness, "add", ".gitignore", "seed.txt", "tracked.txt", "glob1.txt", ":(literal)glob[1].txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")

  return {
    harness,
    async show(command) {
      await renderApp(harness)
      await runCommand(harness, command)
    },
  }
}

/**
 * Stalls only the diff Pane's fetches — `--no-ext-diff` is on every one of them and on no call
 * core makes — so a test can read the screen mid-fetch.
 */
function installSlowDiffGit(harness: Harness, milliseconds: number): void {
  const raw = harness.kernel.git.raw.bind(harness.kernel.git)
  spyOn(harness.kernel.git, "raw").mockImplementation(async (argv, options) => {
    // oxlint-disable-next-line no-restricted-properties -- the stall is the fixture, not a wait
    if (argv.includes("--no-ext-diff")) await Bun.sleep(milliseconds)
    return raw(argv, options)
  })
}

function argvFor(
  target: Parameters<typeof fetchFor>[0],
  context = 3,
  untracked: readonly string[] = [],
): readonly string[] {
  return fetchFor(target, context, new Set(untracked)).argv
}

describe("the git the diff pane asks for", () => {
  it("diffs one working-tree path against the index", () => {
    // `:(literal)` because every path git takes is a pattern — see the glob case below.
    expect(argvFor({ kind: "workingTree", path: "tracked.txt" })).toEqual([
      "diff",
      "--no-ext-diff",
      "-U3",
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("diffs the whole side when the target names no path", () => {
    // No pathspec at all, rather than one that matches everything: a Pane whose selection is
    // not a single file should show the side, not an empty diff.
    expect(argvFor({ kind: "workingTree", path: null })).toEqual(["diff", "--no-ext-diff", "-U3"])
  })

  it("wraps a path that reads as a glob so it cannot match its neighbour", async () => {
    // Unwrapped, `glob[1].txt` is a pattern that also matches `glob1.txt`, so the Pane would
    // diff a file the user never selected alongside the one they did.
    expect(argvFor({ kind: "workingTree", path: "glob[1].txt" })).toEqual([
      "diff",
      "--no-ext-diff",
      "-U3",
      "--",
      ":(literal)glob[1].txt",
    ])

    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "glob[1].txt"), "bracket changed\n")
    await writeFile(join(diff.harness.directory, "glob1.txt"), "decoy changed\n")
    await diff.show("driver.glob-file")

    await waitForFrame(diff.harness, "bracket changed")
    expect(frame(diff.harness)).not.toContain("decoy")
  }, 30_000)

  it("diffs an untracked file against /dev/null, outside the index entirely", () => {
    // Plain `git diff` prints nothing for an untracked path. `--no-index` takes filesystem
    // paths rather than pathspecs, which is why this one is not wrapped in `:(literal)`.
    expect(argvFor({ kind: "workingTree", path: "untracked.txt" }, 3, ["untracked.txt"])).toEqual([
      "diff",
      "--no-index",
      "--no-ext-diff",
      "-U3",
      "--",
      "/dev/null",
      "untracked.txt",
    ])
  })

  it("diffs the index against HEAD for a staged target", () => {
    expect(argvFor({ kind: "staged", path: "tracked.txt" })).toEqual([
      "diff",
      "--cached",
      "--no-ext-diff",
      "-U3",
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("shows a commit with its own header, always against its first parent", () => {
    // `--pretty=medium` keeps the header a clipped one-line row cannot show; `splitPatch`
    // lifts it off rather than letting `<diff>` parse it as a file section. `--first-parent`
    // is byte-identical to no flag on an ordinary commit, and rides along for the merge below.
    expect(argvFor({ kind: "commit", ref: "deadbeef", path: "tracked.txt" })).toEqual([
      "show",
      "--pretty=medium",
      "--no-ext-diff",
      "-U3",
      "--first-parent",
      "deadbeef",
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("keeps show read-only for a whole stash entry by putting show straight after stash", () => {
    // The service reads the argv element directly after the subcommand as its operand, and
    // only the exact pair `stash show` is on its read-only list.
    expect(argvFor({ kind: "stash", ref: "stash@{0}", path: null })).toEqual([
      "stash",
      "show",
      "-p",
      "--no-ext-diff",
      "-U3",
      "stash@{0}",
    ])
  })

  it("narrows a stash through its first parent, which stash show cannot be asked to do", () => {
    // `git stash show <ref> -- <path>` exits with "Too many revisions specified"; the diff
    // against the entry's first parent is the same patch and does take a pathspec.
    expect(argvFor({ kind: "stash", ref: "stash@{0}", path: "tracked.txt" })).toEqual([
      "diff",
      "--no-ext-diff",
      "-U3",
      "stash@{0}^1",
      "stash@{0}",
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("carries the configured context into the invocation", () => {
    expect(argvFor({ kind: "workingTree", path: "tracked.txt" }, 0)).toContain("-U0")
  })
})

describe("splitting git's patch into one section per file", () => {
  it("names every file a commit touched, including the one it deleted", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "alpha.txt"), "alpha\n")
    await git(diff.harness, "add", "alpha.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "alpha")
    await writeFile(join(diff.harness.directory, "alpha.txt"), "alpha changed\n")
    await writeFile(join(diff.harness.directory, "beta.txt"), "beta\n")
    await git(diff.harness, "rm", "--quiet", "seed.txt")
    await git(diff.harness, "add", "alpha.txt", "beta.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "three files")

    await diff.show("driver.head-commit")

    // `<diff>` renders `patches[0]` and nothing else, so the second and third files are on
    // screen only because the patch was split.
    await waitForFrame(diff.harness, "beta.txt")
    const screen = frame(diff.harness)
    expect(screen).toContain("alpha.txt")
    // A deletion writes `+++ /dev/null`, so this one is named only by the fallback to the
    // `--- a/` side — without it its row would read "(unnamed)".
    expect(screen).toContain("seed.txt")
  }, 30_000)

  it("renders a merge commit, which git shows nothing for unless told which parent to use", async () => {
    const diff = await createDiffHarness()
    await git(diff.harness, "checkout", "--quiet", "-b", "side")
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nmerged\nthree\n")
    await writeFile(join(diff.harness.directory, "side.txt"), "side\n")
    await git(diff.harness, "add", "tracked.txt", "side.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "side")
    await git(diff.harness, "checkout", "--quiet", "main")
    await git(diff.harness, "merge", "--quiet", "--no-ff", "--no-edit", "side")

    await diff.show("driver.head-commit")

    // Without `--first-parent` git suppresses a merge's diff outright.
    await waitForFrame(diff.harness, "+ merged")
    const screen = frame(diff.harness)
    expect(screen).toContain("side.txt")
    expect(screen).not.toContain("no changes")
  }, 30_000)

  it("shows an untracked file's contents rather than reading git's exit code as failure", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "untracked.txt"), "brand\nnew\n")

    await diff.show("driver.untracked")

    // `--no-index` exits 1 to mean "the two files differ", the ordinary answer here.
    await waitForFrame(diff.harness, "+ brand")
    const screen = frame(diff.harness)
    expect(screen).toContain("+ new")
    expect(screen).not.toContain("no changes")
  }, 30_000)
})

describe("moving from one target to the next", () => {
  it("holds the patch on screen until the next one has arrived", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nTWO\nthree\n")
    await writeFile(join(diff.harness.directory, "untracked.txt"), "brand\nnew\n")
    installSlowDiffGit(diff.harness, 400)
    await renderApp(diff.harness)

    await runCommand(diff.harness, "driver.working-file")
    await waitForFrame(diff.harness, "+ TWO")

    await runCommand(diff.harness, "driver.untracked")

    // The Pane has been pointed at a target git has not answered for yet.
    const during = frame(diff.harness)
    expect(during).toContain("+ TWO")
    expect(during).not.toContain("loading")

    await waitForFrame(diff.harness, "+ brand")
    expect(frame(diff.harness)).not.toContain("+ TWO")
  }, 30_000)
})

describe("interactive diff workflows", () => {
  it("stages a selected range without staging a later change", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "tracked.txt"), "ONE\ntwo\nTHREE\n")
    await diff.show("driver.open-staging")
    await waitForFrame(diff.harness, "unstaged tracked.txt  [line]")

    await runCommand(diff.harness, "diff.toggle-view")
    await runCommand(diff.harness, "diff.scroll-down")
    await runCommand(diff.harness, "diff.choose")

    const cached = await git(diff.harness, "diff", "--cached", "--", "tracked.txt")
    expect(cached).toContain("+ONE")
    expect(cached).not.toContain("THREE")
    expect(await git(diff.harness, "diff", "--", "tracked.txt")).toContain("THREE")
  }, 30_000)

  it("stages one line from a deleted file without staging the whole deletion", async () => {
    const diff = await createDiffHarness()
    await rm(join(diff.harness.directory, "tracked.txt"))
    await diff.show("driver.open-staging")
    await waitForFrame(diff.harness, "unstaged tracked.txt  [line]")
    await runCommand(diff.harness, "diff.choose")

    expect(await git(diff.harness, "show", ":tracked.txt")).toBe("two\nthree\n")
    expect(await git(diff.harness, "diff", "--name-only", "--", "tracked.txt")).toBe("tracked.txt\n")
  }, 30_000)

  it("unstages one line from a staged deletion without restoring the working-tree file", async () => {
    const diff = await createDiffHarness()
    const path = join(diff.harness.directory, "tracked.txt")
    await rm(path)
    await git(diff.harness, "add", "tracked.txt")
    await diff.show("driver.open-staging")
    await waitForFrame(diff.harness, "staged tracked.txt  [line]")
    await runCommand(diff.harness, "diff.staging-discard")

    expect(await git(diff.harness, "show", ":tracked.txt")).toBe("one\n")
    expect(await Bun.file(path).exists()).toBeFalse()
  }, 30_000)

  it("discards one line from an unstaged deletion without restoring unselected lines", async () => {
    const diff = await createDiffHarness()
    const path = join(diff.harness.directory, "tracked.txt")
    await rm(path)
    await diff.show("driver.open-staging")
    await waitForFrame(diff.harness, "unstaged tracked.txt  [line]")

    let discard!: Promise<void>
    await act(async () => {
      discard = diff.harness.kernel.commands.execute("diff.staging-discard")
      await Promise.resolve()
    })
    await waitForFrame(diff.harness, "Discard selected changes?")
    await act(async () => {
      diff.harness.setup.mockInput.pressKey("y")
      await discard
      await diff.harness.kernel.events.drain()
    })
    await settle(diff.harness)
    await waitForFrame(
      diff.harness,
      (screen) => screen.includes("-two") && !screen.includes("-one") && !screen.includes("Discard selected changes?"),
    )

    expect(await Bun.file(path).text()).toBe("one\n")
    expect(await git(diff.harness, "diff", "--", "tracked.txt")).toContain("-two")
    expect(await git(diff.harness, "diff", "--", "tracked.txt")).toContain("-three")
  }, 30_000)

  it("unstages one line from a newly added file without removing the rest of it", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "new.txt"), "first\nsecond\n")
    await git(diff.harness, "add", "new.txt")
    await diff.show("driver.open-new-staging")
    await waitForFrame(diff.harness, "staged new.txt  [line]")
    await runCommand(diff.harness, "diff.choose")

    expect(await git(diff.harness, "show", ":new.txt")).toBe("second\n")
    expect(await Bun.file(join(diff.harness.directory, "new.txt")).text()).toBe("first\nsecond\n")
  }, 30_000)

  it("serializes rapid hunk staging against the refreshed patch", async () => {
    const diff = await createDiffHarness()
    const original = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
    const changed = original.replace("line 1\n", "LINE ONE\n").replace("line 12\n", "LINE TWELVE\n")
    await writeFile(join(diff.harness.directory, "tracked.txt"), original)
    await git(diff.harness, "add", "tracked.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "long fixture")
    await writeFile(join(diff.harness.directory, "tracked.txt"), changed)
    await diff.show("driver.open-staging")
    await waitForFrame(diff.harness, "unstaged tracked.txt  [line]")
    await runCommand(diff.harness, "diff.staging-mode")

    await act(async () => {
      await Promise.all([
        diff.harness.kernel.commands.execute("diff.choose"),
        diff.harness.kernel.commands.execute("diff.choose"),
      ])
    })
    await act(async () => diff.harness.kernel.events.drain())
    await settle(diff.harness)

    const cached = await git(diff.harness, "diff", "--cached", "--", "tracked.txt")
    expect(cached).toContain("LINE ONE")
    expect(cached).toContain("LINE TWELVE")
    expect(await git(diff.harness, "diff", "--", "tracked.txt")).toBe("")
  }, 30_000)

  it("picks and undoes marker-delimited conflict sides", async () => {
    const diff = await createDiffHarness()
    const conflict = `<<<<<<< HEAD\ncurrent one\n=======\nincoming one\n>>>>>>> topic\nmiddle\n<<<<<<< HEAD\ncurrent two\n=======\nincoming two\n>>>>>>> topic\n`
    await writeFile(join(diff.harness.directory, "tracked.txt"), conflict)
    await diff.show("driver.open-conflict")
    await waitForFrame(diff.harness, "conflict tracked.txt  1/2")

    await runCommand(diff.harness, "diff.next-block")
    await waitForFrame(diff.harness, "conflict tracked.txt  2/2")
    await act(async () => diff.harness.kernel.git.refresh())
    await act(async () => diff.harness.kernel.events.drain())
    await settle(diff.harness)
    expect(frame(diff.harness)).toContain("conflict tracked.txt  2/2")

    await runCommand(diff.harness, "diff.choose")
    expect(await Bun.file(join(diff.harness.directory, "tracked.txt")).text()).toContain("incoming one")
    expect(await Bun.file(join(diff.harness.directory, "tracked.txt")).text()).not.toContain("incoming two")

    await act(async () => diff.harness.kernel.git.refresh())
    await act(async () => diff.harness.kernel.events.drain())
    await settle(diff.harness)

    await runCommand(diff.harness, "diff.undo-conflict")
    expect(await Bun.file(join(diff.harness.directory, "tracked.txt")).text()).toBe(conflict)
  }, 30_000)

  it("resolves the last block of a real merge without staging marker text", async () => {
    const diff = await createDiffHarness()
    await git(diff.harness, "checkout", "--quiet", "-b", "topic")
    await writeFile(join(diff.harness.directory, "tracked.txt"), "topic\n")
    await git(diff.harness, "add", "tracked.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "topic")
    await git(diff.harness, "checkout", "--quiet", "main")
    await writeFile(join(diff.harness.directory, "tracked.txt"), "main\n")
    await git(diff.harness, "add", "tracked.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "main")
    expect(await gitAllowFailure(diff.harness, "merge", "topic")).not.toBe(0)

    await diff.show("driver.open-conflict")
    await waitForFrame(diff.harness, "conflict tracked.txt  1/1")
    await runCommand(diff.harness, "diff.choose")
    await waitForFrame(diff.harness, "working tree tracked.txt")
    await act(async () => diff.harness.kernel.events.drain())
    await settle(diff.harness)

    expect(await Bun.file(join(diff.harness.directory, "tracked.txt")).text()).toBe("main\n")
    expect(await git(diff.harness, "diff", "--name-only", "--diff-filter=U")).toBe("tracked.txt\n")
  }, 30_000)

  it("applies an incoming whole-file three-way strategy and stages it", async () => {
    const diff = await createDiffHarness()
    await git(diff.harness, "checkout", "--quiet", "-b", "topic")
    await writeFile(join(diff.harness.directory, "tracked.txt"), "topic\n")
    await git(diff.harness, "add", "tracked.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "topic")
    await git(diff.harness, "checkout", "--quiet", "main")
    await writeFile(join(diff.harness.directory, "tracked.txt"), "main\n")
    await git(diff.harness, "add", "tracked.txt")
    await git(diff.harness, "commit", "--quiet", "--message", "main")
    expect(await gitAllowFailure(diff.harness, "merge", "topic")).not.toBe(0)

    await diff.show("driver.open-conflict")
    await waitForFrame(diff.harness, "conflict tracked.txt  1/1")
    await press(diff.harness, "M")
    await waitForFrame(diff.harness, "Resolve whole file")
    await press(diff.harness, "i")
    await waitFor(
      diff.harness,
      async () => (await git(diff.harness, "ls-files", "--unmerged", "--", "tracked.txt")) === "",
      "the whole-file strategy to stage the resolved file",
    )
    await act(async () => {
      await diff.harness.kernel.git.waitForIdle()
      await diff.harness.kernel.events.drain()
    })
    await settle(diff.harness)
    await waitForFrame(diff.harness, "working tree tracked.txt")

    expect(await Bun.file(join(diff.harness.directory, "tracked.txt")).text()).toBe("topic\n")
    expect(await git(diff.harness, "ls-files", "--unmerged", "--", "tracked.txt")).toBe("")
  }, 30_000)
})
