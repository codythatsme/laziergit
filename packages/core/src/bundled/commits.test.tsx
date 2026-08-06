import { describe, expect, it } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  pressEscape,
  renderApp,
  waitFor,
  waitForFrame,
  type Harness,
  type HarnessOptions,
} from "../test-harness"

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

/** The commits Pane renders author initials, so this fixture uses a recognisable two-part name. */
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
 * Every mutation these tests make goes through laziergit, so the fingerprint poll is parked.
 */
function layout(): string {
  return `{ "layout": { "columns": [["diff"], ["commits"]] }, "git": { "refreshIntervalMs": 60000 } }`
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

async function openRepo(
  options: {
    readonly config?: string
    readonly git?: boolean
    readonly clipboardWriters?: HarnessOptions["clipboardWriters"]
  } = {},
): Promise<Repo> {
  const harness = await createHarness({ git: options.git ?? true, clipboardWriters: options.clipboardWriters })
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
async function commit(repo: Repo, subject: string, author?: string): Promise<void> {
  await writeFile(join(repo.harness.directory, `${subject.replaceAll(" ", "-")}.txt`), `${subject}\n`)
  await repo.run("add", "--all")
  await repo.run("commit", "--quiet", ...(author === undefined ? [] : ["--author", author]), "--message", subject)
}

/** Waits until the highlighted commit has reached the shared RowSource and diff Pane. */
async function waitForSelection(repo: Repo, revision: string): Promise<void> {
  const short = await repo.shortOid(revision)
  await waitForFrame(repo.harness, `diff: commit ${short}`)
}

function commandIds(repo: Repo): readonly string[] {
  return repo.harness.kernel.commands.getSnapshot().map((command) => command.id)
}

/**
 * Confirms a reset and waits for its success toast. The toast repeats the confirmation's
 * title word for word, so the wait also requires the confirmation's message to be gone —
 * `title` alone would match the popup that is still closing.
 */
async function confirmReset(repo: Repo, title: string, message: string, target: string): Promise<void> {
  await press(repo.harness, "y")
  await waitForFrame(repo.harness, (screen) => screen.includes(title) && !screen.includes(message))
  // The store's head is the write's last effect; the toast text alone can coincide with
  // popup chrome still leaving the frame.
  await waitFor(
    repo.harness,
    () => {
      const head = repo.harness.kernel.git.getSnapshot().head
      return head.kind === "onBranch" && head.oid === target
    },
    `HEAD to move to ${target}`,
  )
}

describe("searching commits", () => {
  it("jumps to a match without removing the commits around it", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const match = await repo.shortOid("HEAD~1")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "/")
    await waitForFrame(repo.harness, "Search: ")
    await press(repo.harness, () => void repo.harness.setup.mockInput.typeText("second"))
    await press(repo.harness, () => repo.harness.setup.mockInput.pressEnter())

    await waitForFrame(repo.harness, "matches for 'second' (1 of 1)")
    // The landing pushes the match into the diff, which is the jump's last observable effect.
    await waitForFrame(repo.harness, `diff: commit ${match}`)
    const rendered = frame(repo.harness)
    expect(rendered).toContain("first commit")
    expect(rendered).toContain("second commit")
    expect(rendered).toContain("third commit")
  })
})

describe("identifying commit authors", () => {
  it("shows lazygit-style initials beside each commit instead of long names", async () => {
    const repo = await openRepo()
    await commit(repo, "analytical engine")
    await commit(repo, "compiler notes", "Grace Hopper <grace@example.com>")
    const compiler = await repo.shortOid("HEAD")
    const engine = await repo.shortOid("HEAD~1")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await waitForFrame(repo.harness, `${compiler} GH ○ compiler notes`)

    const rendered = frame(repo.harness)
    expect(rendered).toContain(`${engine} AL ○ analytical engine`)
    expect(rendered).not.toContain("Ada Lovelace")
    expect(rendered).not.toContain("Grace Hopper")
  })
})

