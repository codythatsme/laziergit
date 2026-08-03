import { describe, expect, it } from "bun:test"
import { chmod, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import commitFlowDefinition from "../../../../extensions/commit-flow"
import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  pressEscape,
  refreshGit,
  renderApp,
  settle,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, symlinked into the harness's bundled scope the way `main.tsx` loads it. */
const commitFlowExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commit-flow")
const diffExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "diff")
const filesExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "files")

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
 * for it.
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
  // The files Pane is first, so its contextual commit keys are live, and the poll is off.
  const columns = tabbed ? `[["files"], ["diff"]]` : `[["files"]]`
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": ${columns} }, "git": { "refreshIntervalMs": 60000 } }`,
  )
  await renderApp(harness)
}

/** Starts the exact shipped Files → Diff → Commit Flow graph instead of the focused stand-ins. */
async function startShippedFiles(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(commitFlowExtension, join(harness.bundled, "commit-flow")),
    symlink(diffExtension, join(harness.bundled, "diff")),
    symlink(filesExtension, join(harness.bundled, "files")),
  ])
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": [["files"], ["diff"]] }, "git": { "refreshIntervalMs": 60000 } }`,
  )
  await renderApp(harness)
}

async function stageFile(harness: Harness, path: string): Promise<void> {
  await writeFile(join(harness.directory, path), `${path}\n`)
  await git(harness.directory, "add", "--", path)
  await refreshGit(harness)
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
  it("still opens an editor when a hot-reloaded extension is running against the previous core", async () => {
    let runCommit: (() => void | Promise<void>) | undefined
    let prompted = false

    await commitFlowDefinition.spec.activate({
      git: {
        state: {
          head: { kind: "onBranch", branch: "main", upstream: null },
          status: { files: [] },
        },
      },
      commands: {
        register: (spec: { readonly id: string; readonly run: () => void | Promise<void> }) => {
          if (spec.id === "commit-flow.commit") runCommit = spec.run
          return { dispose: () => undefined, refresh: () => undefined }
        },
      },
      panes: {
        register: () => ({ dispose: () => undefined, focus: () => undefined, reveal: () => undefined }),
      },
      popups: {
        // `compose` did not exist before this feature. This is the live context retained by a
        // process whose bundled Extension hot-reloaded while core itself stayed in memory.
        prompt: async () => {
          prompted = true
          return undefined
        },
        notify: () => undefined,
      },
      onDispose: () => undefined,
    } as never)

    expect(runCommit).toBeDefined()
    await runCommit?.()

    expect(prompted).toBe(true)
  })

  it("does not add a Commit tab beside the diff", async () => {
    const harness = await repository()
    await seed(harness)
    await startShippedFiles(harness)

    expect(harness.kernel.layout.liveTabs()).toEqual(["files", "diff"])
  })

  it("opens from the shipped Files pane when c is pressed", async () => {
    const harness = await repository()
    await seed(harness)
    await writeFile(join(harness.directory, "tracked.txt"), "changed\n")
    await startShippedFiles(harness)
    await focusFiles(harness)
    // The shipped diff Pane fetches for the selected file on its own; the test must not end
    // while that fetch is still due to land, so it settles before the popup opens over it.
    await waitForFrame(harness, (screen) => screen.includes("tracked.txt") && !screen.includes("loading"))

    await press(harness, "c")

    await waitForFrame(harness, popupMarker)
  }, 30_000)

  it("commits what was typed", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, "c")
    await press(harness, () => void harness.setup.mockInput.typeText("quick fix"))

    // Like lazygit, Enter accepts the one-line summary; Ctrl+S works from either field.
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "Committed")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("quick fix\n")
  }, 30_000)

  it("commits a summary and description separated by git's conventional blank line", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, "c")
    await press(harness, () => void harness.setup.mockInput.typeText("explain the change"))
    await press(harness, () => harness.setup.mockInput.pressTab())
    await press(harness, () => void harness.setup.mockInput.typeText("The context matters."))
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await press(harness, () => void harness.setup.mockInput.typeText("Keep both body lines."))
    await press(harness, submit(harness))
    await waitForFrame(harness, "Committed")

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

    await press(harness, "c")
    await press(harness, () => void harness.setup.mockInput.typeText("half a thought"))
    await pressEscape(harness)

    // Escape is the most reflexive key in a TUI: it closes the editor and costs nothing.
    await waitForFrame(harness, "Draft kept")

    await press(harness, "c")
    expect(frame(harness)).toContain("half a thought")

    // Committing consumes the draft, so the next flow starts blank rather than resurrecting it.
    await press(harness, submit(harness))
    await waitForFrame(harness, "Committed")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("half a thought\n")

    await stageFile(harness, "another.txt")
    await press(harness, "c")
    expect(frame(harness)).not.toContain("half a thought")
  }, 30_000)

  it("publishes and directly runs the discard-draft Command when a draft is kept", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, "c")
    await press(harness, () => void harness.setup.mockInput.typeText("throw this away"))
    await pressEscape(harness)
    await waitForFrame(harness, "Draft kept")

    expect(harness.kernel.commands.getSnapshot().map((command) => command.id)).toContain("commit-flow.discard-draft")

    await act(async () => {
      await harness.kernel.commands.execute("commit-flow.discard-draft")
    })
    await waitForFrame(harness, "Draft discarded")
    expect(harness.kernel.commands.getSnapshot().map((command) => command.id)).not.toContain(
      "commit-flow.discard-draft",
    )
  }, 30_000)

  it("does not keep a draft escape backed out of a message-only flow", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await stageFile(harness, "feature.txt")
    await focusFiles(harness)

    await press(harness, "r")
    await waitForFrame(harness, "belongs to its commit")
    await press(harness, () => void harness.setup.mockInput.typeText(" edited"))
    await pressEscape(harness)
    await waitForFrame(harness, "reword closed #1")

    // The edited text is another commit's message; resuming it on the next plain commit
    // would write it onto unrelated work.
    expect(frame(harness)).not.toContain("draft kept")
    await press(harness, "c")
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
    await press(harness, "c")
    expect(frame(harness)).toContain("the diff pane")
    expect(frame(harness)).toContain(popupMarker)

    await press(harness, () => void harness.setup.mockInput.typeText("hand it back"))
    await press(harness, submit(harness))
    await waitForFrame(harness, "Committed")

    expect(frame(harness)).toContain("the diff pane")
    expect(frame(harness)).not.toContain(popupMarker)
    expect(harness.kernel.layout.focusedPaneId).toBe("files")
  }, 30_000)

  it("refuses an empty message and an empty index, keeping the editor open", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    await press(harness, "b")
    await press(harness, submit(harness))
    await waitForFrame(harness, "Write a commit message first")
    expect(frame(harness)).toContain(popupMarker)

    await press(harness, () => void harness.setup.mockInput.typeText("nothing to commit"))
    await press(harness, submit(harness))
    await waitForFrame(harness, "Nothing staged to commit")
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

    await press(harness, "c")
    await press(harness, () => void harness.setup.mockInput.typeText("survives the hook"))
    await press(harness, submit(harness))

    // The hook's stderr verbatim — it is the only place the reason exists.
    await waitForFrame(harness, "rejected by policy")
    // And the editor is untouched, because a typed message cannot be recovered.
    expect(frame(harness)).toContain("survives the hook")
    expect(frame(harness)).toContain(popupMarker)

    await pressEscape(harness)
    expect(await git(harness.directory, "diff", "--cached", "--name-only")).toBe("feature.txt\n")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("first commit\n")
  }, 30_000)

  it("settles begin when the flow closes, whichever way it closes", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    await press(harness, "b")
    await pressEscape(harness)
    await waitForFrame(harness, "begin closed #1")

    // A second `begin` displaces the first, and the displaced caller must not be left waiting
    // on an editor that is no longer on screen. Run rather than pressed, because `m` is a
    // letter while the editor owns the keyboard.
    await press(harness, "b")
    await press(harness, () => void harness.kernel.commands.execute("files.begin-prefilled"))
    await waitForFrame(harness, "begin closed #2")
    expect(frame(harness)).toContain("handed in")

    await pressEscape(harness)
    await waitForFrame(harness, "prefilled closed #3")
  }, 30_000)

  it("prefills an amend with the whole message of the commit it rewrites", async () => {
    const harness = await repository()
    await seed(harness, "subject line", "body line")
    await start(harness)

    await press(harness, "n")
    await waitForFrame(harness, "body line")
    const rendered = frame(harness)
    expect(rendered).toContain("Amend the last commit")
    // The subject alone would have silently dropped the body of the commit being rewritten.
    expect(rendered).toContain("subject line")

    // Amending needs no staged files, which is the one case the empty-index guard allows.
    await press(harness, submit(harness))
    await waitForFrame(harness, "Amended")
    expect(await git(harness.directory, "log", "--format=%s")).toBe("subject line\n")
  }, 30_000)

  it("appends to a prefilled message instead of prepending, so amend can reword", async () => {
    const harness = await repository()
    await seed(harness, "reword me")
    await start(harness)

    // The textarea parks a prefilled caret at offset 0, so without the Pane moving it to the
    // end this types " now" onto the front: " nowreword me".
    await press(harness, "n")
    await waitForFrame(harness, "reword me")
    await press(harness, () => void harness.setup.mockInput.typeText(" now"))

    await press(harness, submit(harness))
    await waitForFrame(harness, "Amended")
    expect(await git(harness.directory, "log", "-1", "--format=%s")).toBe("reword me now\n")
  }, 30_000)

  it("publishes the actions the working tree supports, and hides the rest", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)
    await writeFile(join(harness.directory, "loose.txt"), "loose\n")
    await refreshGit(harness)

    const commands = harness.kernel.commands.getSnapshot().map((command) => command.id)
    expect(commands).toContain("commit-flow.stage-all")
    expect(commands).toContain("commit-flow.amend-here")
    // Nothing is staged, so the two Commands that would commit an empty index are unavailable.
    expect(commands).not.toContain("commit-flow.commit-staged")
    expect(commands).not.toContain("commit-flow.signoff")
    expect(commands).not.toContain("commit-flow.menu")

    await act(async () => {
      void harness.kernel.commands.execute("commit-flow.stage-all")
    })
    await waitForFrame(harness, popupMarker)
    expect(await git(harness.directory, "diff", "--cached", "--name-only")).toBe("loose.txt\n")
  }, 30_000)
})
