import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, symlinked into the harness's bundled scope (see bundled.test.tsx). */
const statusExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "status")

/**
 * The harness directory is the repository, the Extension home, and where the kernel writes
 * `config.schema.json` — so everything it generates is ignored, `.gitignore` included, or the
 * very working-tree counts under test would be reporting the scaffolding.
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

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A harness whose directory is a repository with nothing committed yet. */
async function repository(): Promise<Harness> {
  const harness = await createHarness({ git: true })
  await writeFile(join(harness.directory, ".gitignore"), ignored)
  return harness
}

/** The common starting point: one commit on `main`. */
async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, "tracked.txt"), "one\n")
  // `.gitignore` is deliberately not committed: it ignores itself, which is what keeps the
  // harness's own scaffolding out of the working-tree counts without adding a file to them.
  await git(harness.directory, "add", "tracked.txt")
  await git(harness.directory, "commit", "--quiet", "--message", "first commit")
}

/** A bare repository standing in for a remote, wired up as `origin` with `main` pushed. */
async function addOrigin(harness: Harness): Promise<void> {
  const remote = await mkdtemp(join(tmpdir(), "laziergit-status-remote-"))
  temporaryDirectories.push(remote)
  await git(remote, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet")
  await git(harness.directory, "remote", "add", "origin", remote)
  await git(harness.directory, "push", "--quiet", "--set-upstream", "origin", "main")
}

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

/**
 * Puts a recording stand-in for the platform's URL opener at the front of `PATH`.
 *
 * `ctx.open` spawns `open` / `xdg-open` with the URL in argv, so this is the only place a
 * test can read the URL the Extension actually derived — and without it, asserting on the
 * derived URL would mean launching a real browser.
 */
async function captureOpen(): Promise<() => Promise<readonly string[]>> {
  const bin = await mkdtemp(join(tmpdir(), "laziergit-status-bin-"))
  temporaryDirectories.push(bin)
  const log = join(bin, "opened.txt")
  for (const name of ["open", "xdg-open"]) {
    const script = join(bin, name)
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`)
    await chmod(script, 0o755)
  }
  process.env.PATH = `${bin}:${originalPath ?? ""}`

  return async () => {
    // The spawn outlives the key press that started it, so this waits for the child rather
    // than assuming one render tick was enough.
    for (let attempt = 0; attempt < 100; attempt++) {
      const recorded = await readFile(log, "utf8").catch(() => "")
      if (recorded !== "") return recorded.split("\n").filter((line) => line !== "")
      await Bun.sleep(20)
    }
    return []
  }
}

/** A second Pane, so focus has somewhere to be that is not the status Pane. */
const otherPane = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "other",
    activate(ctx) {
      ctx.panes.register({ id: "other", title: "Other", component: () => <text content="other pane" /> })
    },
  })
`

interface StartOptions {
  /** Layout config; defaults to the status Pane alone. */
  readonly layout?: string
  /** Write the `other` Extension into the repo scope too. */
  readonly withOtherPane?: boolean
}

async function start(harness: Harness, options: StartOptions = {}): Promise<void> {
  await symlink(statusExtension, join(harness.bundled, "status"))
  await writeFile(
    harness.configFiles.repo,
    `{ "layout": { "columns": ${options.layout ?? `[["status"]]`} }, "git": { "refreshIntervalMs": 60000 } }`,
  )
  if (options.withOtherPane === true) await writeFile(join(harness.repo, "other.tsx"), otherPane)
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

describe("status pane", () => {
  it("names the unborn branch and says there is nothing committed yet", async () => {
    const harness = await repository()
    await start(harness)

    // The unborn variant carries a branch but no oid, so the divergence slot explains the
    // absence rather than inventing a comparison.
    expect(frame(harness)).toContain("main no commits yet")
    expect(frame(harness)).toContain("clean")
  })

  it("says so outside a repository instead of rendering an empty box", async () => {
    const harness = await createHarness()
    await start(harness)

    expect(frame(harness)).toContain("no repository")
    // Nothing to describe, so the shared status line gets no segment at all.
    expect(frame(harness)).not.toContain("*")
  })

  it("shows the repository name, the branch, and a clean tree with no upstream", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    const rendered = frame(harness)
    expect(rendered).toContain("main no upstream")
    expect(rendered).toContain("clean")
    // The directory the repository lives in, so a second laziergit is identifiable at a glance.
    expect(rendered).toContain(
      harness.directory
        .split("/")
        .filter((part) => part !== "")
        .at(-1) ?? "",
    )
  })

  it("counts staged, unstaged, untracked and stashed work", async () => {
    const harness = await repository()
    await seed(harness)

    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await git(harness.directory, "stash", "push", "--quiet", "--message", "wip")
    await writeFile(join(harness.directory, "tracked.txt"), "three\n")
    await writeFile(join(harness.directory, "staged.txt"), "staged\n")
    await git(harness.directory, "add", "staged.txt")
    await writeFile(join(harness.directory, "loose.txt"), "loose\n")

    await start(harness)

    expect(frame(harness)).toContain("+1 ~1 ?1 ⚑1")
    expect(frame(harness)).not.toContain("clean")
  })

  it("names the commit a detached HEAD is sitting on", async () => {
    const harness = await repository()
    await seed(harness)
    const oid = (await git(harness.directory, "rev-parse", "HEAD")).trim()
    await git(harness.directory, "checkout", "--quiet", "--detach", "HEAD")

    await start(harness)

    expect(frame(harness)).toContain(`detached at ${oid.slice(0, 7)}`)
  })

  it("marks a branch that is level with its upstream", async () => {
    const harness = await repository()
    await seed(harness)
    await addOrigin(harness)

    await start(harness)

    expect(frame(harness)).toContain("main ≡")
  })

  it("counts unpushed commits against the upstream", async () => {
    const harness = await repository()
    await seed(harness)
    await addOrigin(harness)
    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await git(harness.directory, "commit", "--quiet", "--all", "--message", "second commit")

    await start(harness)

    expect(frame(harness)).toContain("main ↑1")
  })

  it("warns that a deleted upstream is gone rather than reporting it as in sync", async () => {
    const harness = await repository()
    await seed(harness)
    await addOrigin(harness)
    await git(harness.directory, "checkout", "--quiet", "-b", "feature")
    await git(harness.directory, "push", "--quiet", "--set-upstream", "origin", "feature")
    await git(harness.directory, "push", "--quiet", "origin", "--delete", "feature")

    await start(harness)

    // The whole point of `UpstreamInfo.gone`: ahead and behind are both 0 here, so reading
    // the numbers would draw this identically to the "level with upstream" case above.
    expect(frame(harness)).toContain("feature gone")
    expect(frame(harness)).not.toContain("feature ≡")
  })
})

describe("status line segment", () => {
  it("shows the branch, and marks it when the working tree is dirty", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    expect(frame(harness)).not.toContain("main*")

    await writeFile(join(harness.directory, "tracked.txt"), "two\n")
    await press(harness, () => void harness.kernel.git.refresh())

    expect(frame(harness)).toContain("main*")
  })
})

describe("status keybindings", () => {
  it("focuses the pane from anywhere with 1", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness, { layout: `[["other"], ["status"]]`, withOtherPane: true })

    // Focus starts on the status Pane — it is the first cell that had a live Pane in it —
    // so the test has to move away before "come back here" means anything.
    await press(harness, () => harness.kernel.layout.focus("other"))
    expect(harness.kernel.layout.focusedPaneId).toBe("other")

    await press(harness, () => harness.setup.mockInput.pressKey("1"))

    expect(harness.kernel.layout.focusedPaneId).toBe("status")
  })

  it("opens the actions menu with x only while the status pane is focused", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness, { layout: `[["other"], ["status"]]`, withOtherPane: true })

    // `x` is Pane-scoped, so from another Pane it is not this Extension's key at all.
    await press(harness, () => harness.kernel.layout.focus("other"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    expect(frame(harness)).not.toContain("Fetch all remotes")

    await press(harness, () => harness.setup.mockInput.pressKey("1"))
    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    expect(frame(harness)).toContain("Fetch all remotes")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })
})

