import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, symlinked into the harness's bundled scope the way `main.tsx` loads it. */
const commitsExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commits")
const commitFlowExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commit-flow")

/**
 * The harness directory is the repository, the Extension home, and where the kernel writes
 * `config.schema.json` — so everything it generates is ignored, `.gitignore` included, or the
 * scaffolding would show up as the uncommitted changes a hard reset claims to destroy.
 */
const ignored = ".gitignore\nbundled/\nglobal/\nrepo/\n*.json\n*.jsonc\n"

/** The commits Pane renders the author, so this fixture overrides the shared identity with a recognisable one. */
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
  // A broken fixture is not a test result, so it fails here rather than as a puzzling frame.
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
  return stdout
}

/**
 * Stands in for the bundled `diff` Extension, which `commits` declares as a `need`. A stub
 * keeps this file testing what `commits` asks for — the exact {@link DiffTarget} it pushes on
 * every selection change — rather than what another Extension chose to render.
 */
const diffStub = `
  /** @jsxImportSource @opentui/react */
  import { createCell, defineExtension } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      const target = createCell(null)

      function DiffPane() {
        const current = target.use()
        if (current === null) return <text content="diff: nothing" />
        return (
          <text
            content={
              "diff: " + current.kind + " " + String(current.ref).slice(0, 7) +
              " path=" + (current.path === null ? "none" : current.path)
            }
          />
        )
      }

      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane })
      return { current: () => target.get(), show: (next) => target.set(next) }
    },
  })
`

/**
 * The diff Pane is listed first so it owns the initial focus: the rule under test is that the
 * commits Pane drives the diff only while *it* is focused, which needs a frame where it is not.
 */
function layout(git = ""): string {
  return `{ "layout": { "columns": [["diff"], ["commits"]] }${git} }`
}

interface Repo {
  readonly harness: Harness
  /** Runs git inside the harness repository. */
  run(...args: readonly string[]): Promise<string>
  /** The full oid of a revision. */
  oid(revision: string): Promise<string>
  /** The abbreviated oid, the same `%h` the store renders in a row. */
  shortOid(revision: string): Promise<string>
}

async function openRepo(options: { readonly config?: string; readonly git?: boolean } = {}): Promise<Repo> {
  const harness = await createHarness({ git: options.git ?? true })
  await Promise.all([
    writeFile(join(harness.directory, ".gitignore"), ignored),
    writeFile(harness.configFiles.repo, options.config ?? layout()),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    symlink(commitFlowExtension, join(harness.bundled, "commit-flow")),
    symlink(commitsExtension, join(harness.bundled, "commits")),
  ])

  return {
    harness,
    run: (...args) => git(harness.directory, ...args),
    oid: async (revision) => (await git(harness.directory, "rev-parse", revision)).trim(),
    shortOid: async (revision) => (await git(harness.directory, "rev-parse", "--short", revision)).trim(),
  }
}

/** Adds one commit touching its own file, so every commit is an independent change. */
async function commit(repo: Repo, subject: string): Promise<void> {
  await writeFile(join(repo.harness.directory, `${subject.replaceAll(" ", "-")}.txt`), `${subject}\n`)
  await repo.run("add", "--all")
  await repo.run("commit", "--quiet", "--message", subject)
}

/**
 * A key press, plus enough real time for the terminal parser to disambiguate it — a lone
 * escape byte is only a key once the parser has waited for the sequence it could start.
 */
async function press(harness: Harness, key: string, modifiers?: { readonly ctrl?: boolean }): Promise<void> {
  await act(async () => {
    harness.setup.mockInput.pressKey(key, modifiers)
    await Bun.sleep(60)
  })
  await settle(harness)
}

/**
 * Renders until the screen (or the repository) catches up. Menu actions are async and the
 * store refresh that follows them lands on its own turn, so the assertion is about the
 * settled result rather than whatever the next microtask happened to produce.
 */
