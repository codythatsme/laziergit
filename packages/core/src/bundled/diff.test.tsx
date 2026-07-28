import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/**
 * The two halves of this Extension no other suite can see: what git was asked (every `fetchFor`
 * branch, recorded at the process boundary) and what the Pane made of the answer. The e2e
 * suite's diff assertion reads the header, which is built from the `DiffTarget` rather than
 * from git's answer, so it stays green for an argv git rejects.
 */

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

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

/**
 * Separates the arguments of one recorded invocation: ASCII unit separator, written as an
 * escape so no control byte lands in this file. No git argument can contain it.
 */
const unitSeparator = "\u001f"

/**
 * Puts a recording stand-in for `git` at the front of `PATH`, and hands back a reader for what
 * it caught. `execGit` spawns the bare name `git`, and nothing about `fetchFor` is exported, so
 * the process boundary is the only place to read the argv an Extension built.
 *
 * One file per invocation: overlapping git processes would interleave a shared log.
 */
async function recordGitArgv(harness: Harness): Promise<() => Promise<readonly (readonly string[])[]>> {
  const bin = join(harness.directory, "bin")
  const log = join(harness.directory, "argv")
  await Promise.all([mkdir(bin), mkdir(log)])
  const shim = join(bin, "git")
  // `printf` reuses its format for every remaining argument, so one call writes the whole
  // record; `exec` then hands the process over, so nothing else about the run changes.
  const script = [
    "#!/bin/sh",
    `printf '%s\\037' "$@" > "$(mktemp ${JSON.stringify(join(log, "argv.XXXXXX"))})"`,
    `exec ${JSON.stringify(realGit())} "$@"`,
    "",
  ].join("\n")
  await writeFile(shim, script)
  await chmod(shim, 0o755)
  process.env.PATH = `${bin}:${originalPath ?? ""}`

  return async () => {
    const names = await readdir(log)
    const records = await Promise.all(names.map((name) => readFile(join(log, name), "utf8")))
    // Every record ends with a separator, so the split leaves one empty tail element.
    return records.map((record) => record.split(unitSeparator).slice(0, -1))
  }
}

/**
 * One recorded argv, with core's own pinning flags removed: repeating them in each expectation
 * would make this a change-detector for that flag list.
 */
function extensionArgv(recorded: readonly string[]): readonly string[] {
  let index = 0
  while (index < recorded.length) {
    const argument = recorded[index]
    if (argument === "-c") index += 2
    else if (argument === "--no-pager" || argument === "--no-optional-locks") index += 1
    else break
  }
  return recorded.slice(index)
}

/** The diff Pane's own invocations, separated from the store reads the kernel makes around them. */
function isFetch(argv: readonly string[]): boolean {
  return argv[0] === "diff" || argv[0] === "show" || (argv[0] === "stash" && argv[1] === "show")
}

interface DiffHarness {
  readonly harness: Harness
  /** Every fetch the diff Pane has issued so far. */
  fetches(): Promise<readonly (readonly string[])[]>
  /** Runs a driver Command and waits for the fetch it causes to reach git. */
  show(command: string): Promise<readonly string[]>
}

/**
 * The diff Pane and the driver over a repository with one commit. The `.gitignore` covers the
 * harness's own scaffolding, which would otherwise show up as untracked files.
 */
