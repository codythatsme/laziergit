import { expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The same directory `main.tsx` hands the kernel as the bundled scope. */
const bundledExtensionDirectory = resolve(import.meta.dir, "..", "..", "..", "..", "extensions")

/**
 * Stands in for the four list Panes: the only way into the `diff` Extension is `show`, so
 * something has to call it from its own `activate` scope the way `files` and `commits` do.
 * Its Commands are global, which keeps the Layout a single Pane — and therefore keeps the
 * diff Pane focused, so `v` and `x` reach it without a focus dance.
 */
const driverSource = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "driver",
    needs: ["diff"],
    activate(ctx) {
      const diff = ctx.extensions.get("diff")

      ctx.commands.register({
        id: "driver.working-file",
        title: "Diff a working-tree file",
        run: () => diff.show({ kind: "workingTree", ref: null, path: "tracked.txt" }),
      })
      ctx.commands.register({
        id: "driver.clean-file",
        title: "Diff an unchanged working-tree file",
        run: () => diff.show({ kind: "workingTree", ref: null, path: "seed.txt" }),
      })
      ctx.commands.register({
        id: "driver.working-tree",
        title: "Diff the whole working tree",
        run: () => diff.show({ kind: "workingTree", ref: null, path: null }),
      })
      ctx.commands.register({
        id: "driver.staged-file",
        title: "Diff a staged file",
        run: () => diff.show({ kind: "staged", ref: null, path: "tracked.txt" }),
      })
      ctx.commands.register({
        id: "driver.head-commit",
        title: "Diff the HEAD commit",
        run: () => {
          const head = ctx.git.state.head
          if (head.kind === "unborn") return
          diff.show({ kind: "commit", ref: head.oid, path: null })
        },
      })
      ctx.commands.register({
        id: "driver.head-commit-file",
        title: "Diff one path in the HEAD commit",
        run: () => {
          const head = ctx.git.state.head
          if (head.kind === "unborn") return
          diff.show({ kind: "commit", ref: head.oid, path: "tracked.txt" })
        },
      })
      ctx.commands.register({
        id: "driver.missing-commit",
        title: "Diff a commit that is not there",
        run: () => diff.show({ kind: "commit", ref: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", path: null }),
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
      ctx.commands.register({
        id: "driver.untracked",
        title: "Diff an untracked file",
        run: () => diff.show({ kind: "workingTree", ref: null, path: "untracked.txt" }),
      })
      ctx.commands.register({
        id: "driver.glob-file",
        title: "Diff a file whose name reads as a glob",
        run: () => diff.show({ kind: "workingTree", ref: null, path: "glob[1].txt" }),
      })
    },
  })
`

/**
 * Two Panes to tab the diff Pane behind, so `show` has somewhere to reveal it from. They
 * report their own focus, which is what separates `reveal` from `focus`.
 */
const tabsSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, type PaneProps } from "laziergit"

  const line = (name: string) => ({ focused }: PaneProps) =>
    <text content={name + " " + (focused ? "focused" : "blurred")} />

  export default defineExtension({
    name: "tabs",
    activate(ctx) {
      ctx.panes.register({ id: "tabs", title: "List", component: line("list") })
      const front = ctx.panes.register({ id: "tabs.front", title: "Front", component: line("front") })

      // The cell shows whichever tab came forward last, and the bundled diff Pane registers
      // first, so this is how the test gets the diff Pane stranded in the first place.
      ctx.commands.register({ id: "tabs.show-front", title: "Show the front tab", run: () => front.reveal() })
    },
  })
`

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
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr}`)
  return stdout
}

/**
 * The diff Pane alone, plus the driver, over a repository with one commit and one tracked
 * file. The `.gitignore` covers the harness's own scaffolding — Extension directories, the
 * config files, the published schema — which would otherwise show up in a whole-working-tree
 * diff as untracked noise this test never asked about.
 */
async function createDiffHarness(options: { readonly height?: number } = {}): Promise<Harness> {
  const harness = await createHarness({ git: true, height: options.height })
  await symlink(join(bundledExtensionDirectory, "diff"), join(harness.bundled, "diff"))
  await writeFile(join(harness.repo, "driver.ts"), driverSource)
  await writeFile(harness.configFiles.repo, `{ "layout": { "columns": [["diff"]] } }`)
  await writeFile(join(harness.directory, ".gitignore"), "global/\nrepo/\nbundled/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "seed.txt"), "seed\n")
  await writeFile(join(harness.directory, "tracked.txt"), "one\ntwo\nthree\n")
  // A file whose name is also a pathspec pattern, and the file that pattern would catch.
  await writeFile(join(harness.directory, "glob[1].txt"), "bracket\n")
  await writeFile(join(harness.directory, "glob1.txt"), "decoy\n")
  await git(harness, "add", ".gitignore", "seed.txt", "tracked.txt", "glob1.txt", ":(literal)glob[1].txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")
  return harness
}

/**
 * Renders until the screen catches up, and hands back the frame that matched — so every
 * other assertion in a test reads the *same* frame rather than racing the next one. Each
 * fetch here is a real `git` process behind a `useEffect`, so the frame that proves it
 * landed is several ticks after the Command that asked for it.
 */
async function waitForFrame(harness: Harness, expected: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    await settle(harness)
    last = frame(harness)
    if (last.includes(expected)) return last
    await act(async () => {
      await Bun.sleep(20)
    })
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} on screen. Last frame:\n${last}`)
}

