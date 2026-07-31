import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  renderApp,
  runCommand,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, symlinked into the harness's bundled scope the way `main.tsx` loads it. */
const diffExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "diff")

const ignored = ".gitignore\nbundled/\nglobal/\nrepo/\n*.json\n*.jsonc\n"

const isolation: Readonly<Record<string, string>> = {
  ...gitIsolationEnv,
  GIT_AUTHOR_NAME: "Ada Lovelace",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada Lovelace",
  GIT_COMMITTER_EMAIL: "ada@example.com",
}

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...isolation },
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
  return stdout.trim()
}

/**
 * Drives `DiffApi.show` from a Pane of its own, so a test names the {@link DiffTarget} it is
 * about rather than dragging a real list Pane's git requirements in. The target is read from
 * a file the test writes, because a Command takes no arguments.
 */
const driverSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "driver",
    needs: ["diff"],
    activate(ctx) {
      const diff = ctx.extensions.get("diff")

      ctx.panes.register({
        id: "driver",
        title: "Driver",
        component: () => <text content="driver" />,
        placement: { column: 0, order: 10 },
      })

      ctx.commands.register({
        id: "driver.show",
        title: "Show the target on disk",
        run: async () => {
          const text = await Bun.file(ctx.git.root + "/target.json").text()
          diff.show(JSON.parse(text))
        },
      })
    },
  })
`

async function start(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(diffExtension, join(harness.bundled, "diff")),
    writeFile(join(harness.repo, "driver.tsx"), driverSource),
    // A wide diff column, so a header line survives without wrapping into the assertion. The
    // fingerprint poll is parked: every fixture is complete before the kernel starts.
    writeFile(
      harness.configFiles.repo,
      `{ "layout": { "columns": [["driver"], ["diff"]] }, "git": { "refreshIntervalMs": 60000 } }`,
    ),
  ])
  await renderApp(harness)
}

/**
 * Points the Pane at a target. The fetch is an effect the Pane runs afterwards, so each test
 * waits for its output on the frame.
 */
async function show(harness: Harness, target: unknown): Promise<void> {
  await writeFile(join(harness.directory, "target.json"), JSON.stringify(target))
  await runCommand(harness, "driver.show")
}

async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".gitignore"), ignored)
  await writeFile(join(harness.directory, "one.txt"), "first\n")
  // `.gitignore` ignores itself, along with everything else the harness generates.
  await git(harness.directory, "add", "one.txt")
  await git(harness.directory, "commit", "--quiet", "--message", "seed")
}

describe("the diff Pane's context header", () => {
  it("shows a commit's whole message above its patch", async () => {
    const harness = await createHarness({ git: true, width: 150 })
    await seed(harness)
    await writeFile(join(harness.directory, "one.txt"), "second\n")
    await writeFile(join(harness.directory, "two.txt"), "new\n")
    await git(harness.directory, "add", "two.txt")
    await git(
      harness.directory,
      "commit",
      "--quiet",
      "--all",
      "--message",
      "Rework the hint bar",
      "--message",
      "The body a one-line row can never show.",
    )
    const oid = await git(harness.directory, "rev-parse", "HEAD")

    await start(harness)
    await show(harness, { kind: "commit", ref: oid, path: null })

    // The subject *and* the body, which is what makes the detail view readable in full.
    await waitForFrame(harness, "Rework the hint bar")
    const rendered = frame(harness)
    expect(rendered).toContain("The body a one-line row can never show.")
    expect(rendered).toContain("Ada Lovelace")
    // Both files, and the header lifted off rather than parsed as one of them.
    expect(rendered).toContain("one.txt")
    expect(rendered).toContain("two.txt")
    expect(rendered).not.toContain("no textual diff")
  }, 30_000)

  it("names a branch in full, and what it tracks", async () => {
    const harness = await createHarness({ git: true, width: 150 })
    await seed(harness)
    const long = "feature/PROJ-1234-a-branch-name-no-list-column-can-hold"
    await git(harness.directory, "checkout", "--quiet", "-b", long)

    await start(harness)
    await show(harness, { kind: "branch", ref: long, path: null })

    // The name alone is on screen before git answers — the chrome line names the target the
    // moment `show` lands — so the patch is what marks the fetch complete.
    await waitForFrame(harness, "seed")
    // The point of the `branch` kind: the row clips this name, and `{ kind: "commit" }` could
    // only ever name the tip.
    expect(frame(harness)).toContain(long)
  }, 30_000)

  it("resolves a branch whose name is also a path, which git alone reads as ambiguous", async () => {
    const harness = await createHarness({ git: true, width: 150 })
    await seed(harness)
    // `git show docs` in a repository holding both is a fatal, not a patch, so the argv has
    // to end its revision list explicitly.
    await writeFile(join(harness.directory, "one.txt"), "changed\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "docs commit")
    await git(harness.directory, "branch", "one.txt")

    await start(harness)
    await show(harness, { kind: "branch", ref: "one.txt", path: null })

    await waitForFrame(harness, "docs commit")
    expect(frame(harness)).not.toContain("ambiguous argument")
  }, 30_000)

  it("keeps a working-tree diff headerless", async () => {
    const harness = await createHarness({ git: true, width: 150 })
    await seed(harness)
    await writeFile(join(harness.directory, "one.txt"), "edited\n")

    await start(harness)
    await show(harness, { kind: "workingTree", path: "one.txt" })

    await waitForFrame(harness, "edited")
    // Nothing asked for a header here: the leading section of `git diff` output is a file,
    // and lifting it as a header would swallow the patch.
    expect(frame(harness)).not.toContain("Author:")
    expect(frame(harness)).not.toContain("Ada Lovelace")
  }, 30_000)

  it("still says a commit changed nothing, with its message above the answer", async () => {
    const harness = await createHarness({ git: true, width: 150 })
    await seed(harness)
    await git(harness.directory, "commit", "--quiet", "--allow-empty", "--message", "An empty commit")
    const oid = await git(harness.directory, "rev-parse", "HEAD")

    await start(harness)
    await show(harness, { kind: "commit", ref: oid, path: null })

    await waitForFrame(harness, "An empty commit")
    expect(frame(harness)).toContain("no changes")
  }, 30_000)

  it("prefixes a stash with the message the row clipped", async () => {
    const harness = await createHarness({ git: true, width: 150 })
    await seed(harness)
    await writeFile(join(harness.directory, "one.txt"), "stashed\n")
    await git(harness.directory, "stash", "push", "--quiet", "--message", "a message longer than a row")

    await start(harness)
    await show(harness, { kind: "stash", ref: "stash@{0}", path: null })

    // `stash show` prints no header, so this line is the Pane's, read out of the store.
    await waitForFrame(harness, "a message longer than a row on main")
    expect(frame(harness)).not.toContain("stash@{")
    expect(frame(harness)).toContain("stashed")
  }, 30_000)
})