async function createDiffHarness(extensionConfig = ""): Promise<DiffHarness> {
  const harness = await createHarness({ git: true })
  await symlink(join(bundledExtensionDirectory, "diff"), join(harness.bundled, "diff"))
  await writeFile(join(harness.repo, "driver.ts"), driverSource)
  await writeFile(
    harness.configFiles.repo,
    // The poll is off: every fixture is complete before the kernel starts, so a tick could
    // only re-issue a fetch this file counts.
    `{ "layout": { "columns": [["diff"]] }, "git": { "refreshIntervalMs": 60000 }${extensionConfig} }`,
  )
  await writeFile(join(harness.directory, ".gitignore"), "global/\nrepo/\nbundled/\nbin/\nargv/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "seed.txt"), "seed\n")
  await writeFile(join(harness.directory, "tracked.txt"), "one\ntwo\nthree\n")
  // A file whose name is also a pathspec pattern, and the file that pattern would catch.
  await writeFile(join(harness.directory, "glob[1].txt"), "bracket\n")
  await writeFile(join(harness.directory, "glob1.txt"), "decoy\n")
  await git(harness, "add", ".gitignore", "seed.txt", "tracked.txt", "glob1.txt", ":(literal)glob[1].txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")

  let read: (() => Promise<readonly (readonly string[])[]>) | null = null
  const fetches = async (): Promise<readonly (readonly string[])[]> => {
    if (read === null) return []
    const all = await read()
    return all.map(extensionArgv).filter(isFetch)
  }

  return {
    harness,
    fetches,
    async show(command) {
      // The recording is never cleared, so one target per harness.
      if (read !== null) throw new Error("show() drives one target per harness")
      // Installed here rather than in `createHarness`, so the fixture git above is never
      // recorded and never has to be filtered back out.
      read = await recordGitArgv(harness)
      await renderApp(harness)
      await act(async () => {
        void harness.kernel.commands.execute(command)
        await Bun.sleep(20)
      })
      // The fetch is a real git process behind a `useEffect`, so it lands several ticks after
      // the Command that asked for it.
      const deadline = Date.now() + 3_000
      for (;;) {
        await settle(harness)
        const first = (await fetches())[0]
        if (first !== undefined) return first
        if (Date.now() > deadline) return []
        await act(async () => {
          await Bun.sleep(20)
        })
      }
    },
  }
}

/**
 * A `git` that stalls only the diff Pane's fetches — `--no-ext-diff` is on every one of them
 * and on no call core makes — so a test can read the screen mid-fetch.
 */
async function installSlowDiffGit(harness: Harness, seconds: number): Promise<void> {
  const bin = join(harness.directory, "bin")
  await mkdir(bin)
  const shim = join(bin, "git")
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    `  if [ "$arg" = "--no-ext-diff" ]; then sleep ${seconds}; break; fi`,
    "done",
    `exec ${JSON.stringify(realGit())} "$@"`,
    "",
  ].join("\n")
  await writeFile(shim, script)
  await chmod(shim, 0o755)
  process.env.PATH = `${bin}:${originalPath ?? ""}`
}

async function execute(harness: Harness, command: string): Promise<void> {
  await act(async () => {
    void harness.kernel.commands.execute(command)
  })
  await settle(harness)
}

/**
 * Renders until `predicate` holds, and hands back the frame that matched, so the rest of a test
 * reads that same frame rather than racing the next one. Giving up returns the last frame
 * quietly, leaving the test's own `expect` to report the failure.
 */