/** A key press, plus enough real time for the terminal parser to finish disambiguating it. */
async function press(harness: Harness, key: string): Promise<void> {
  await act(async () => {
    harness.setup.mockInput.pressKey(key)
    await Bun.sleep(60)
  })
  await settle(harness)
}

/** Fires a Command the way a keypress would — not awaited, so nothing nests inside `act`. */
async function run(harness: Harness, command: string): Promise<void> {
  await act(async () => {
    void harness.kernel.commands.execute(command)
    await Bun.sleep(20)
  })
  await settle(harness)
}

it("says nothing is selected until something calls show", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)

  expect(frame(harness)).toContain("nothing selected")
}, 20_000)

it("shows a working-tree file's changes under a header naming it", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

  await run(harness, "driver.working-file")

  const screen = await waitForFrame(harness, "+ TWO")
  expect(screen).toContain("working tree tracked.txt [unified]")
  expect(screen).toContain("- two")
}, 20_000)

it("distinguishes a file with no changes from having nothing selected", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)

  await run(harness, "driver.clean-file")

  const screen = await waitForFrame(harness, "no changes")
  expect(screen).toContain("working tree seed.txt")
}, 20_000)

it("diffs the index and the working tree as two different targets", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nTWO\nthree\n")
  await git(harness, "add", "tracked.txt")

  // Staged: the change is there. Unstaged: it is not — the same path, opposite answers.
  await run(harness, "driver.staged-file")
  expect(await waitForFrame(harness, "+ TWO")).toContain("staged tracked.txt")

  await run(harness, "driver.working-file")
  expect(await waitForFrame(harness, "no changes")).toContain("working tree tracked.txt")
}, 20_000)

it("shows a commit by ref, narrowed to the path the target names", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  const head = (await git(harness, "rev-parse", "HEAD")).trim()

  await run(harness, "driver.head-commit-file")

  const screen = await waitForFrame(harness, "+ three")
  expect(screen).toContain(`commit ${head.slice(0, 8)}`)
  // `--format=` is what keeps the commit's own subject off the top: `<diff>` wants a bare
  // patch, and the header above it already says which commit this is.
  expect(screen).not.toContain("first commit")
  // And the pathspec really narrowed it — the other two files of the same commit are gone.
  expect(screen).not.toContain("seed")
}, 20_000)

it("diffs the whole working tree when the target names no path", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "seed.txt"), "seed changed\n")

  await run(harness, "driver.working-tree")

  expect(await waitForFrame(harness, "+ seed changed")).toContain("working tree [unified]")
}, 20_000)

it("shows a stash entry's patch", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nstashed\nthree\n")
  await git(harness, "stash", "push", "--quiet", "--message", "wip")

  await run(harness, "driver.stash")

  // `stash show` counts as read-only only as the exact pair, which is why the argv puts
  // `show` immediately after `stash`; got that wrong and this would refresh in a loop.
  expect(await waitForFrame(harness, "+ stashed")).toContain("stash@{0}")
}, 20_000)

