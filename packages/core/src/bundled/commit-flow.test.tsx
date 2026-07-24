import { describe, expect, it } from "bun:test"
import { chmod, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, symlinked into the harness's bundled scope (see bundled.test.tsx). */
const commitFlowExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commit-flow")

/**
 * The harness directory is the repository, the Extension home, and where the kernel writes
 * `config.schema.json` — so everything it generates is ignored, `.gitignore` included, or the
 * staged summary under test would be reporting the scaffolding.
 */
const ignored = ".gitignore\nbundled/\nglobal/\nrepo/\n*.json\n*.jsonc\n"

/** Pinned identity and no user config, so a developer's `~/.gitconfig` cannot move a fixture. */
const isolation: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
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
 * A repository the Extension can commit into.
 *
 * These commits are made by the git service, which inherits the *process* environment, so the
 * identity and hook settings the other fixtures pass as env vars have to be written into the
 * repository itself — otherwise a developer's global `user.email`, signing key, or
 * `core.hooksPath` would decide whether `git commit` succeeds here.
 */
async function repository(options: { readonly onQuit?: () => void } = {}): Promise<Harness> {
  const harness = await createHarness({ git: true, onQuit: options.onQuit })
  await writeFile(join(harness.directory, ".gitignore"), ignored)
  await git(harness.directory, "config", "user.name", "Test")
  await git(harness.directory, "config", "user.email", "test@example.com")
  await git(harness.directory, "config", "commit.gpgsign", "false")
  await git(harness.directory, "config", "core.hooksPath", ".git/hooks")
  return harness
}

/** The common starting point: one commit on `main`. */
async function seed(harness: Harness, ...message: readonly string[]): Promise<void> {
  await writeFile(join(harness.directory, "tracked.txt"), "one\n")
  await git(harness.directory, "add", "tracked.txt")
  await git(
    harness.directory,
    "commit",
    "--quiet",
    ...(message.length === 0 ? ["--message", "first commit"] : message.flatMap((part) => ["--message", part])),
  )
}

/**
 * The files Pane, standing in for the Extension that owns it.
 *
 * It has to be called `files` — `commit-flow` binds `c` and `A` into the Pane named `files`,
 * and a Pane id carries its owner's name. It also consumes `CommitFlowApi` the way §4.3's
 * conventional-commit does: `begin` composes a message elsewhere and waits for the standard
 * editor to close, so every settlement is counted and announced.
 */
const filesStandIn = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useGit } from "laziergit"

  export default defineExtension({
    name: "files",
    needs: ["commit-flow"],
    activate(ctx) {
      function FilesPane() {
        const staged = useGit((state) => state.status.staged.length)
        return <text content={"files pane " + staged} />
      }
      ctx.panes.register({ id: "files", title: "Files", component: FilesPane })

      const flow = ctx.extensions.get("commit-flow")
      let settlements = 0
      const watch = (label, opened) =>
        opened.then(() => {
          settlements += 1
          ctx.popups.notify(label + " closed #" + settlements)
        })

      ctx.commands.register({ id: "files.begin", title: "Begin a commit", keys: "b",
        run: () => watch("begin", flow.begin()) })
      ctx.commands.register({ id: "files.begin-prefilled", title: "Begin with a message", keys: "m",
        run: () => watch("prefilled", flow.begin({ message: "handed in" })) })
      ctx.commands.register({ id: "files.begin-amend", title: "Begin an amend", keys: "n",
        run: () => watch("amend", flow.begin({ amend: true })) })
    },
  })
`

/**
 * The diff Pane, standing in for the Extension that owns it.
 *
 * Registered only where a test asks for it: the default Layout tab-groups `diff` with
 * `commit-flow`, and a cell with one Pane in it cannot show the flow stranding its neighbour.
 */
const diffStandIn = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      function DiffPane() {
        return <text content="the diff pane" />
      }
      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane })
    },
  })
`

