import { describe, expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, linked into the bundled scope the way `main.tsx` loads it. */
const branchesExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "branches")

/**
 * Stands in for the diff Extension, which `branches` needs.
 *
 * A stub rather than the real one keeps this file about branches — the {@link DiffTarget}
 * the branches pane asks for is on screen where an assertion can see it, and a sibling
 * Extension's bugs cannot fail these tests.
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
        const ref = current === null ? "" : String(current.ref).slice(0, 7)
        return <text content={current === null ? "diff none" : "diff " + current.kind + " " + ref} />
      }

      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane })
      return { current: () => target.get(), show: (next) => target.set(next) }
    },
  })
`

/**
 * A consumer of the exported `BranchesApi` — the flagship seam, in miniature: it decorates
 * rows it does not own and reads the selection it does not track.
 */
const consumerStub = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "prs",
    needs: ["branches"],
    activate(ctx) {
      const branches = ctx.extensions.get("branches")
      branches.decorateRows((branch) => (branch.name === "topic" ? { badge: "#7 draft", tone: "warning" } : undefined))
      ctx.commands.register({
        id: "prs.selected",
        title: "Report the selected branch",
        keys: "shift+v",
        run: () => ctx.popups.notify("selection is " + (branches.selected()?.name ?? "none")),
      })
    },
  })
`

/**
 * Pinned identity and no user config, so a developer's own `~/.gitconfig` cannot change what
 * these tests observe — the same isolation the harness itself initialises the repository with.
 */
async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: harness.directory,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
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
 * One commit on `main`. The harness directory is also the Extension, config and remote home,
 * so all of that scaffolding is ignored — otherwise every commit here would sweep it in.
 */
async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".gitignore"), "bundled/\nglobal/\nrepo/\norigin.git/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "work.txt"), "one\n")
  await git(harness, "add", ".gitignore", "work.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")
}

/** A bare repository inside the (ignored) harness directory, so it is cleaned up with it. */
async function addOrigin(harness: Harness): Promise<void> {
  await git(harness, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", "origin.git")
  await git(harness, "remote", "add", "origin", join(harness.directory, "origin.git"))
}

async function commit(harness: Harness, contents: string, message: string, date?: string): Promise<void> {
  await writeFile(join(harness.directory, "work.txt"), contents)
  await git(
    harness,
    "commit",
    "--quiet",
    "--all",
    ...(date === undefined ? [] : ["--date", date]),
    "--message",
    message,
  )
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
 * Renders with the real branches Extension loaded.
 *
 * Startup focus is the Layout's first cell — not whichever Extension activated first — so
 * a test that needs the branches Pane *unfocused* writes a Layout that puts the diff Pane
 * in front of it. The branches case still presses `3`: it is the key a user reaches for,
 * and one of the things under test.
 *
 * `"tabbed"` puts both Panes in one cell, where `]` hides — and therefore unmounts — the one
 * that was showing. That is the only way a user makes this Pane go away without quitting.
 */
async function start(harness: Harness, focus: "branches" | "diff" | "tabbed" = "branches"): Promise<void> {
  const columns =
    focus === "tabbed"
      ? `[[["branches", "diff"]]]`
      : focus === "branches"
        ? `[["branches"], ["diff"]]`
        : `[["diff"], ["branches"]]`
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(harness.configFiles.repo, `{ "layout": { "columns": ${columns} } }`),
  ])
  await renderApp(harness)
  if (focus === "branches") await press(harness, () => harness.setup.mockInput.pressKey("3"))
}

/** Waits for work a keypress started — a git write, then the refresh and render behind it. */
async function waitUntil(
  harness: Harness,
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await settle(harness)
    // Inside `act`, because the condition shells out to git: the store can publish and the
    // Panes re-render while it is running, and a render React did not know it was driving
    // is a warning on stderr about an update the test really did cause.
    let met = false
    await act(async () => {
      met = await condition()
    })
    if (met) return
    await act(async () => {
      await Bun.sleep(30)
    })
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame(harness)}`)
}

const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000 - 3_600_000).toISOString()