it("re-fetches when the repository changes under a target that stayed put", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

  await run(harness, "driver.working-file")
  await waitForFrame(harness, "+ TWO")

  // Staged from the diff Pane's own menu: `x` opens it, `s` stages. The target does not
  // move, but its diff is now empty — which is the whole point of re-fetching on
  // `git.refreshed` rather than only on a change of target.
  await press(harness, "x")
  expect(frame(harness)).toContain("Stage this file")
  await press(harness, "s")

  await waitForFrame(harness, "no changes")
  expect((await git(harness, "diff", "--cached", "--name-only")).trim()).toBe("tracked.txt")
}, 20_000)

it("toggles between unified and split without touching config", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

  await run(harness, "driver.working-file")
  await waitForFrame(harness, "+ TWO")

  await press(harness, "v")
  expect(frame(harness)).toContain("[split]")

  await press(harness, "v")
  expect(frame(harness)).toContain("[unified]")
}, 20_000)

it("honours the configured view and context", async () => {
  const harness = await createDiffHarness()
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": [["diff"]] }, "extensions": { "diff": { "view": "split", "context": 0 } } }`,
  )
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

  await run(harness, "driver.working-file")

  const screen = await waitForFrame(harness, "TWO")
  expect(screen).toContain("[split]")
  // With zero context the hunk is the changed line and nothing else, so the untouched
  // neighbours `-U3` would have carried along are absent.
  expect(screen).not.toContain("three")
}, 20_000)

it("puts git's own words on screen when the ref does not exist", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)

  await run(harness, "driver.missing-commit")

  // git's own sentence, verbatim, and not a message of ours that loses the reason.
  const screen = await waitForFrame(harness, "bad object")
  expect(screen).not.toContain("loading")
}, 20_000)

it("offers staging only for the side of the index the target is on", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

  await run(harness, "driver.working-file")
  await waitForFrame(harness, "+ TWO")
  await press(harness, "x")
  const workingTreeMenu = frame(harness)
  expect(workingTreeMenu).toContain("Stage this file")
  expect(workingTreeMenu).not.toContain("Unstage this file")
  await press(harness, "escape")

  await git(harness, "add", "tracked.txt")
  await run(harness, "driver.staged-file")
  await waitForFrame(harness, "staged tracked.txt")
  await press(harness, "x")
  const stagedMenu = frame(harness)
  expect(stagedMenu).toContain("Unstage this file")
  expect(stagedMenu).not.toContain("Stage this file")
  await press(harness, "u")

  await waitForFrame(harness, "no changes")
  expect((await git(harness, "diff", "--cached", "--name-only")).trim()).toBe("")
}, 20_000)

it("renders a merge commit, which git shows nothing for unless told which parent to use", async () => {
  const harness = await createDiffHarness()
  await git(harness, "checkout", "--quiet", "-b", "side")
  await writeFile(join(harness.directory, "tracked.txt"), "one\nmerged\nthree\n")
  await git(harness, "commit", "--quiet", "--all", "--message", "side")
  await git(harness, "checkout", "--quiet", "main")
  await git(harness, "merge", "--quiet", "--no-ff", "--no-edit", "side")
  await renderApp(harness)

  await run(harness, "driver.head-commit")

  // `git show <merge>` prints nothing at all: without `--first-parent` the tip of `main` in
  // most repositories renders as a commit that changed no files.
  const screen = await waitForFrame(harness, "+ merged")
  expect(screen).toContain("- two")
  expect(screen).not.toContain("no changes")
}, 20_000)

it("shows an untracked file's contents rather than an empty diff", async () => {
  const harness = await createDiffHarness()
  await writeFile(join(harness.directory, "untracked.txt"), "brand\nnew\n")
  await renderApp(harness)

  await run(harness, "driver.untracked")

  // `git diff -- <path>` says nothing about a path git does not track, so the whole file as
  // an addition is the only honest answer — and the caller is a files Pane row that has just
  // told the user there is something here.
  const screen = await waitForFrame(harness, "+ brand")
  expect(screen).toContain("+ new")
  expect(screen).not.toContain("no changes")
}, 20_000)

it("treats a path that reads as a glob as a path", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "glob[1].txt"), "bracket changed\n")
  await writeFile(join(harness.directory, "glob1.txt"), "decoy changed\n")

  await run(harness, "driver.glob-file")

  // Unwrapped, `glob[1].txt` is a pattern that also matches `glob1.txt`, so the Pane would
  // show a file the user never selected next to the one they did.
  const screen = await waitForFrame(harness, "+ bracket changed")
  expect(screen).not.toContain("decoy")
}, 20_000)