describe("status.actions", () => {
  it("offers refresh, fetch and the repository path, and hides the browser item without a web remote", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    const rendered = frame(harness)
    expect(rendered).toContain("Refresh")
    expect(rendered).toContain("Fetch all remotes")
    expect(rendered).toContain("Copy repository root path")
    // No remote at all, so there is no page to open and the item is absent rather than dead.
    expect(rendered).not.toContain("Open repository in browser")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })

  it("hides the browser item for a remote that has no web page", async () => {
    const harness = await repository()
    await seed(harness)
    await addOrigin(harness)
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    // `origin` is a bare repository on a local path — openable, but not in a browser.
    expect(frame(harness)).not.toContain("Open repository in browser")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })

  it("offers the browser item for an ssh remote it can turn into an https url", async () => {
    const harness = await repository()
    await seed(harness)
    await git(harness.directory, "remote", "add", "origin", "git@github.com:acme/widgets.git")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    expect(frame(harness)).toContain("Open repository in browser")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })

  it("shows the repository root path, since there is nothing to copy it to", async () => {
    const harness = await repository()
    await seed(harness)
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("y"))

    // The real root, which git may report through the canonical path rather than the one
    // the harness made — the last segment is the part that is the same either way.
    expect(frame(harness)).toContain(
      harness.directory
        .split("/")
        .filter((part) => part !== "")
        .at(-1) ?? "",
    )
  })

  it("drops the port when an ssh url carries one, instead of making it a path segment", async () => {
    const harness = await repository()
    await seed(harness)
    await git(harness.directory, "remote", "add", "origin", "ssh://git@github.com:22/acme/widgets.git")
    const opened = await captureOpen()
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    expect(frame(harness)).toContain("Open repository in browser")
    await press(harness, () => harness.setup.mockInput.pressKey("o"))

    // `:22` is a port in the URL spelling of an ssh remote, not the first path segment —
    // `https://github.com/22/acme/widgets` is a 404 offered by an item that promised a page.
    expect(await opened()).toEqual(["https://github.com/acme/widgets"])
  })

  it("opens an https remote directly, stripping only the .git suffix", async () => {
    const harness = await repository()
    await seed(harness)
    await git(harness.directory, "remote", "add", "origin", "https://github.com/acme/widgets.git")
    const opened = await captureOpen()
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    expect(frame(harness)).toContain("Open repository in browser")
    await press(harness, () => harness.setup.mockInput.pressKey("o"))

    // The web spelling is already a page; the only transform it needs is dropping `.git`, so
    // the path must survive intact rather than being reassembled from an ssh host/path split.
    expect(await opened()).toEqual(["https://github.com/acme/widgets"])
  })

  it("hides the browser item for a git:// daemon url", async () => {
    const harness = await repository()
    await seed(harness)
    await git(harness.directory, "remote", "add", "origin", "git://github.com/acme/widgets.git")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))

    expect(frame(harness)).not.toContain("Open repository in browser")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })

  it("surfaces git's own words when fetching fails", async () => {
    const harness = await repository()
    await seed(harness)
    await git(harness.directory, "remote", "add", "origin", "nowhere")
    await start(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    await press(harness, () => harness.setup.mockInput.pressKey("f"))

    // Not "fetch failed": credential prompting is off by design, so git's own sentence is
    // the only thing that can tell the user what to do about it.
    expect(frame(harness)).toContain("does not appear to be a git repository")
  })
})

