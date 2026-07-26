import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, type Harness } from "../test-harness"

installHarnessLifecycle()

/**
 * The status Pane has no Commands worth driving and issues no git of its own: all it does is
 * turn one `GitState` into two rows. So this file covers exactly that derivation — every
 * `Head` variant, every working-tree count, the stash suffix, and the repository name — and
 * leaves what a person sees (the narrow-width clip, the `1`/`x` bindings, the actions menu and
 * the browser URL it opens) to `scripts/e2e`. The rendered rows are the only place that
 * derivation surfaces, so they are read as data here, never as a layout.
 */

/** The shipped Extension itself, symlinked into the bundled scope the way `main.tsx` loads it. */
const statusExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "status")

/**
 * The harness directory is the repository, the Extension home, and where the kernel writes
 * `config.schema.json` — so everything it generates is ignored, `.gitignore` included, or the
 * very working-tree counts under test would be reporting the scaffolding. It ignores itself
 * rather than being committed, so the tree it describes starts genuinely clean.
 */
const ignored = ".gitignore\nbundled/\nglobal/\nrepo/\norigin.git/\n*.json\n*.jsonc\n"

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
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
  // A broken fixture is not a test result, so it fails here rather than as a puzzling row.
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
  return stdout
}

/** A harness whose directory is a repository with nothing committed yet. */
async function repository(): Promise<Harness> {
  const harness = await createHarness({ git: true })
  await writeFile(join(harness.directory, ".gitignore"), ignored)
  return harness
}

/** The common starting point: one commit on `main`. */
async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, "tracked.txt"), "one\n")
  await git(harness.directory, "add", "tracked.txt")
  await git(harness.directory, "commit", "--quiet", "--message", "first commit")
}

/**
 * A bare repository standing in for a remote, wired up as `origin` with `main` pushed.
 *
 * It lives inside the harness directory — ignored, so it never reaches the counts — because
 * the harness already owns that directory's lifetime, and a remote in `tmpdir` would need
 * cleanup bookkeeping of its own for no gain.
 */
async function addOrigin(harness: Harness): Promise<void> {
  const remote = join(harness.directory, "origin.git")
  await git(harness.directory, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", remote)
  await git(harness.directory, "remote", "add", "origin", remote)
  await git(harness.directory, "push", "--quiet", "--set-upstream", "origin", "main")
}

/**
 * Runs the real Extension over the harness's repository. The poll is disabled outright:
 * every fixture below is complete before the kernel starts, so a tick could only republish
 * the same state from outside React's `act`.
 */
async function start(harness: Harness): Promise<void> {
  await symlink(statusExtension, join(harness.bundled, "status"))
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": [["status"]] }, "git": { "refreshIntervalMs": 60000 } }`,
  )
  await renderApp(harness)
}

/** The last segment of the harness directory — what `directoryName` has to arrive at. */
function basename(harness: Harness): string {
  return (
    harness.directory
      .split("/")
      .filter((segment) => segment !== "")
      .at(-1) ?? ""
  )
}