describe("viewing files changed by a commit", () => {
  it("dives into a root commit, narrows the diff as the cursor moves, and returns with escape", async () => {
    const repo = await openRepo()
    await writeFile(join(repo.harness.directory, "alpha.txt"), "alpha\n")
    await writeFile(join(repo.harness.directory, "beta.txt"), "beta\n")
    await repo.run("add", "--all")
    await repo.run("commit", "--quiet", "--message", "initial pair")
    const head = await repo.shortOid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "\r")
    await waitForFrame(repo.harness, "A  alpha.txt")

    const filesFrame = frame(repo.harness)
    expect(filesFrame).toContain(`${head}  initial pair`)
    expect(filesFrame).toContain("A  alpha.txt")
    expect(filesFrame).toContain("A  beta.txt")
    expect(filesFrame).toContain(`diff: commit ${head} path=alpha.txt`)

    await press(repo.harness, "j")
    await waitForFrame(repo.harness, `diff: commit ${head} path=beta.txt`)

    await pressEscape(repo.harness)
    await waitForFrame(repo.harness, `diff: commit ${head} path=none`)
    expect(frame(repo.harness)).not.toContain("A  alpha.txt")
    expect(frame(repo.harness)).not.toContain("A  beta.txt")
  })

  it("keeps both paths of a rename intact and diffs the destination", async () => {
    const repo = await openRepo()
    await writeFile(join(repo.harness.directory, "before.txt"), "same contents\n")
    await repo.run("add", "--all")
    await repo.run("commit", "--quiet", "--message", "add original")
    await repo.run("mv", "before.txt", "after.txt")
    await repo.run("commit", "--quiet", "--all", "--message", "rename original")
    const head = await repo.shortOid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "\r")
    await waitForFrame(repo.harness, "before.txt → after.txt")

    expect(frame(repo.harness)).toContain("R  before.txt → after.txt")
    await waitForFrame(repo.harness, `diff: commit ${head} path=after.txt`)
  })

  it("returns to the commit that was opened rather than jumping back to HEAD", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const second = await repo.shortOid("HEAD~1")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await press(repo.harness, "\r")
    await waitForFrame(repo.harness, "A  second-commit.txt")

    await pressEscape(repo.harness)
    await waitForFrame(repo.harness, `diff: commit ${second} path=none`)

    // Enter again proves the restored commit owns the cursor, not merely the last diff frame.
    await press(repo.harness, "\r")
    await waitForFrame(repo.harness, "A  second-commit.txt")
    expect(frame(repo.harness)).toContain(`diff: commit ${second} path=second-commit.txt`)
  })
})

describe("creating a branch from a commit", () => {
  it("creates and checks out a branch at the highlighted commit with n", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const selected = await repo.oid("HEAD~1")
    const short = await repo.shortOid("HEAD~1")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await press(repo.harness, "n")
    await waitForFrame(repo.harness, `New branch at ${short}`)

    await press(repo.harness, () => void repo.harness.setup.mockInput.typeText("feature/from-second"))
    await press(repo.harness, () => repo.harness.setup.mockInput.pressEnter())

    // From the store, so the wait also covers the write's follow-up refresh.
    await waitFor(
      repo.harness,
      () => {
        const head = repo.harness.kernel.git.getSnapshot().head
        return head.kind === "onBranch" && head.branch === "feature/from-second"
      },
      "the new branch to be checked out at the highlighted commit",
    )
    expect(await repo.oid("HEAD")).toBe(selected)
    expect(await repo.oid("feature/from-second")).toBe(selected)
  })
})