describe("the branches pane", () => {
  it("shows a deleted upstream as gone, never as in sync", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    await commit(harness, "two\n", "second commit")

    // Pushed, then deleted *in the remote repository* and pruned — the way a branch really
    // goes away when someone else deletes it, rather than by a local `push --delete` that
    // drops the tracking ref as a side effect. git then reports `gone` *instead of* a
    // divergence, so this branch's ahead/behind are 0: byte-identical to an in-sync branch,
    // and the only thing that tells them apart is the flag this row has to read.
    await git(harness, "checkout", "--quiet", "-b", "doomed")
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "doomed")
    await git(harness, "--git-dir", join(harness.directory, "origin.git"), "update-ref", "-d", "refs/heads/doomed")
    await git(harness, "fetch", "--quiet", "--prune", "origin")
    expect(await git(harness, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/doomed")).toBe("")
    expect(await git(harness, "for-each-ref", "--format=%(upstream:track,nobracket)", "refs/heads/doomed")).toBe("gone")
    await git(harness, "checkout", "--quiet", "main")
    await git(harness, "branch", "solo")
    await git(harness, "checkout", "--quiet", "-b", "ancient")
    await commit(harness, "old\n", "old work", threeDaysAgo)
    await git(harness, "checkout", "--quiet", "main")

    await start(harness)
    const rendered = frame(harness)

    // HEAD is marked and listed first, and it is one commit ahead of the remote.
    expect(rendered).toContain("* main")
    expect(rendered).toContain("↑1")
    expect(rendered.indexOf("main")).toBeLessThan(rendered.indexOf("doomed"))
    // The whole point of the field: `doomed` and `solo` must not read alike, and neither
    // may read like `main`.
    expect(rendered).toContain("gone")
    expect(rendered).toContain("no upstream")
    expect(rendered).toContain("3d")
  }, 30_000)

  it("renders an empty state in an unborn repository instead of a blank pane", async () => {
    const harness = await createHarness({ git: true })

    await start(harness)

    expect(frame(harness)).toContain("no branches yet")
    expect(harness.kernel.diagnostics.getSnapshot()).toEqual([])
  })

  it("says there is no repository rather than offering to create a branch in one", async () => {
    // No `git: true`: the store serves its empty snapshot, whose unborn HEAD carries the
    // nameless branch. Zero branches here means something else entirely.
    const harness = await createHarness()

    await start(harness)

    expect(frame(harness)).toContain("no repository")
    expect(frame(harness)).not.toContain("n creates one")

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    // No prompt: an offer git could only refuse is worse than no offer.
    expect(frame(harness)).not.toContain("New branch")
    expect(frame(harness)).toContain("No repository here to branch from")
  })

  it("follows the cursor into the diff pane, but only once it is focused", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    // Its own commit, so the two rows are two different targets.
    await git(harness, "checkout", "--quiet", "-b", "other")
    await commit(harness, "two\n", "other work")
    await git(harness, "checkout", "--quiet", "main")
    const main = await git(harness, "rev-parse", "main")

    // A Layout with the diff Pane first, so it holds startup focus and nothing has asked
    // it for anything yet.
    await start(harness, "diff")
    expect(frame(harness)).toContain("diff none")

    await press(harness, () => harness.setup.mockInput.pressKey("3"))
    expect(frame(harness)).toContain(`diff commit ${main.slice(0, 7)}`)

    const other = await git(harness, "rev-parse", "other")
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    expect(frame(harness)).toContain(`diff commit ${other.slice(0, 7)}`)
  }, 30_000)

  it("lets another Extension badge a row and read the selection", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "topic")
    await writeFile(join(harness.repo, "prs.tsx"), consumerStub)

    await start(harness)
    expect(frame(harness)).toContain("#7 draft")

    await press(harness, () => harness.setup.mockInput.pressKey("V"))
    expect(frame(harness)).toContain("selection is main")

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("V"))
    expect(frame(harness)).toContain("selection is topic")
  }, 30_000)

  it("stops naming a selection once the pane is tabbed away", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "topic")
    await writeFile(join(harness.repo, "prs.tsx"), consumerStub)

    await start(harness, "tabbed")
    // Focusing a Pane also brings its tab to the front, which is what makes it mounted.
    await press(harness, () => harness.setup.mockInput.pressKey("3"))
    await press(harness, () => harness.setup.mockInput.pressKey("V"))
    expect(frame(harness)).toContain("selection is main")

    // `]` swaps the cell to the diff Pane, which unmounts this one. A hidden Pane has no
    // cursor, so it must not keep answering for one — the consumer would otherwise act on a
    // row nothing is pointing at.
    await press(harness, () => harness.setup.mockInput.pressKey("]"))
    await press(harness, () => harness.setup.mockInput.pressKey("V"))
    expect(frame(harness)).toContain("selection is none")
  }, 30_000)

  it("scrolls the cursor into view instead of walking it off the bottom of the pane", async () => {
    // Shorter than the branch list by a wide margin, so "the cursor is visible" can only be
    // true because the Pane scrolled. Wide enough that no row wraps: a wrapped row occupies
    // two lines and the cursor counts rows, not lines.
    const harness = await createHarness({ git: true, width: 100, height: 14 })
    await seed(harness)
    for (const index of Array.from({ length: 30 }, (_, at) => at)) {
      await git(harness, "branch", `br-${String(index).padStart(2, "0")}`)
    }

    await start(harness)
    // The trailing space keeps `br-00` from also matching `br-00x`, and proves the far end
    // of the list really is off screen to begin with.
    expect(frame(harness)).toContain("br-00 ")
    expect(frame(harness)).not.toContain("br-29 ")

    await press(harness, () => harness.setup.mockInput.pressKey("G"))

    expect(frame(harness)).toContain("br-29 ")
    // The frame around the Pane survived: a scrollbox sized by its content grows past its
    // Pane and paints across the border and title instead of scrolling inside them.
    expect(frame(harness)).toContain("Branches")
  }, 60_000)
})