describe("what the status pane derives from HEAD", () => {
  it("says so outside a repository rather than rendering an empty box", async () => {
    const harness = await createHarness()
    await start(harness)

    expect(frame(harness)).toContain("no repository")
    // `noRepository` is the whole row: there is no branch to name and no tree to count, so
    // neither the counts row nor the repository name is drawn beside the sentence.
    expect(frame(harness)).not.toContain("clean")
  })

  it("names the unborn branch and says there is nothing committed yet", async () => {
    const harness = await repository()
    await start(harness)

    // An unborn HEAD carries a branch but no commit, so the slot a divergence would occupy
    // explains the absence rather than inventing a comparison.
    expect(frame(harness)).toContain("main no commits yet")
  })

  it("names the branch, the missing upstream, and the directory the repository is in", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    // The name is what tells two laziergits apart, and it is the last segment of the root —
    // not the whole path, which is what would actually fit nowhere.
    expect(frame(harness)).toContain(`main no upstream ${basename(harness)}`)
  })

  it("names the commit a detached HEAD is sitting on, shortened", async () => {
    const harness = await repository()
    await seed(harness)
    const oid = (await git(harness.directory, "rev-parse", "HEAD")).trim()
    await git(harness.directory, "checkout", "--quiet", "--detach", "HEAD")

    await start(harness)

    expect(frame(harness)).toContain(`detached at ${oid.slice(0, 7)}`)
    expect(frame(harness)).not.toContain(oid.slice(0, 8))
  })

  it("marks a branch that is level with its upstream", async () => {
    const harness = await repository()
    await seed(harness)
    await addOrigin(harness)

    await start(harness)

    expect(frame(harness)).toContain("main ≡")
  })

  it("counts unpushed commits, and nothing else", async () => {
    const harness = await repository()
    await seed(harness)
    await addOrigin(harness)
    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "second commit")

    await start(harness)

    // Behind is 0, so its glyph is absent rather than drawn as `↓0`.
    expect(frame(harness)).toContain("main ↑1 ")
    expect(frame(harness)).not.toContain("↓")
  })

  it("counts unpulled commits, and nothing else", async () => {
    const harness = await repository()
    await seed(harness)
    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "second commit")
    await addOrigin(harness)
    // The remote keeps both commits; this branch steps back off the second one.
    await git(harness.directory, "reset", "--quiet", "--hard", "HEAD~1")

    await start(harness)

    expect(frame(harness)).toContain("main ↓1 ")
    expect(frame(harness)).not.toContain("↑")
  })

  it("shows both counts, in one segment, when the branch has diverged", async () => {
    const harness = await repository()
    await seed(harness)
    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "second commit")
    await addOrigin(harness)
    await git(harness.directory, "reset", "--quiet", "--hard", "HEAD~1")
    await writeFile(join(harness.directory, "tracked.txt"), "three\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "divergent commit")

    await start(harness)

    expect(frame(harness)).toContain("main ↑1 ↓1 ")
  })

  it("warns that a deleted upstream is gone rather than reporting it as in sync", async () => {
    const harness = await repository()
    await seed(harness)
    await addOrigin(harness)
    await git(harness.directory, "checkout", "--quiet", "-b", "feature")
    await git(harness.directory, "push", "--quiet", "--set-upstream", "origin", "feature")
    await git(harness.directory, "push", "--quiet", "origin", "--delete", "feature")

    await start(harness)

    // The whole point of checking `gone` first: ahead and behind are both 0 here, so reading
    // the numbers would draw this identically to the "level with upstream" case above.
    expect(frame(harness)).toContain("feature gone")
    expect(frame(harness)).not.toContain("feature ≡")
  })
})

describe("what the status pane derives from the working tree", () => {
  it("says a tree with nothing in it is clean, rather than drawing four zeroes", async () => {
    const harness = await repository()
    await seed(harness)

    await start(harness)

    expect(frame(harness)).toContain("clean")
    expect(frame(harness)).not.toContain("+0")
    expect(frame(harness)).not.toContain("?0")
  })

  it("counts staged, unstaged, untracked and stashed work in one run", async () => {
    const harness = await repository()
    await seed(harness)
    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await git(harness.directory, "stash", "push", "--quiet", "--message", "wip")
    await writeFile(join(harness.directory, "tracked.txt"), "three\n")
    await writeFile(join(harness.directory, "staged.txt"), "staged\n")
    await git(harness.directory, "add", "staged.txt")
    await writeFile(join(harness.directory, "loose.txt"), "loose\n")

    await start(harness)

    // One space between kinds and none before the first, which is what the index-aware
    // prefix in `workingTreeSegments` is for; the stash carries its own leading space.
    expect(frame(harness)).toContain("+1 ~1 ?1 ⚑1")
    expect(frame(harness)).not.toContain("clean")
  })

  it("counts conflicted paths in their own kind", async () => {
    const harness = await repository()
    await writeFile(join(harness.directory, "shared.txt"), "base\n")
    await git(harness.directory, "add", "shared.txt")
    await git(harness.directory, "commit", "--quiet", "--message", "base")
    await git(harness.directory, "checkout", "--quiet", "-b", "theirs")
    await writeFile(join(harness.directory, "shared.txt"), "theirs\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "theirs")
    await git(harness.directory, "checkout", "--quiet", "main")
    await writeFile(join(harness.directory, "shared.txt"), "ours\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "ours")
    // Expected to fail: the conflict is the fixture, so this one exit code is not checked.
    Bun.spawnSync(["git", "merge", "theirs"], { cwd: harness.directory, env: { ...process.env, ...gitIsolationEnv } })

    await start(harness)

    expect(frame(harness)).toContain("!1")
    expect(frame(harness)).not.toContain("clean")
  })

  it("keeps the stash count on a tree that is otherwise clean", async () => {
    const harness = await repository()
    await seed(harness)
    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await git(harness.directory, "stash", "push", "--quiet", "--message", "wip")

    await start(harness)

    // Stashes are not working-tree changes, so they hang off "clean" rather than replacing
    // it: a stashed entry is still work this repository is holding.
    expect(frame(harness)).toContain("clean ⚑1")
  })
})