describe("contextual commit Commands", () => {
  it("copies the selected commit's full hash with the primary modifier and C", async () => {
    const repo = await openRepo({
      clipboardWriters: [
        [process.execPath, ["-e", "if (!/^[0-9a-f]{40}$/.test(await Bun.stdin.text())) process.exit(1)"]],
      ],
    })
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    const selected = await repo.shortOid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await waitForSelection(repo, "HEAD")
    await press(repo.harness, "c", { ctrl: true })

    await waitForFrame(repo.harness, `Copied ${selected}`)
  })

  it("checks a commit out after saying that HEAD will be detached", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const parent = await repo.oid("HEAD~1")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")

    await press(repo.harness, "c")
    // The word that matters: a checkout from a log is a detach, and saying so before the
    // keypress is the difference between a feature and a trap.
    await waitForFrame(repo.harness, "HEAD will be detached at")

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
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "c")
    await waitForFrame(repo.harness, "HEAD will be detached at")

    await press(repo.harness, "n")
    // The popup leaving is the decline's only effect; nothing reaches git behind it.
    await waitForFrame(repo.harness, (screen) => !screen.includes("HEAD will be detached at"))
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
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "h")

    await waitForFrame(repo.harness, "1 uncommitted change destroyed for good")
    expect(frame(repo.harness)).toContain("reflog")

    await confirmReset(repo, "Reset hard to", "destroyed for good", parent)
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
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "m")

    // A mixed reset moves the branch as far as the hard one, so it asks first — and says what
    // it costs.
    await waitForFrame(repo.harness, "1 staged change unstaged, though kept in the working tree")
    expect(frame(repo.harness)).toContain("1 commit off this branch, left only in the reflog")

    await confirmReset(repo, "Reset mixed to", "though kept in the working tree", parent)
    expect(await repo.oid("HEAD")).toBe(parent)
    // The file the undone commit added survives as untracked: mixed keeps the working tree.
    expect(await Bun.file(join(repo.harness.directory, "second-commit.txt")).text()).toBe("second commit\n")
    expect(await Bun.file(join(repo.harness.directory, "first-commit.txt")).text()).toBe("edited\n")
  })

  it("reverts a commit without opening an editor", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    const head = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await waitForSelection(repo, "HEAD")
    await press(repo.harness, "v")

    await waitForFrame(repo.harness, "will undo")

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
    const mergeOid = await repo.shortOid("HEAD")
    const featureOid = await repo.shortOid("feature")
    const mainOid = await repo.shortOid("HEAD^1")
    const rootOid = await repo.shortOid("HEAD^1^1")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    // The merge is the newest commit and so the selected row. Offering these Commands here
    // would promise rewrites git refuses or whose mainline the Pane cannot choose.
    await waitForSelection(repo, "HEAD")

    // The graph is calculated from the same topo-ordered Commit objects the cursor and diff use:
    // the second parent opens to the right, stays live beside its commit, then joins main again.
    const rendered = frame(repo.harness)
    expect(rendered).toContain(`${mergeOid} AL ◎─╮ merge feature`)
    expect(rendered).toContain(`${featureOid} AL │ ○ feature work`)
    expect(rendered).toContain(`${mainOid} AL ○ │ main work`)
    expect(rendered).toContain(`${rootOid} AL ○─╯ first commit`)

    const merge = commandIds(repo)
    expect(merge).toContain("commits.checkout")
    expect(merge).not.toContain("commits.revert")
    expect(merge).not.toContain("commits.squash")
    expect(merge).not.toContain("commits.reword")
    expect(merge).not.toContain("commits.drop")

    await press(repo.harness, "j")
    await waitForSelection(repo, "feature")

    // The topo-ordered next row is the merged feature tip. It is not a merge itself, proving
    // this is a gate on merges and not a missing Command.
    expect(commandIds(repo)).toContain("commits.revert")
  })

  it("hides the remote item when the remote is a directory nobody can browse", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await repo.run("remote", "add", "origin", repo.harness.directory)

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await waitForSelection(repo, "HEAD")

    expect(commandIds(repo)).toContain("commits.checkout")
    expect(commandIds(repo)).not.toContain("commits.open-remote")
  })

  it("offers the remote item when the remote has a web address", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await repo.run("remote", "add", "origin", "git@github.com:acme/tools.git")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await waitForSelection(repo, "HEAD")

    expect(commandIds(repo)).toContain("commits.open-remote")
  })

  it("squashes the selected commit into its parent and replays newer history", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")
    const originalHead = await repo.oid("HEAD")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "s")

    await waitForFrame(repo.harness, "will be folded into")
    expect(frame(repo.harness)).toContain("every newer commit will get a new oid")
    expect(commandIds(repo)).not.toContain("commits.reset-soft")

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
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "d")

    await waitForFrame(repo.harness, "will be removed and every newer")
    const confirmation = frame(repo.harness)
    expect(confirmation).toContain("commit replayed")
    expect(confirmation).toContain("history remains recoverable")
    expect(confirmation).toContain("from the reflog")

    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Pushed history now needs force-with-lease")

    expect(await repo.run("log", "--format=%s")).toBe("third commit\nfirst commit\n")
    expect(await Bun.file(droppedFile).exists()).toBe(false)
  })

  it("rewords an older commit in the message popup", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await commit(repo, "third commit")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "r")
    await waitForFrame(repo.harness, "Amend the last commit")

    expect(frame(repo.harness)).toContain("second commit")
    await press(repo.harness, () => void repo.harness.setup.mockInput.typeText(" reworded"))
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
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "r")
    await waitForFrame(repo.harness, "Amend the last commit")
    await pressEscape(repo.harness)
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
    await press(repo.harness, "2")
    await waitForSelection(repo, "HEAD")
    await press(repo.harness, "s")
    await waitForFrame(repo.harness, "Commit rewrites need a clean working tree")

    expect(await repo.oid("HEAD")).toBe(originalHead)
    expect(await Bun.file(join(repo.harness.directory, "first-commit.txt")).text()).toBe("unfinished\n")
  })

  it("ignores a stale REBASE_HEAD when no rebase is active", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")
    await writeFile(join(repo.harness.directory, ".git", "REBASE_HEAD"), `${await repo.oid("HEAD")}\n`)

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await waitForSelection(repo, "HEAD")
    await press(repo.harness, "d")
    await waitFor(
      repo.harness,
      () => {
        const rendered = frame(repo.harness)
        return (
          rendered.includes("will be removed and every newer") ||
          rendered.includes("Finish or abort the current Git operation")
        )
      },
      "the rewrite readiness decision",
    )

    expect(frame(repo.harness)).toContain("will be removed and every newer")
  })

  it("refuses to rewrite while a rebase state directory exists", async () => {
    const repo = await openRepo()
    await commit(repo, "first commit")
    await commit(repo, "second commit")

    await renderApp(repo.harness)
    await press(repo.harness, "2")
    await waitForSelection(repo, "HEAD")
    await mkdir(join(repo.harness.directory, ".git", "rebase-merge"))
    await press(repo.harness, "d")
    await waitFor(
      repo.harness,
      () => {
        const rendered = frame(repo.harness)
        return (
          rendered.includes("will be removed and every newer") ||
          rendered.includes("Finish or abort the current Git operation")
        )
      },
      "the rewrite readiness decision",
    )

    expect(frame(repo.harness)).toContain("Finish or abort the current Git operation")
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
    await press(repo.harness, "2")
    await press(repo.harness, "j")
    await waitForSelection(repo, "HEAD~1")
    await press(repo.harness, "d")
    await waitForFrame(repo.harness, "will be removed and every newer")
    await press(repo.harness, "y")
    await waitForFrame(repo.harness, "Rewrite failed; original history restored")

    expect(await repo.oid("HEAD")).toBe(originalHead)
    expect(await repo.run("log", "--format=%s")).toBe("third commit\nsecond commit\nfirst commit\n")
    expect(await Bun.file(path).text()).toBe("third\n")
    expect((await repo.run("status", "--porcelain")).trim()).toBe("")
  })
})