describe("status pane at a narrow width", () => {
  /** Two Panes on a 34-cell terminal: about 13 usable cells inside the status Pane's border. */
  async function narrow(): Promise<Harness> {
    const harness = await createHarness({ git: true, width: 34 })
    await writeFile(join(harness.directory, ".gitignore"), ignored)
    await seed(harness)
    await writeFile(join(harness.directory, "loose.txt"), "loose\n")
    await start(harness, { layout: `[["status"], ["other"]]`, withOtherPane: true })
    return harness
  }

  /**
   * Content line `index` of the status Pane, counted from just under its title border.
   * Anchored on the border rather than searched for by content, so a test can assert that a
   * row is *missing* something without silently matching a line elsewhere on screen.
   */
  function paneRow(harness: Harness, index: number): string {
    const lines = frame(harness).split("\n")
    const title = lines.findIndex((line) => line.includes("─ Status "))
    expect(title).toBeGreaterThanOrEqual(0)
    return lines[title + 1 + index] ?? ""
  }

  it("stays two rows instead of reflowing the head row into the counts row's line", async () => {
    const harness = await narrow()

    // Directly under, not three lines down: every other Pane's height is budgeted against
    // this one being a fixed two-row summary, so a wrapped head row is a layout bug.
    expect(paneRow(harness, 1)).toContain("?1")
  })

  it("clips the repository name rather than the branch", async () => {
    const harness = await narrow()

    // The name of the directory laziergit was started in is the part a user can infer from
    // the window; the branch is the part the Pane exists to report, so it survives the clip.
    expect(paneRow(harness, 0)).toContain("main")
  })
})

describe("status line outside a repository", () => {
  it("leaves core's hint line whole, since the segment has nothing to say", async () => {
    const harness = await createHarness()
    await start(harness)

    // The segment renders null here, and core's hint is unconditional: between them the
    // shared line has to still be the one on-screen route to the palette and the way out.
    expect(frame(harness)).toContain("mod+p palette")
    expect(frame(harness)).toContain("q quit")
  })
})