async function waitForFrame(harness: Harness, predicate: (screen: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3_000
  for (;;) {
    await settle(harness)
    const screen = frame(harness)
    if (predicate(screen) || Date.now() > deadline) return screen
    await act(async () => {
      await Bun.sleep(20)
    })
  }
}

describe("the git the diff pane asks for", () => {
  it("diffs one working-tree path against the index", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

    // `:(literal)` because every path git takes is a pattern — see the glob case below.
    expect(await diff.show("driver.working-file")).toEqual([
      "diff",
      "--no-ext-diff",
      "-U3",
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("diffs the whole side when the target names no path", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "seed.txt"), "seed changed\n")

    // No pathspec at all, rather than one that matches everything: a Pane whose selection is
    // not a single file should show the side, not an empty diff.
    expect(await diff.show("driver.working-tree")).toEqual(["diff", "--no-ext-diff", "-U3"])
  })

  it("wraps a path that reads as a glob so it cannot match its neighbour", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "glob[1].txt"), "bracket changed\n")
    await writeFile(join(diff.harness.directory, "glob1.txt"), "decoy changed\n")

    const argv = await diff.show("driver.glob-file")

    // Unwrapped, `glob[1].txt` is a pattern that also matches `glob1.txt`, so the Pane would
    // diff a file the user never selected alongside the one they did.
    expect(argv).toEqual(["diff", "--no-ext-diff", "-U3", "--", ":(literal)glob[1].txt"])
    const screen = await waitForFrame(diff.harness, (text) => text.includes("bracket changed"))
    expect(screen).not.toContain("decoy")
  })

  it("diffs an untracked file against /dev/null, outside the index entirely", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "untracked.txt"), "brand\nnew\n")

    const argv = await diff.show("driver.untracked")

    // Plain `git diff` prints nothing for an untracked path. `--no-index` takes filesystem
    // paths rather than pathspecs, which is why this one is not wrapped in `:(literal)`.
    expect(argv).toEqual(["diff", "--no-index", "--no-ext-diff", "-U3", "--", "/dev/null", "untracked.txt"])
  })

  it("diffs the index against HEAD for a staged target", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nTWO\nthree\n")
    await git(diff.harness, "add", "tracked.txt")

    expect(await diff.show("driver.staged-file")).toEqual([
      "diff",
      "--cached",
      "--no-ext-diff",
      "-U3",
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("shows a commit with its own header, always against its first parent", async () => {
    const diff = await createDiffHarness()
    const oid = (await git(diff.harness, "rev-parse", "HEAD")).trim()

    const argv = await diff.show("driver.head-commit-file")

    // `--pretty=medium` keeps the header a clipped one-line row cannot show; `splitPatch`
    // lifts it off rather than letting `<diff>` parse it as a file section. `--first-parent`
    // is byte-identical to no flag on an ordinary commit, and rides along for the merge below.
    expect(argv).toEqual([
      "show",
      "--pretty=medium",
      "--no-ext-diff",
      "-U3",
      "--first-parent",
      oid,
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("keeps show read-only for a whole stash entry by putting show straight after stash", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nstashed\nthree\n")
    await git(diff.harness, "stash", "push", "--quiet", "--message", "wip")

    const argv = await diff.show("driver.stash")

    // The service reads the argv element directly after the subcommand as its operand, and
    // only the exact pair `stash show` is on its read-only list.
    expect(argv).toEqual(["stash", "show", "-p", "--no-ext-diff", "-U3", "stash@{0}"])

    const settled = (await diff.fetches()).length
    await act(async () => {
      await Bun.sleep(400)
    })
    await settle(diff.harness)
    // A fetch counted as a mutation would refresh the store, and the refresh would re-run the
    // fetch for as long as anyone watched.
    expect((await diff.fetches()).length).toBe(settled)
  })

  it("narrows a stash through its first parent, which stash show cannot be asked to do", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nstashed\nthree\n")
    await git(diff.harness, "stash", "push", "--quiet", "--message", "wip")

    // `git stash show <ref> -- <path>` exits with "Too many revisions specified"; the diff
    // against the entry's first parent is the same patch and does take a pathspec.
    expect(await diff.show("driver.stash-file")).toEqual([
      "diff",
      "--no-ext-diff",
      "-U3",
      "stash@{0}^1",
      "stash@{0}",
      "--",
      ":(literal)tracked.txt",
    ])
  })

  it("carries the configured context into the invocation", async () => {
    const diff = await createDiffHarness(`, "extensions": { "diff": { "context": 0 } }`)
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

    expect(await diff.show("driver.working-file")).toContain("-U0")
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
    const screen = await waitForFrame(diff.harness, (text) => text.includes("beta.txt"))
    expect(screen).toContain("alpha.txt")
    // A deletion writes `+++ /dev/null`, so this one is named only by the fallback to the
    // `--- a/` side — without it its row would read "(unnamed)".
    expect(screen).toContain("seed.txt")
  })

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
    const screen = await waitForFrame(diff.harness, (text) => text.includes("+ merged"))
    expect(screen).toContain("side.txt")
    expect(screen).not.toContain("no changes")
  })

  it("shows an untracked file's contents rather than reading git's exit code as failure", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "untracked.txt"), "brand\nnew\n")

    await diff.show("driver.untracked")

    // `--no-index` exits 1 to mean "the two files differ", the ordinary answer here.
    const screen = await waitForFrame(diff.harness, (text) => text.includes("+ brand"))
    expect(screen).toContain("+ new")
    expect(screen).not.toContain("no changes")
  })
})

describe("moving from one target to the next", () => {
  it("holds the patch on screen until the next one has arrived", async () => {
    const diff = await createDiffHarness()
    await writeFile(join(diff.harness.directory, "tracked.txt"), "one\nTWO\nthree\n")
    await writeFile(join(diff.harness.directory, "untracked.txt"), "brand\nnew\n")
    await installSlowDiffGit(diff.harness, 0.4)
    await renderApp(diff.harness)

    await execute(diff.harness, "driver.working-file")
    expect(await waitForFrame(diff.harness, (text) => text.includes("+ TWO"))).toContain("+ TWO")

    await execute(diff.harness, "driver.untracked")

    // The Pane has been pointed at a target git has not answered for yet.
    const during = frame(diff.harness)
    expect(during).toContain("+ TWO")
    expect(during).not.toContain("loading")

    expect(await waitForFrame(diff.harness, (text) => text.includes("+ brand"))).not.toContain("+ TWO")
  })
})
