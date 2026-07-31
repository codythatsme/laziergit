import { describe, expect, it } from "bun:test"
import { chmod, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, symlinked into the harness's bundled scope the way `main.tsx` loads it. */
const commitFlowExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commit-flow")

/**
 * The harness directory is the repository, the Extension home, and where the kernel writes
 * `config.schema.json` — so everything it generates is ignored, `.gitignore` included, or the
 * staged summary under test would be reporting the scaffolding.
 */
const ignored = ".gitignore\nbundled/\nglobal/\nrepo/\n*.json\n*.jsonc\n"

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
  // A broken fixture is not a test result, so it fails here rather than as a puzzling frame.
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
  return stdout
}

/**
 * A repository the Extension can commit into. These commits are made by the git service,
 * which inherits the process environment, so the identity and hook settings the other fixtures
 * pass as env vars have to be written into the repository itself.
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
 * The files Pane, standing in for the Extension that owns it. It has to be called `files` —
 * `commit-flow` binds `c` and `A` into the Pane of that name. It also consumes `CommitFlowApi`,
 * so every settlement is counted and announced.
 */
const filesStandIn = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, isStaged, useGit } from "laziergit"

  export default defineExtension({
    name: "files",
    needs: ["commit-flow"],
    activate(ctx) {
      function FilesPane() {
        const staged = useGit((state) => state.status.files.filter(isStaged).length)
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
      ctx.commands.register({ id: "files.begin-reword", title: "Begin a message-only amend", keys: "r",
        run: () => watch("reword", flow.begin({ message: "belongs to its commit", amend: true, messageOnly: true })) })
    },
  })
`

/**
 * The diff Pane, standing in for the Extension that owns it. Registered only where a test asks
 * for it: a cell with one Pane in it cannot show the flow stranding its neighbour.
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
  // The files Pane is first, so it holds focus until `begin` moves it, and the poll is off. A
  // cell is an array of Pane ids, so the tab group is one cell holding both.
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
 * Focuses the files Pane. At startup the focused Pane is whichever registered first, and `c`
 * and `A` are live only in the files Pane.
 */
async function focusFiles(harness: Harness): Promise<void> {
  await act(async () => {
    harness.kernel.layout.focus("files")
  })
  await settle(harness)
}

const submit = (harness: Harness) => () => harness.setup.mockInput.pressKey("s", { ctrl: true })

/** The popup's first field, which disappears only when the commit flow closes. */
const popupMarker = "Commit summary"

describe("commit-flow popup", () => {
  it("commits what was typed", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    await press(harness, () => void harness.setup.mockInput.typeText("quick fix"))

    // Like lazygit, Enter accepts the one-line summary; Ctrl+S works from either field.
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitFor(harness, "Committed")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("quick fix\n")
  }, 30_000)

  it("commits a summary and description separated by git's conventional blank line", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    await press(harness, () => void harness.setup.mockInput.typeText("explain the change"))
    await press(harness, () => harness.setup.mockInput.pressTab())
    await press(harness, () => void harness.setup.mockInput.typeText("The context matters."))
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await press(harness, () => void harness.setup.mockInput.typeText("Keep both body lines."))
    await press(harness, submit(harness))
    await waitFor(harness, "Committed")

    expect((await git(harness.directory, "log", "-1", "--format=%B")).trimEnd()).toBe(
      "explain the change\n\nThe context matters.\nKeep both body lines.",
    )
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

  it("does not keep a draft escape backed out of a message-only flow", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("r"))
    await waitFor(harness, "belongs to its commit")
    await press(harness, () => void harness.setup.mockInput.typeText(" edited"))
    await press(harness, () => harness.setup.mockInput.pressEscape())
    await waitFor(harness, "reword closed #1")

    // The edited text is another commit's message; resuming it on the next plain commit
    // would write it onto unrelated work.
    expect(frame(harness)).not.toContain("draft kept")
    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    expect(frame(harness)).not.toContain("belongs to its commit")
  }, 30_000)

  it("leaves the diff visible behind the popup and keeps the files pane focused", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness, { tabbed: true })
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    // In production the four Panes with `needs: ["diff"]` make the diff register first, so it
    // is the cell's visible tab. This harness's graph is smaller, so put it in front
    // explicitly — the strand is only visible against a diff that was showing.
    await act(async () => {
      harness.kernel.layout.reveal("diff")
    })
    await settle(harness)

    // The right-hand cell stays on the diff while the modal takes only keyboard focus.
    expect(frame(harness)).toContain("the diff pane")
    await press(harness, () => harness.setup.mockInput.pressKey("c"))
    expect(frame(harness)).toContain("the diff pane")
    expect(frame(harness)).toContain(popupMarker)

    await press(harness, () => void harness.setup.mockInput.typeText("hand it back"))
    await press(harness, submit(harness))
    await waitFor(harness, "Committed")

    expect(frame(harness)).toContain("the diff pane")
    expect(frame(harness)).not.toContain(popupMarker)
    expect(harness.kernel.layout.focusedPaneId).toBe("files")
  }, 30_000)

  it("refuses an empty message and an empty index, keeping the editor open", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    await press(harness, submit(harness))
    await waitFor(harness, "Write a commit message first")
    expect(frame(harness)).toContain(popupMarker)

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
    expect(frame(harness)).toContain(popupMarker)

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

    // A second `begin` displaces the first, and the displaced caller must not be left waiting
    // on an editor that is no longer on screen. Run rather than pressed, because `m` is a
    // letter while the editor owns the keyboard.
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
    expect(rendered).toContain("Amend the last commit")
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
    // end this types " now" onto the front: " nowreword me".
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
    expect(frame(harness)).toContain(popupMarker)
  }, 30_000)
})