describe("checking out", () => {
  it("switches to the selected branch, and says so rather than doing nothing on HEAD", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "other")

    await start(harness)

    // The cursor starts on HEAD, where a checkout would succeed and change nothing.
    await press(harness, () => harness.setup.mockInput.pressKey(" "))
    expect(frame(harness)).toContain("Already on main")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey(" "))
    // The marker moves because the store refreshed behind the write, which is the whole
    // reason a checkout goes through the porcelain helper rather than `raw`.
    await waitUntil(harness, async () => frame(harness).includes("* other"), "the pane to follow the checkout")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other")
  }, 30_000)
})

describe("creating a branch", () => {
  it("refuses a nameless branch, then creates one at the selected branch and checks it out", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    expect(frame(harness)).toContain("New branch at main")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    expect(frame(harness)).toContain("Name the branch")

    await press(harness, () => void harness.setup.mockInput.typeText("feature/x"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitUntil(
      harness,
      async () => (await git(harness, "rev-parse", "--abbrev-ref", "HEAD")) === "feature/x",
      "the new branch to be checked out",
    )
    // Created *at* the selected branch, which is what "here" in the menu label means.
    expect(await git(harness, "rev-parse", "feature/x")).toBe(await git(harness, "rev-parse", "main"))
  }, 30_000)

  it("refuses a name with a space in it, which git would only reject later", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    await press(harness, () => void harness.setup.mockInput.typeText("two words"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    expect(frame(harness)).toContain("cannot contain spaces")
    expect(await git(harness, "branch", "--list", "--format=%(refname:short)")).toBe("main")
  }, 30_000)
})

describe("deleting a branch", () => {
  /** `wip` carries a commit no other branch has, which is what `-d` refuses. */
  async function withUnmergedBranch(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "wip")
    await commit(harness, "wip\n", "unmerged work")
    await git(harness, "checkout", "--quiet", "main")
  }

  it("offers a force delete when git refuses an unmerged branch", async () => {
    const harness = await createHarness({ git: true })
    await withUnmergedBranch(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    expect(frame(harness)).toContain("Delete wip?")

    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    // git's refusal is read, not assumed: the second confirm only appears because the branch
    // is unmerged, and it says which commits are at stake.
    await waitUntil(harness, async () => frame(harness).includes("Force delete wip?"), "the force confirm to open")
    expect(frame(harness)).toContain("commits no other branch has")

    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitUntil(
      harness,
      async () => (await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")) === "",
      "the branch to be deleted",
    )
  }, 30_000)

  it("keeps the branch when the force confirm is declined", async () => {
    const harness = await createHarness({ git: true })
    await withUnmergedBranch(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("d"))
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitUntil(harness, async () => frame(harness).includes("Force delete wip?"), "the force confirm to open")

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    await settle(harness)

    expect(await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")).toBe("wip")
    expect(frame(harness)).not.toContain("Force delete wip?")
  }, 30_000)

  it("refuses to delete the branch you are on, without asking git", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("d"))

    expect(frame(harness)).toContain("you are on it")
    expect(frame(harness)).not.toContain("Delete main?")
  }, 30_000)
})

describe("the branch menu", () => {
  /**
   * `stale` sits one commit behind `origin/main` with nothing of its own — the only shape a
   * fast-forward is legal for. `main` is in sync, and is HEAD.
   */
  async function withBehindBranch(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "branch", "stale")
    await commit(harness, "two\n", "second commit")
    await addOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    await git(harness, "branch", "--set-upstream-to", "origin/main", "--", "stale")
  }

  it("hides what does not apply to the branch it was opened for", async () => {
    const harness = await createHarness({ git: true })
    await withBehindBranch(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    const onHead = frame(harness)
    expect(onHead).toContain("Branch: main")
    expect(onHead).toContain("Create branch here")
    // Nothing that would act on the branch you are standing on.
    expect(onHead).not.toContain("Check out")
    expect(onHead).not.toContain("Delete")
    // In sync is not behind, so there is nothing to fast-forward.
    expect(onHead).not.toContain("Fast-forward")

    await press(harness, () => harness.setup.mockInput.pressEscape())
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    const onStale = frame(harness)
    expect(onStale).toContain("Branch: stale")
    expect(onStale).toContain("Check out")
    expect(onStale).toContain("Force delete")
    expect(onStale).toContain("Fast-forward")
    // It has an upstream already, so there is nothing to set one up for.
    expect(onStale).not.toContain("Push, setting upstream")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  }, 30_000)

  it("fast-forwards a branch that is not checked out", async () => {
    const harness = await createHarness({ git: true })
    await withBehindBranch(harness)
    const target = await git(harness, "rev-parse", "main")
    expect(await git(harness, "rev-parse", "stale")).not.toBe(target)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("f"))

    await waitUntil(
      harness,
      async () => (await git(harness, "rev-parse", "stale")) === target,
      "stale to catch up with its upstream",
    )
    // The user never left the branch they were on.
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("offers to push a branch that has no upstream, and sets one", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    expect(frame(harness)).toContain("Push, setting upstream")

    await press(harness, () => harness.setup.mockInput.pressKey("p"))
    // The row goes from "no upstream" to in sync, which is the whole visible outcome.
    await waitUntil(harness, async () => frame(harness).includes("✓"), "the row to report an upstream")
    expect(await git(harness, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/main")).toBe(
      "origin/main",
    )
  }, 30_000)

  it("sets an upstream from a prompt prefilled with the ref a push would have used", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)
    // Pushed once, then untracked: `origin/topic` exists, but the branch does not know it.
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "topic")
    await git(harness, "branch", "--unset-upstream", "topic")
    await git(harness, "checkout", "--quiet", "main")

    await start(harness)
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    expect(frame(harness)).toContain("no upstream")

    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("u"))
    expect(frame(harness)).toContain("Upstream for topic")
    expect(frame(harness)).toContain("origin/topic")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitUntil(
      harness,
      async () => (await git(harness, "config", "--get", "branch.topic.merge")) === "refs/heads/topic",
      "the upstream to be configured",
    )
  }, 30_000)
})