async function start(harness: Harness, options: { readonly tabbed?: boolean } = {}): Promise<void> {
  await symlink(commitFlowExtension, join(harness.bundled, "commit-flow"))
  await writeFile(join(harness.repo, "files.tsx"), filesStandIn)
  const tabbed = options.tabbed === true
  if (tabbed) await writeFile(join(harness.repo, "diff.tsx"), diffStandIn)
  // The files Pane is first, so it holds focus until `begin` moves it — and the poll is off,
  // because every refresh these tests need is one they caused.
  // A cell is an array of Pane ids, so the tab group is one cell holding both — the shape
  // `.laziergit/config.jsonc` ships, where the editor is tabbed behind the diff.
  const columns = tabbed ? `[["files"], [["diff", "commit-flow"]]]` : `[["files"], ["commit-flow"]]`
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": ${columns} }, "git": { "refreshIntervalMs": 60000 } }`,
  )
  await renderApp(harness)
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
 * Renders until the screen catches up. A keypress that starts a `git commit` returns long
 * before git does, so anything downstream of a write is waited for rather than asserted on
 * the next frame.
 */
async function waitFor(harness: Harness, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    await settle(harness)
    last = frame(harness)
    if (last.includes(expected)) return
    await act(async () => {
      await Bun.sleep(30)
    })
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} on screen. Last frame:\n${last}`)
}

/** Republishes the store now, rather than waiting out a poll interval these tests turned off. */
async function refresh(harness: Harness): Promise<void> {
  await act(async () => {
    await harness.kernel.git.refresh()
  })
  await settle(harness)
}

async function stageFile(harness: Harness, path: string): Promise<void> {
  await writeFile(join(harness.directory, path), `${path}\n`)
  await git(harness.directory, "add", "--", path)
  await refresh(harness)
}

/**
 * Focuses the files Pane.
 *
 * At startup the focused Pane is whichever registered first, which is the bundled
 * commit-flow one — and `c` and `A` are live only in the files Pane, that being the whole
 * point of a cross-pane binding.
 */
async function focusFiles(harness: Harness): Promise<void> {
  await act(async () => {
    harness.kernel.layout.focus("files")
  })
  await settle(harness)
}

const submit = (harness: Harness) => () => harness.setup.mockInput.pressKey("s", { ctrl: true })

/**
 * The idle hint, which is the honest test for "the editor is still open": a toast is drawn
 * over the bottom-right of the screen, so the editor's own footer is not always visible.
 */
const idleMarker = "from the files pane"

describe("commit-flow pane", () => {
  it("commits what was typed", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    await press(harness, () => void harness.setup.mockInput.typeText("quick fix"))

    await press(harness, submit(harness))
    await waitFor(harness, "Committed")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("quick fix\n")
  }, 30_000)

  it("keeps a message escape backed out of, and resumes it on the next commit", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    await press(harness, () => void harness.setup.mockInput.typeText("half a thought"))
    await press(harness, () => harness.setup.mockInput.pressEscape())

    // Escape is the most reflexive key in a TUI: it closes the editor and costs nothing.
    await waitFor(harness, "Draft kept")
    expect(frame(harness)).toContain("draft kept: half a thought")

    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    expect(frame(harness)).toContain("half a thought")

    // Committing consumes the draft, so the next flow starts blank rather than resurrecting it.
    await press(harness, submit(harness))
    await waitFor(harness, "Committed")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("half a thought\n")

    await stageFile(harness, "another.txt")
    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    expect(frame(harness)).not.toContain("half a thought")
  }, 30_000)

  it("hands the cell and the keyboard back when the flow closes", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness, { tabbed: true })
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    // In production the four Panes that `needs: ["diff"]` make the diff register before the
    // editor, so the diff is the cell's visible tab. This harness's graph is smaller and the
    // bundled editor registers first, so put the diff in front explicitly — the strand is only
    // visible against a diff that *was* showing.
    await act(async () => {
      harness.kernel.layout.reveal("diff")
    })
    await settle(harness)

    // The right-hand cell shows the diff Pane; opening the editor takes the cell.
    expect(frame(harness)).toContain("the diff pane")
    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    expect(frame(harness)).not.toContain("the diff pane")

    await press(harness, () => void harness.setup.mockInput.typeText("hand it back"))
    await press(harness, submit(harness))
    await waitFor(harness, "Committed")

    // Otherwise the cell stays latched to the idle summary and every later cursor move in
    // the files Pane updates a diff nobody can see.
    expect(frame(harness)).toContain("the diff pane")
    expect(frame(harness)).not.toContain(idleMarker)
    expect(harness.kernel.layout.focusedPaneId).toBe("files")
  }, 30_000)

  it("refuses an empty message and an empty index, keeping the editor open", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    await press(harness, submit(harness))
    await waitFor(harness, "Write a commit message first")
    expect(frame(harness)).not.toContain(idleMarker)

    await press(harness, () => void harness.setup.mockInput.typeText("nothing to commit"))
    await press(harness, submit(harness))
    await waitFor(harness, "Nothing staged to commit")
    // Refused, not abandoned: the message the user typed is still theirs.
    expect(frame(harness)).toContain("nothing to commit")
  }, 30_000)

  it("shows git's own words and keeps the message when the commit is rejected", async () => {
    const harness = await repository()
    await seed(harness)
    const hook = join(harness.directory, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\necho 'rejected by policy' >&2\nexit 1\n")
    await chmod(hook, 0o755)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    await press(harness, () => void harness.setup.mockInput.typeText("survives the hook"))
    await press(harness, submit(harness))

    // The hook's stderr verbatim — it is the only place the reason exists.
    await waitFor(harness, "rejected by policy")
    // And the editor is untouched, because a typed message cannot be recovered.
    expect(frame(harness)).toContain("survives the hook")
    expect(frame(harness)).not.toContain(idleMarker)

    await press(harness, () => harness.setup.mockInput.pressEscape())
    expect(frame(harness)).toContain("1 staged file")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("first commit\n")
  }, 30_000)

  it("settles begin when the flow closes, whichever way it closes", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    await press(harness, () => harness.setup.mockInput.pressEscape())
    await waitFor(harness, "begin closed #1")

    // A second `begin` displaces the first: one Pane holds one message, and the caller of
    // the displaced flow must not be left waiting on an editor that is no longer on screen.
    // Run rather than pressed, because `m` is a letter while the editor owns the keyboard.
    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    await press(harness, () => void harness.kernel.commands.execute("files.begin-prefilled"))
    await waitFor(harness, "begin closed #2")
    expect(frame(harness)).toContain("handed in")

    await press(harness, () => harness.setup.mockInput.pressEscape())
    await waitFor(harness, "prefilled closed #3")
  }, 30_000)

  it("prefills an amend with the whole message of the commit it rewrites", async () => {
    const harness = await repository()
    await seed(harness, "subject line", "body line")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    await waitFor(harness, "body line")
    const rendered = frame(harness)
    expect(rendered).toContain("amending the last commit")
    // The subject alone would have silently dropped the body of the commit being rewritten.
    expect(rendered).toContain("subject line")

    // Amending needs no staged files, which is the one case the empty-index guard allows.
    await press(harness, submit(harness))
    await waitFor(harness, "Amended")
    expect(await git(harness.directory, "log", "--format=%s")).toBe("subject line\n")
  }, 30_000)

  it("appends to a prefilled message instead of prepending, so amend can reword", async () => {
    const harness = await repository()
    await seed(harness, "reword me")
    await start(harness)

    // The textarea parks a prefilled caret at offset 0, so without the Pane moving it to the
    // end this types " now" onto the FRONT — " nowreword me". Amend-to-reword lives or dies here.
    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    await waitFor(harness, "reword me")
    await press(harness, () => void harness.setup.mockInput.typeText(" now"))

    await press(harness, submit(harness))
    await waitFor(harness, "Amended")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("reword me now\n")
  }, 30_000)

  it("offers the actions the working tree supports, and hides the rest", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await writeFile(join(harness.directory, "loose.txt"), "loose\n")
    await refresh(harness)

    await press(harness, () => void harness.kernel.commands.execute("commit-flow.menu"))
    const menu = frame(harness)
    expect(menu).toContain("Stage all and commit")
    expect(menu).toContain("Amend the last commit")
    // Nothing is staged, so the two entries that would commit an empty index are not offered.
    expect(menu).not.toContain("Commit with signoff")

    await press(harness, () => harness.setup.mockInput.pressKey("a"))
    await waitFor(harness, "1 staged file")
    expect(frame(harness)).not.toContain(idleMarker)
  }, 30_000)
})