async function waitUntil(harness: Harness, what: string, ready: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await settle(harness)
    if (await ready()) return
    await act(async () => {
      await Bun.sleep(30)
    })
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame(harness)}`)
}

function waitForFrame(harness: Harness, expected: string): Promise<void> {
  return waitUntil(harness, JSON.stringify(expected), () => frame(harness).includes(expected))
}

describe("searching commits", () => {
  it("jumps to a match without removing the commits around it", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "/")
    await act(async () => {
      await repo.harness.setup.mockInput.typeText("second")
    })
    await settle(repo.harness)
    await act(async () => {
      repo.harness.setup.mockInput.pressEnter()
      await Bun.sleep(60)
    })
    await settle(repo.harness)

    const rendered = frame(repo.harness)
    expect(rendered).toContain("first commit")
    expect(rendered).toContain("second commit")
    expect(rendered).toContain("third commit")
    expect(rendered).toContain("matches for 'second' (1 of 1)")
    expect(rendered).toContain(`diff: commit ${await repo.shortOid("HEAD~1")}`)
  })
})

describe("the commits action menu", () => {
  it("checks a commit out after saying that HEAD will be detached", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const parent = await repo.oid("HEAD~1")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")

    expect(frame(repo.harness)).toContain(`Commit ${await repo.shortOid("HEAD~1")}`)
    expect(frame(repo.harness)).toContain("Check out this commit")

    await press(repo.harness, "c")
    // The word that matters: a checkout from a log is a detach, and saying so before the
    // keypress is the difference between a feature and a trap.
    expect(frame(repo.harness)).toContain("HEAD will be detached at")

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "HEAD detached at")
    expect(await repo.oid("HEAD")).toBe(parent)
    expect((await repo.run("branch", "--show-current")).trim()).toBe("")
  })

  it("abandons the checkout when the confirmation is declined", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    const head = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "c")
    await press(repo.harness, "n")

    expect(await repo.oid("HEAD")).toBe(head)
    expect((await repo.run("branch", "--show-current")).trim()).toBe("main")
  })

  it("names what a hard reset destroys, then moves the branch", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const parent = await repo.oid("HEAD~1")
    // One tracked edit, so the confirmation has a real number to quote.
    await writeFile(join(repo.harness.directory, "first-commit.txt"), "edited\n")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "h")

    expect(frame(repo.harness)).toContain("1 uncommitted change destroyed for good")
    expect(frame(repo.harness)).toContain("reflog")

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Reset hard to")
    expect(await repo.oid("HEAD")).toBe(parent)
    // Still on the branch — a reset moves it, unlike the checkout above.
    expect((await repo.run("branch", "--show-current")).trim()).toBe("main")
    expect(await Bun.file(join(repo.harness.directory, "first-commit.txt")).text()).toBe("first commit\n")
  })

  it("keeps the working tree on a mixed reset, and says which index it is about to rearrange", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    const parent = await repo.oid("HEAD~1")
    // One staged edit, so the confirmation reports an index rearrangement as well as the
    // commit it drops.
    await writeFile(join(repo.harness.directory, "first-commit.txt"), "edited\n")
    await repo.run("add", "first-commit.txt")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "m")

    // A mixed reset moves the branch as far as the hard one, so it asks first — and says what
    // it costs.
    expect(frame(repo.harness)).toContain("1 staged change unstaged, though kept in the working tree")
    expect(frame(repo.harness)).toContain("1 commit off this branch, left only in the reflog")

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Reset mixed to")
    expect(await repo.oid("HEAD")).toBe(parent)
    // The file the undone commit added survives as untracked: mixed keeps the working tree.
    expect(await Bun.file(join(repo.harness.directory, "second-commit.txt")).text()).toBe("second commit\n")
    expect(await Bun.file(join(repo.harness.directory, "first-commit.txt")).text()).toBe("edited\n")
  })

  it("leaves the branch where it was when a soft reset is declined", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const head = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "s")

    // Soft touches neither the index nor the files, and still takes a commit off the branch
    // with only the reflog to get it back.
    expect(frame(repo.harness)).toContain("Reset soft to")
    expect(frame(repo.harness)).toContain("1 commit off this branch, left only in the reflog")

    await press(repo.harness, "n")
    expect(await repo.oid("HEAD")).toBe(head)
  })

  it("moves the branch on a soft reset once confirmed, leaving the undone commit staged", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    const head = await repo.oid("HEAD")
    const parent = await repo.oid("HEAD~1")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "s")

    // Nothing has moved yet — the popup is on screen and the reset is behind it.
    expect(await repo.oid("HEAD")).toBe(head)

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Reset soft to")
    expect(await repo.oid("HEAD")).toBe(parent)
    // Soft keeps the index, so the undone commit's file is staged rather than untracked.
    expect((await repo.run("diff", "--cached", "--name-only")).trim()).toBe("second-commit.txt")
  })

  it("reverts a commit without opening an editor", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    const head = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "x")
    await press(repo.harness, "v")

    expect(frame(repo.harness)).toContain("will undo")

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Reverted")
    expect(await repo.oid("HEAD")).not.toBe(head)
    // `git revert` would have hung on an editor; it did not, and the file is gone again.
    expect((await repo.run("log", "-1", "--format=%s")).trim()).toContain(`Revert "second commit"`)
    expect(await Bun.file(join(repo.harness.directory, "second-commit.txt")).exists()).toBe(false)
  })

  it("withholds revert on a merge, which git refuses without a mainline", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await repo.run("checkout", "--quiet", "-b", "feature")
    await commit(repo, "feature work")
    await repo.run("checkout", "--quiet", "main")
    await commit(repo, "main work")
    await repo.run("merge", "--quiet", "--no-ff", "--no-edit", "-m", "merge feature", "feature")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "x")

    // The merge is the newest commit and so the selected row. Offering the item here would
    // promise an undo `git revert` rejects for want of `-m`.
    expect(frame(repo.harness)).toContain("Check out this commit")
    expect(frame(repo.harness)).not.toContain("Revert this commit")
    expect(frame(repo.harness)).not.toContain("Squash into the parent commit")
    expect(frame(repo.harness)).not.toContain("Reword this commit")
    expect(frame(repo.harness)).not.toContain("Drop this commit")

    // `"ESCAPE"`, not `"escape"`: the mock sends a named key's byte sequence and any other
    // string as literal characters, so the lowercase spelling would type e-s-c-a-p-e.
    await press(repo.harness, "ESCAPE")
    await press(repo.harness, "j")
    await press(repo.harness, "x")

    // Back on the very next row, so this is a gate on merges and not a missing feature.
    expect(frame(repo.harness)).toContain("Revert this commit")
  })

  it("hides the remote item when the remote is a directory nobody can browse", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await repo.run("remote", "add", "origin", repo.harness.directory)

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "x")

    expect(frame(repo.harness)).toContain("Check out this commit")
    expect(frame(repo.harness)).not.toContain("Open this commit on the remote")
  })

  it("offers the remote item when the remote has a web address", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await repo.run("remote", "add", "origin", "git@github.com:acme/tools.git")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "x")

    expect(frame(repo.harness)).toContain("Open this commit on the remote")
  })

  it("squashes the selected commit into its parent and replays newer history", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const originalHead = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "q")

    expect(frame(repo.harness)).toContain("will be folded into")
    expect(frame(repo.harness)).toContain("every newer commit will get a new oid")

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Pushed history now needs force-with-lease")

    expect(await repo.oid("HEAD")).not.toBe(originalHead)
    expect(await repo.run("log", "--format=%s")).toBe("third commit\nfirst commit\n")
    expect(await repo.run("show", "-s", "--format=%B", "HEAD~1")).toContain("second commit")
  })

  it("drops the selected commit and replays the commits above it", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const droppedFile = join(repo.harness.directory, "second-commit.txt")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "d")

    expect(frame(repo.harness)).toContain("will be removed and every newer")
    expect(frame(repo.harness)).toContain("commit replayed")
    expect(frame(repo.harness)).toContain("history remains recoverable")
    expect(frame(repo.harness)).toContain("from the reflog")

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Pushed history now needs force-with-lease")

    expect(await repo.run("log", "--format=%s")).toBe("third commit\nfirst commit\n")
    expect(await Bun.file(droppedFile).exists()).toBe(false)
  })

  it("rewords an older commit in the full message editor", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "r")
    await waitForFrame(repo.harness, "amending the last commit")

    expect(frame(repo.harness)).toContain("amending the last commit")
    expect(frame(repo.harness)).toContain("second commit")
    await act(async () => {
      await repo.harness.setup.mockInput.typeText(" reworded")
    })
    await settle(repo.harness)
    await press(repo.harness, "s", { ctrl: true })
    await waitForFrame(repo.harness, "Pushed history now needs force-with-lease")

    expect(await repo.run("log", "--format=%s")).toBe("third commit\nsecond commit reworded\nfirst commit\n")
    expect((await repo.run("status", "--porcelain")).trim()).toBe("")
  })

  it("restores the original history when rewording is cancelled", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const originalHead = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "r")
    await waitForFrame(repo.harness, "amending the last commit")
    await press(repo.harness, "ESCAPE")
    await waitForFrame(repo.harness, "Reword cancelled; original history restored")

    expect(await repo.oid("HEAD")).toBe(originalHead)
    expect(await repo.run("log", "--format=%s")).toBe("third commit\nsecond commit\nfirst commit\n")
    expect((await repo.run("status", "--porcelain")).trim()).toBe("")
  })

  it("refuses to rewrite while the working tree is dirty", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    const originalHead = await repo.oid("HEAD")
    await writeFile(join(repo.harness.directory, "first-commit.txt"), "unfinished\n")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "x")
    await press(repo.harness, "q")
    await waitForFrame(repo.harness, "Commit rewrites need a clean working tree")

    expect(await repo.oid("HEAD")).toBe(originalHead)
    expect(await Bun.file(join(repo.harness.directory, "first-commit.txt")).text()).toBe("unfinished\n")
  })

  it("aborts a conflicting drop and restores the original history", async () => {
    const repo = await openRepo()
    const path = join(repo.harness.directory, "shared.txt")
    await writeFile(path, "base\n")
    await repo.run("add", "shared.txt")
    await repo.run("commit", "--quiet", "--message", "first commit")
    await writeFile(path, "second\n")
    await repo.run("commit", "--quiet", "--all", "--message", "second commit")
    await writeFile(path, "third\n")
    await repo.run("commit", "--quiet", "--all", "--message", "third commit")
    const originalHead = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "3")
    await press(repo.harness, "j")
    await press(repo.harness, "x")
    await press(repo.harness, "d")
    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Rewrite failed; original history restored")

    expect(await repo.oid("HEAD")).toBe(originalHead)
    expect(await repo.run("log", "--format=%s")).toBe("third commit\nsecond commit\nfirst commit\n")
    expect(await Bun.file(path).text()).toBe("third\n")
    expect((await repo.run("status", "--porcelain")).trim()).toBe("")
  })
})