it("narrows a stash to one file, which git stash show cannot be asked to do", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nstashed\nthree\n")
  await writeFile(join(harness.directory, "seed.txt"), "seed stashed\n")
  await git(harness, "stash", "push", "--quiet", "--message", "wip")

  await run(harness, "driver.stash-file")

  // `git stash show <ref> -- <path>` exits with "Too many revisions specified". The diff
  // against the entry's first parent is the same patch and does take a pathspec.
  const screen = await waitForFrame(harness, "+ stashed")
  expect(screen).toContain("stash@{0} tracked.txt")
  expect(screen).not.toContain("seed stashed")
  expect(screen).not.toContain("Too many revisions")
}, 20_000)

it("renders every file a commit touched, not only the first", async () => {
  const harness = await createDiffHarness()
  await writeFile(join(harness.directory, "alpha.txt"), "alpha\n")
  await writeFile(join(harness.directory, "beta.txt"), "beta\n")
  await git(harness, "add", "alpha.txt", "beta.txt")
  await git(harness, "commit", "--quiet", "--message", "two files")
  await renderApp(harness)

  await run(harness, "driver.head-commit")

  // OpenTUI's `<diff>` renders `patches[0]` and nothing else, so the second file is on
  // screen only because the Pane splits the patch and renders one `<diff>` per file.
  const screen = await waitForFrame(harness, "+ beta")
  expect(screen).toContain("+ alpha")
  // ...and each is named, because the header above can only name the target, which is a
  // whole commit.
  expect(screen).toContain("alpha.txt")
  expect(screen).toContain("beta.txt")
}, 20_000)

it("scrolls a patch taller than the pane instead of overflowing it", async () => {
  const harness = await createDiffHarness({ height: 16 })
  await renderApp(harness)
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`)
  await writeFile(join(harness.directory, "tracked.txt"), `${lines.join("\n")}\n`)

  await run(harness, "driver.working-file")

  // The trailing space matters: without it "line 1" also matches "line 10".
  await waitForFrame(harness, "+ line 1 ")
  expect(frame(harness)).not.toContain("+ line 60")

  await press(harness, "G")
  const end = frame(harness)
  expect(end).toContain("+ line 60")
  // The Pane's own header survived: a box sized by its content overflows the Pane and
  // paints across whatever is above it.
  expect(end).toContain("working tree tracked.txt")

  await press(harness, "g")
  expect(frame(harness)).toContain("+ line 1 ")
}, 20_000)

it("reveals itself when a list points it at something while it is tabbed away", async () => {
  const harness = await createDiffHarness()
  await writeFile(join(harness.repo, "tabs.tsx"), tabsSource)
  await writeFile(harness.configFiles.repo, `{ "layout": { "columns": [["tabs"], [["tabs.front", "diff"]]] } }`)
  await renderApp(harness)
  await writeFile(join(harness.directory, "tracked.txt"), "one\nTWO\nthree\n")

  // Strand the diff Pane behind the front tab, with the keyboard still on the list.
  await run(harness, "tabs.show-front")
  expect(frame(harness)).toContain("front blurred")
  expect(frame(harness)).toContain("list focused")
  expect(frame(harness)).not.toContain("nothing selected")

  await run(harness, "driver.working-file")

  // `reveal`, not `focus`: the diff comes to the front of its tab group, and the keyboard
  // stays where the user left it — `show` runs on every cursor move of the Pane they are
  // driving.
  const screen = await waitForFrame(harness, "+ TWO")
  expect(screen).not.toContain("front blurred")
  expect(screen).toContain("list focused")
}, 20_000)

it("hides the file actions entirely for a commit, which has no file to stage", async () => {
  const harness = await createDiffHarness()
  await renderApp(harness)

  await run(harness, "driver.head-commit")
  await waitForFrame(harness, "commit ")
  await press(harness, "x")

  const menu = frame(harness)
  expect(menu).toContain("Toggle unified/split")
  expect(menu).toContain("Refresh")
  expect(menu).not.toContain("Stage this file")
  expect(menu).not.toContain("Unstage this file")
}, 20_000)
