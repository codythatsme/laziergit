import { afterEach, describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  highlighted,
  installHarnessLifecycle,
  press,
  pressEscape,
  refreshGit,
  renderApp,
  runCommand,
  settle,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

/** The shipped Extension itself, linked into the bundled scope the way `main.tsx` loads it. */
const branchesExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "branches")
const commitsExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commits")
const commitFlowExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "commit-flow")

/** Most branch tests do not enter commit history, so keep their dependency lightweight. */
const commitsStub = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "commits",
    activate() {
      return { renderBrowser: () => null }
    },
  })
`

/**
 * Stands in for the diff Extension, which `branches` needs. A stub keeps this file about
 * branches: the {@link DiffTarget} the pane asks for is on screen where an assertion can see
 * it, and a sibling Extension's bugs cannot fail these tests.
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
        const path = current === null || current.path === null ? "none" : current.path
        return <text content={current === null ? "diff none" : "diff " + current.kind + " " + ref + " path=" + path} />
      }

      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane })
      return { current: () => target.get(), show: (next) => target.set(next) }
    },
  })
`

async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: harness.directory,
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

/** A GitHub fetch URL with a local push URL, so git and `gh` can each see the remote they need. */
async function addGithubOrigin(harness: Harness): Promise<void> {
  await git(harness, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", "origin.git")
  // Production still sees the GitHub URL, while git fetches from the local bare repository.
  // That lets cleanup exercise its real `fetch --all --prune` without touching the network.
  await git(
    harness,
    "config",
    `url.${join(harness.directory, "origin.git")}.insteadOf`,
    "git@github.com:acme/tools.git",
  )
  await git(harness, "remote", "add", "origin", "git@github.com:acme/tools.git")
  await git(harness, "remote", "set-url", "--push", "origin", join(harness.directory, "origin.git"))
}

interface GhStub {
  setPullRequests(pullRequests: readonly unknown[]): Promise<void>
  releaseGraphql(): Promise<void>
  calls(): Promise<readonly string[]>
}

interface OpenRecorder {
  readonly open: (url: string) => Promise<void>
  readonly opened: () => string
}

function recordOpens(): OpenRecorder {
  let opened = ""
  return {
    open: async (url) => {
      opened = url
    },
    opened: () => opened,
  }
}

/** A controllable, platform-native `gh`; no test lookup can reach the network. */
async function installGh(harness: Harness, listDelaySeconds = 0, blockGraphql = false): Promise<GhStub> {
  const bin = join(harness.directory, "bin")
  const answers = join(bin, "pull-requests.json")
  const graphqlAnswers = join(bin, "pull-requests-graphql.json")
  const graphqlRelease = join(bin, "graphql.release")
  const calls = join(bin, "gh.log")
  await mkdir(bin, { recursive: true })

  const gh =
    process.platform === "win32"
      ? [
          "@echo off",
          `>>"${calls}" echo(%*`,
          'if /i "%~1 %~2"=="pr list" goto pr_list',
          'if /i "%~1 %~2"=="api graphql" goto api_graphql',
          "exit /b 1",
          ":pr_list",
          ...(listDelaySeconds === 0 ? [] : [`  ping 127.0.0.1 -n ${listDelaySeconds + 1} > nul`]),
          `type "${answers}"`,
          "exit /b 0",
          ":api_graphql",
          ...(blockGraphql
            ? [
                `powershell -NoLogo -NoProfile -NonInteractive -Command "while (-not (Test-Path -LiteralPath '${graphqlRelease}')) { Start-Sleep -Milliseconds 25 }"`,
              ]
            : []),
          `type "${graphqlAnswers}"`,
          "exit /b 0",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> "${calls}"`,
          'if [ "$1 $2" = "pr list" ]; then',
          ...(listDelaySeconds === 0 ? [] : [`  sleep ${listDelaySeconds}`]),
          `  exec cat "${answers}"`,
          "fi",
          'if [ "$1 $2" = "api graphql" ]; then',
          ...(blockGraphql ? [`  while [ ! -f "${graphqlRelease}" ]; do sleep 0.025; done`] : []),
          `  exec cat "${graphqlAnswers}"`,
          "fi",
          "exit 1",
          "",
        ].join("\n")
  const executable = join(bin, process.platform === "win32" ? "gh.cmd" : "gh")
  await Promise.all([
    writeFile(executable, gh, { mode: 0o755 }),
    writeFile(answers, "[]"),
    writeFile(graphqlAnswers, JSON.stringify({ data: { repository: {} } })),
  ])
  process.env.PATH = `${bin}${delimiter}${originalPath}`

  return {
    releaseGraphql: () => writeFile(graphqlRelease, ""),
    setPullRequests: async (pullRequests) => {
      await Promise.all([
        writeFile(answers, JSON.stringify(pullRequests)),
        writeFile(graphqlAnswers, JSON.stringify({ data: { repository: { branch0: { nodes: pullRequests } } } })),
      ])
    },
    calls: async () => ((await Bun.file(calls).exists()) ? (await Bun.file(calls).text()).trim().split("\n") : []),
  }
}

/** Releases the polling native stub while keeping its response-driven React updates inside act. */
async function releaseGraphqlAndSettle(harness: Harness, gh: GhStub): Promise<void> {
  await act(async () => {
    await gh.releaseGraphql()
    // The native stubs poll every 25ms. Keeping several polls inside act covers command exit,
    // response parsing, and the branch, hint-bar, and status-line updates it publishes.
    // oxlint-disable-next-line no-restricted-properties -- deliberately settling a native polling stub
    await Bun.sleep(100)
  })
  await waitForFrame(harness, "* main ")
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
 * Renders with the real branches Extension loaded. Startup focus is the Layout's first cell,
 * so a test that needs the branches Pane unfocused writes a Layout putting the diff Pane in
 * front of it. `"tabbed"` puts both Panes in one cell, where `]` hides — and therefore
 * unmounts — the one that was showing. Mutations made behind the app's back reach the store
 * through {@link refreshGit}, so the fingerprint poll is parked out of every test's way.
 */
async function start(
  harness: Harness,
  focus: "branches" | "diff" | "tabbed" = "branches",
  realCommits = false,
): Promise<void> {
  const columns = realCommits
    ? focus === "tabbed"
      ? `[[["branches", "commits", "diff"]]]`
      : focus === "branches"
        ? `[[["branches", "commits"]], ["diff"]]`
        : `[["diff"], [["branches", "commits"]]]`
    : focus === "tabbed"
      ? `[[["branches", "diff"]]]`
      : focus === "branches"
        ? `[["branches"], ["diff"]]`
        : `[["diff"], ["branches"]]`
  const setup = [
    symlink(branchesExtension, join(harness.bundled, "branches")),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(
      harness.configFiles.repo,
      `{ "layout": { "columns": ${columns} }, "git": { "refreshIntervalMs": 60000 } }`,
    ),
  ]
  if (realCommits) {
    setup.push(
      symlink(commitsExtension, join(harness.bundled, "commits")),
      symlink(commitFlowExtension, join(harness.bundled, "commit-flow")),
    )
  } else {
    setup.push(writeFile(join(harness.repo, "commits.ts"), commitsStub))
  }
  await Promise.all(setup)
  await renderApp(harness)
  if (focus === "branches") await runCommand(harness, "branches.focus")
}

async function openMergeMenuForSecondBranch(harness: Harness, branch: string): Promise<void> {
  await press(harness, "j")
  await press(harness, "M")
  await waitForFrame(harness, `Merge ${branch} into main`)
}

async function chooseMergeMode(harness: Harness, offset: number): Promise<void> {
  for (let index = 0; index < offset; index += 1) {
    await press(harness, () => harness.setup.mockInput.pressArrow("down"))
  }
  await press(harness, () => harness.setup.mockInput.pressEnter())
}

describe("viewing a branch's commits and files", () => {
  it("drills into the selected branch and returns through both transient views", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await writeFile(join(harness.directory, "topic-one.txt"), "one\n")
    await git(harness, "add", "topic-one.txt")
    await git(harness, "commit", "--quiet", "--message", "topic first")
    await writeFile(join(harness.directory, "topic-two.txt"), "two\n")
    await git(harness, "add", "topic-two.txt")
    await git(harness, "commit", "--quiet", "--message", "topic second")
    const topicTip = await git(harness, "rev-parse", "--short", "topic")

    await git(harness, "checkout", "--quiet", "main")
    await writeFile(join(harness.directory, "main-only.txt"), "main\n")
    await git(harness, "add", "main-only.txt")
    await git(harness, "commit", "--quiet", "--message", "main only")
    await start(harness, "branches", true)

    await press(harness, "j")
    await waitForFrame(harness, "diff branch topic path=none")
    await press(harness, "\r")

    await waitForFrame(harness, "topic commits")
    await waitForFrame(harness, `diff commit ${topicTip} path=none`)
    const history = frame(harness)
    expect(history).toContain("topic first")
    expect(history).toContain("topic second")
    expect(history).not.toContain("main only")

    await press(harness, "\r")
    await waitForFrame(harness, "A  topic-two.txt")
    await waitForFrame(harness, `diff commit ${topicTip} path=topic-two.txt`)

    await pressEscape(harness)
    await waitForFrame(harness, `diff commit ${topicTip} path=none`)
    expect(frame(harness)).not.toContain("A  topic-two.txt")

    await pressEscape(harness)
    await waitForFrame(harness, "diff branch topic path=none")
    expect(highlighted(harness).some((row) => row.includes("topic"))).toBeTrue()
  })
})

describe("operation activity", () => {
  it("does not show loaders for staging or unstaging", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await start(harness)

    for (const label of ["staging", "unstaging"]) {
      const end = harness.kernel.git.activity.begin(label)
      await waitFor(harness, () => harness.kernel.git.activity.getSnapshot().length === 1, `${label} to be revealed`)

      expect(frame(harness)).not.toContain(label)

      act(() => end())
    }
  })

  it("keeps only the commit animation at the end of the checked-out branch row", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "other")
    await start(harness)

    const end = harness.kernel.git.activity.begin("committing")
    const loader = /[\u2800-\u28ff]{3}/u
    await waitForFrame(harness, (screen) =>
      screen.split("\n").some((line) => line.includes("* main") && loader.test(line)),
    )

    const frames: string[] = []
    while (frames.length < 12 && harness.kernel.git.activity.getSnapshot().length > 0) {
      const line = frame(harness)
        .split("\n")
        .find((row) => row.includes("* main") && loader.test(row))
      if (line === undefined) break
      frames.push(line)
      await act(async () => {
        // oxlint-disable-next-line no-restricted-properties -- sampling animation frames over real time
        await Bun.sleep(70)
      })
      await settle(harness)
    }

    for (const line of frames) {
      expect(line).toContain("* main")
      expect(line).not.toContain("committing")
      const activityEnd = line.search(loader) + 3
      expect(activityEnd).toBeGreaterThan(line.indexOf("main"))
      // Right-aligned in the row: after the animation there is only the Pane's own padding and
      // border, not unused row width.
      const borderDistance = line.slice(activityEnd).indexOf("│")
      expect(borderDistance).toBeGreaterThanOrEqual(0)
      expect(borderDistance).toBeLessThanOrEqual(2)
      const other = line.slice(line.indexOf("other"))
      expect(loader.test(other)).toBe(false)
    }
    const glyphs = new Set(frames.flatMap((line) => Array.from(line).filter((char) => char >= "⠀" && char <= "⣿")))
    expect(glyphs.size).toBeGreaterThan(3)

    act(() => end())
    await waitFor(harness, () => !loader.test(frame(harness)), "the inline loader to withdraw")
    expect(frame(harness)).toContain("* main")
    expect(harness.kernel.diagnostics.getSnapshot()).toEqual([])
  })

  it("does not show a fetch loader in the checked-out branch row", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await start(harness)

    const end = harness.kernel.git.activity.begin("fetching")
    await waitFor(harness, () => harness.kernel.git.activity.getSnapshot().length === 1, "fetching to be revealed")
    const headRow = frame(harness)
      .split("\n")
      .find((line) => line.includes("* main"))
    if (headRow === undefined) throw new Error("Expected the checked-out branch row")
    expect(headRow).not.toContain("fetching")
    expect(headRow).not.toMatch(/[\u2800-\u28ff]/u)

    act(() => end())
  })
})

describe("checking out", () => {
  it("is unavailable on HEAD and switches to another selected branch", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "other")

    await start(harness)

    // The cursor starts on HEAD, where the contextual Command is unavailable.
    await press(harness, " ")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")

    await press(harness, "j")
    await press(harness, " ")
    // The marker moves because the store refreshed behind the write, which is why a checkout
    // goes through the porcelain helper rather than `raw`.
    await waitForFrame(harness, "* other")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other")
  }, 30_000)

  it("moves the cursor to the checked-out branch when it moves to the top", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "branch", "alpha")
    await git(harness, "branch", "bravo")
    await git(harness, "branch", "charlie")
    await git(harness, "branch", "delta")

    await start(harness)

    await press(harness, "j")
    await press(harness, "j")
    await press(harness, "j")
    await press(harness, "j")
    expect(highlighted(harness).some((row) => row.includes("delta"))).toBeTrue()

    await press(harness, " ")
    await waitForFrame(harness, "* delta")

    expect(highlighted(harness).some((row) => row.includes("* delta"))).toBeTrue()
  }, 30_000)
})

describe("creating a branch", () => {
  it("refuses a nameless branch, then creates one at the selected branch and checks it out", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, "n")
    await waitForFrame(harness, "New branch at main")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "Name the branch")

    await press(harness, () => void harness.setup.mockInput.typeText("feature/x"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "* feature/x")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x")
    // Created *at* the selected branch, which is what "here" in the Command title means.
    expect(await git(harness, "rev-parse", "feature/x")).toBe(await git(harness, "rev-parse", "main"))
  }, 30_000)

  it("refuses a name with a space in it, which git would only reject later", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)

    await press(harness, "n")
    await waitForFrame(harness, "New branch at main")
    await press(harness, () => void harness.setup.mockInput.typeText("two words"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "cannot contain spaces")
    expect(await git(harness, "branch", "--list", "--format=%(refname:short)")).toBe("main")
  }, 30_000)
})

describe("branch names", () => {
  it("renames the selected branch with capital R", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await start(harness)

    await press(harness, "R")
    await waitForFrame(harness, "Rename branch")
    await press(harness, () => void harness.setup.mockInput.typeText("-renamed"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "* main-renamed")
    expect(await git(harness, "branch", "--show-current")).toBe("main-renamed")
  })

  it("copies the selected branch name with the primary modifier and C", async () => {
    const harness = await createHarness({
      git: true,
      clipboardWriters: [[process.execPath, ["-e", 'if (await Bun.stdin.text() !== "main") process.exit(1)']]],
    })
    await seed(harness)
    await start(harness)

    await press(harness, "c", { ctrl: true })
    await waitForFrame(harness, "Copied main")
  })
})

describe("merging a branch into the checked-out branch", () => {
  async function withFastForwardTopic(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await commit(harness, "topic\n", "topic work")
    await git(harness, "checkout", "--quiet", "main")
  }

  async function withDivergedTopic(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await writeFile(join(harness.directory, "topic.txt"), "topic\n")
    await git(harness, "add", "topic.txt")
    await git(harness, "commit", "--quiet", "--message", "topic work")
    await git(harness, "checkout", "--quiet", "main")
    await writeFile(join(harness.directory, "main.txt"), "main\n")
    await git(harness, "add", "main.txt")
    await git(harness, "commit", "--quiet", "--message", "main work")
  }

  async function withConflictingTopic(harness: Harness): Promise<void> {
    await seed(harness)
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await commit(harness, "topic\n", "topic work")
    await git(harness, "checkout", "--quiet", "main")
    await commit(harness, "main\n", "main work")
  }

  it("is unavailable on HEAD and fast-forwards another branch without switching", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)
    const target = await git(harness, "rev-parse", "topic")

    await start(harness)

    expect(harness.kernel.commands.getSnapshot().map((command) => command.id)).not.toContain("branches.merge")

    await openMergeMenuForSecondBranch(harness, "topic")
    expect(frame(harness)).toContain("Regular merge (fast-forward)")
    expect(frame(harness)).toContain("Regular merge (with merge commit)")
    expect(frame(harness)).toContain("Squash merge and leave uncommitted")
    expect(frame(harness)).toContain("↑↓ move  ·  enter run  ·  escape cancel")

    await chooseMergeMode(harness, 0)
    // The toast is the command's last act, after the write and its follow-up refresh, so
    // once it shows the repository below is in its final state.
    await waitForFrame(harness, "Merged topic into main")
    expect(await git(harness, "rev-parse", "main")).toBe(target)
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("creates a merge commit when the histories have diverged", async () => {
    const harness = await createHarness({ git: true })
    await withDivergedTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")

    expect(frame(harness)).toContain("Regular merge (with merge commit)")
    expect(frame(harness)).not.toContain("Regular merge (fast-forward)")

    await chooseMergeMode(harness, 0)
    await waitForFrame(harness, "Merged topic into main")
    expect((await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ")).toHaveLength(2)
    expect(await git(harness, "log", "-1", "--format=%s")).toBe("Merge branch 'topic'")
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("can squash into the index without moving HEAD", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)
    const before = await git(harness, "rev-parse", "HEAD")

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await chooseMergeMode(harness, 2)

    await waitForFrame(harness, "Squash-merged topic; the changes are staged")
    expect(await git(harness, "diff", "--cached", "--name-only")).toBe("work.txt")
    expect(await git(harness, "rev-parse", "HEAD")).toBe(before)
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("one")
  }, 30_000)

  it("can commit a squash with a message naming both branches", async () => {
    const harness = await createHarness({ git: true })
    await withFastForwardTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await chooseMergeMode(harness, 3)

    await waitForFrame(harness, "Squash-merged topic into main")
    expect(await git(harness, "log", "-1", "--format=%s")).toBe("Squash merge topic into main")
    expect((await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ")).toHaveLength(1)
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("offers the conflicted files and can abort a stopped merge", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await chooseMergeMode(harness, 0)
    await waitForFrame(harness, "Merge topic stopped with conflicts")

    expect(frame(harness)).toContain("View conflicted files")
    expect(frame(harness)).toContain("Abort merge")
    expect(await git(harness, "diff", "--name-only", "--diff-filter=U")).toBe("work.txt")

    await press(harness, "a")
    await waitForFrame(harness, "Merge aborted")
    expect(await git(harness, "status", "--porcelain")).toBe("")
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("main")
  }, 30_000)

  it("restores the pre-merge tree when a conflicted squash is aborted", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await chooseMergeMode(harness, 1)
    await waitForFrame(harness, "Merge topic stopped with conflicts")
    expect(frame(harness)).toContain("Abort squash merge")

    await press(harness, "a")
    await waitForFrame(harness, "Abort the squash merge?")
    await press(harness, "y")
    await waitForFrame(harness, "Squash merge aborted")
    expect(await git(harness, "status", "--porcelain")).toBe("")
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("main")
  }, 30_000)

  it("recovers an in-progress merge and commits after its conflicts are resolved", async () => {
    const harness = await createHarness({ git: true })
    await withConflictingTopic(harness)

    await start(harness)
    await openMergeMenuForSecondBranch(harness, "topic")
    await chooseMergeMode(harness, 0)
    await waitForFrame(harness, "Merge topic stopped with conflicts")
    await pressEscape(harness)

    await writeFile(join(harness.directory, "work.txt"), "resolved\n")
    await git(harness, "add", "work.txt")
    await refreshGit(harness)

    await press(harness, "M")
    await waitForFrame(harness, "Merge in progress on main")
    expect(frame(harness)).toContain("Continue merge")
    expect(frame(harness)).toContain("Abort merge")

    await press(harness, "c")
    await waitForFrame(harness, "Merge completed")
    expect((await git(harness, "show", "--no-patch", "--format=%P", "HEAD")).split(" ")).toHaveLength(2)
    expect(await git(harness, "show", "HEAD:work.txt")).toBe("resolved")
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
    await press(harness, "j")
    await press(harness, "d")
    await waitForFrame(harness, "Delete wip?")

    await press(harness, "y")
    // git's refusal is read, not assumed: the second confirm only appears because the branch
    // is unmerged.
    await waitForFrame(harness, "Force delete wip?")
    expect(frame(harness)).toContain("commits no other branch has")

    await press(harness, "y")
    // The row leaving the screen is the store publishing the delete, which is the write's
    // last effect.
    await waitForFrame(harness, (screen) => !screen.includes("wip"))
    expect(await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")).toBe("")
  }, 30_000)

  it("keeps the branch when the force confirm is declined", async () => {
    const harness = await createHarness({ git: true })
    await withUnmergedBranch(harness)

    await start(harness)
    await press(harness, "j")
    await press(harness, "d")
    await waitForFrame(harness, "Delete wip?")
    await press(harness, "y")
    await waitForFrame(harness, "Force delete wip?")

    await press(harness, "n")
    await waitForFrame(harness, (screen) => !screen.includes("Force delete wip?"))
    expect(await git(harness, "branch", "--list", "wip", "--format=%(refname:short)")).toBe("wip")
  }, 30_000)

  it("does not publish delete for the branch you are on", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)

    await start(harness)
    await press(harness, "d")

    expect(harness.kernel.commands.getSnapshot().map((command) => command.id)).not.toContain("branches.delete")
    expect(frame(harness)).not.toContain("Delete main?")
  }, 30_000)
})

describe("contextual branch Commands", () => {
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

  function commandIds(harness: Harness): readonly string[] {
    return harness.kernel.commands.getSnapshot().map((command) => command.id)
  }

  it("publishes only what applies to the selected branch", async () => {
    const harness = await createHarness({ git: true })
    await withBehindBranch(harness)

    await start(harness)
    await waitForFrame(harness, "diff branch main")

    const onHead = commandIds(harness)
    expect(onHead).toContain("branches.create")
    // Nothing that would act on the branch you are standing on.
    expect(onHead).not.toContain("branches.checkout")
    expect(onHead).not.toContain("branches.delete")
    expect(onHead).not.toContain("branches.merge")
    // In sync is not behind, so there is nothing to fast-forward.
    expect(onHead).not.toContain("branches.fast-forward")

    await press(harness, "j")
    await waitForFrame(harness, "diff branch stale")

    const onStale = commandIds(harness)
    expect(onStale).toContain("branches.checkout")
    expect(onStale).toContain("branches.merge")
    expect(onStale).toContain("branches.force-delete")
    expect(onStale).toContain("branches.fast-forward")
    // It has an upstream already, so there is nothing to set one up for.
    expect(onStale).not.toContain("branches.push-upstream")
  }, 30_000)

  /**
   * The URL itself is `pull-request.test.ts`'s subject; what this pins is the offer. `addOrigin`
   * points `origin` at a bare directory, which is a remote with no web page at all.
   */
  it("hides the pull-request Command when the remote is a directory nobody can browse", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)

    await start(harness)
    await waitForFrame(harness, "diff branch main")

    expect(commandIds(harness)).not.toContain("branches.pull-request")
  }, 30_000)

  it("offers a pull request when the remote is a hosting service", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await git(harness, "remote", "add", "origin", "git@github.com:acme/tools.git")

    await start(harness)
    await waitForFrame(harness, "diff branch main")

    expect(commandIds(harness)).toContain("branches.pull-request")
  }, 30_000)

  it("fast-forwards a branch that is not checked out", async () => {
    const harness = await createHarness({ git: true })
    await withBehindBranch(harness)
    const target = await git(harness, "rev-parse", "main")
    expect(await git(harness, "rev-parse", "stale")).not.toBe(target)

    await start(harness)
    // The behind marker is what the fast-forward erases, so its presence is the baseline.
    await waitForFrame(harness, "↓1")
    await press(harness, "j")
    await waitForFrame(harness, "diff branch stale")
    await press(harness, "f")

    await waitForFrame(harness, (screen) => !screen.includes("↓1"))
    expect(await git(harness, "rev-parse", "stale")).toBe(target)
    // The user never left the branch they were on.
    expect(await git(harness, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  }, 30_000)

  it("offers to push a branch that has no upstream, and sets one", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)

    await start(harness)
    await waitForFrame(harness, "diff branch main")
    expect(commandIds(harness)).toContain("branches.push-upstream")

    await press(harness, "P")
    // A row says nothing about an upstream that is in sync, so the outcome is read from the
    // store rather than from the frame. Waiting for the store also waits for the write's
    // follow-up refresh, not merely for git's first on-disk side effect.
    await waitFor(
      harness,
      () => {
        const upstream = harness.kernel.git.getSnapshot().branches.find((branch) => branch.name === "main")?.upstream
        return upstream?.remote === "origin" && upstream.branch === "main"
      },
      "the branch to report an upstream",
    )
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
    // The stub prints the DiffTarget it was handed, so this pins the kind the Pane pushes:
    // `branch`, which is what lets the detail view name what a clipped row cut off.
    await waitForFrame(harness, "diff branch main")

    await press(harness, "j")
    await waitForFrame(harness, "diff branch topic")

    await press(harness, "u")
    await waitForFrame(harness, "Upstream for topic")
    expect(frame(harness)).toContain("origin/topic")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitFor(
      harness,
      () => {
        const upstream = harness.kernel.git.getSnapshot().branches.find((branch) => branch.name === "topic")?.upstream
        return upstream?.remote === "origin" && upstream.branch === "topic"
      },
      "the upstream to be configured",
    )
    expect(await git(harness, "config", "--get", "branch.topic.merge")).toBe("refs/heads/topic")
  }, 30_000)
})

describe("what a row says about its upstream", () => {
  it("prints only nonzero counts and a check when the upstream is exactly in sync", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    await commit(harness, "two\n", "local work")

    await start(harness)

    // Ahead by one, behind by none: the row says `↑1` and stops there.
    await waitForFrame(harness, "↑1")
    expect(frame(harness)).toContain("* main")
    expect(frame(harness)).not.toContain("↓")

    await git(harness, "push", "--quiet")
    await refreshGit(harness)
    await waitForFrame(harness, (screen) => !screen.includes("↑1"))
    // LazyGit's check means both publication and exact agreement with the tracked ref.
    const synced = frame(harness)
    expect(synced).toContain("* main ✓")
    expect(synced).not.toContain("↑")
  }, 30_000)

  it("replaces the in-sync check with a GitHub logo and opens that pull request", async () => {
    const opener = recordOpens()
    const harness = await createHarness({ git: true, openExternal: opener.open })
    await seed(harness)
    await addGithubOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    const gh = await installGh(harness)
    const url = "https://github.com/acme/tools/pull/42"
    await gh.setPullRequests([
      {
        headRefName: "main",
        headRepositoryOwner: { login: "acme" },
        state: "OPEN",
        isDraft: false,
        url,
        createdAt: "2026-08-04T00:00:00Z",
      },
    ])

    await start(harness)
    await waitForFrame(harness, "* main ")
    const row = frame(harness)
      .split("\n")
      .find((line) => line.includes("* main"))
    expect(row).not.toContain("✓")
    const lookup = (await gh.calls())[0]
    expect(lookup).toStartWith("api graphql --hostname github.com")
    expect(lookup).toContain("headRefName headRefOid headRepositoryOwner { login }")
    expect(lookup).toContain("-f branch0=main")

    await press(harness, "o")
    await waitFor(harness, () => opener.opened() === url, "the pull request URL to reach the opener")
  }, 30_000)

  it("opens the create page without waiting for a slow pull request refresh", async () => {
    const opener = recordOpens()
    const harness = await createHarness({ git: true, openExternal: opener.open })
    await seed(harness)
    await addGithubOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    const gh = await installGh(harness, 0, true)
    await gh.setPullRequests([
      {
        headRefName: "main",
        headRepositoryOwner: { login: "acme" },
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/acme/tools/pull/42",
        createdAt: "2026-08-04T00:00:00Z",
      },
    ])

    await start(harness)
    await waitFor(harness, async () => (await gh.calls()).length > 0, "the slow pull request lookup to start")
    await press(harness, "o")

    try {
      await waitFor(
        harness,
        () => opener.opened() === "https://github.com/acme/tools/compare/main?expand=1",
        "the pull request creation URL to open independently of the lookup",
        { timeoutMs: 300 },
      )
    } finally {
      // Never strand the native stub if the responsiveness assertion fails: Windows keeps
      // the temporary repository locked until this deliberately blocked process exits.
      await releaseGraphqlAndSettle(harness, gh)
    }
  }, 30_000)

  it("finds a branch pull request without waiting for a repository-wide scan", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addGithubOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    const gh = await installGh(harness, 2)
    await gh.setPullRequests([
      {
        headRefName: "main",
        headRepositoryOwner: { login: "acme" },
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/acme/tools/pull/42",
        createdAt: "2026-08-04T00:00:00Z",
      },
    ])

    await start(harness)
    await waitForFrame(harness, "* main ", { timeoutMs: 500 })
    expect((await gh.calls()).some((call) => call.startsWith("pr list"))).toBe(false)
  }, 30_000)

  it("coalesces identical refreshes while a pull request query is in flight", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addGithubOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    const gh = await installGh(harness, 0, true)
    await gh.setPullRequests([
      {
        headRefName: "main",
        headRepositoryOwner: { login: "acme" },
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/acme/tools/pull/42",
        createdAt: "2026-08-04T00:00:00Z",
      },
    ])

    await start(harness)
    await waitFor(harness, async () => (await gh.calls()).length > 0, "the pull request lookup to start")
    const branches = harness.kernel.git.getSnapshot().branches
    await act(async () => {
      harness.kernel.events.emit("git.branches.changed", { current: branches, previous: branches })
    })
    await settle(harness)

    expect(await gh.calls()).toHaveLength(1)
    // Waiting for the visible result proves the released command finished and prevents
    // Windows teardown from racing a native process that still owns the temp repository.
    await releaseGraphqlAndSettle(harness, gh)
  }, 30_000)

  it("draws a branch whose upstream was deleted in the danger colour", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await addOrigin(harness)
    await git(harness, "checkout", "--quiet", "-b", "abandoned")
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "abandoned")
    await git(harness, "push", "--quiet", "--delete", "origin", "abandoned")
    await git(harness, "fetch", "--quiet", "--prune")

    await start(harness)
    await waitForFrame(harness, "abandoned")

    // `gone` is reported by git as `↑0 ↓0`, byte-identical to a branch in sync, so colour is
    // the whole signal — and the char frame cannot see it. Spans can.
    const nameSpan = (needle: string) =>
      harness.setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes(needle))

    const danger = RGBA.fromHex(harness.kernel.theme.getSnapshot().danger)
    expect(nameSpan("abandoned")?.fg?.equals(danger)).toBe(true)
    // And the contrast, or the assertion above would pass in a theme that painted everything
    // red: `main` is here too, tracking nothing, and its name is ordinary text.
    expect(nameSpan("main")?.fg?.equals(danger)).toBe(false)
  }, 30_000)

  it("truncates long names before the in-sync check and divergence", async () => {
    const harness = await createHarness({ git: true, width: 60 })
    await seed(harness)
    await addOrigin(harness)
    await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
    const behind = "feature/behind-PROJ-1234-a-name-that-cannot-fit-in-a-narrow-column"
    const synced = "feature/synced-PROJ-1234-a-name-that-cannot-fit-in-a-narrow-column"
    await git(harness, "branch", behind)
    await git(harness, "branch", "--set-upstream-to", "origin/main", "--", behind)
    await commit(harness, "two\n", "remote work")
    await git(harness, "push", "--quiet")
    await git(harness, "branch", synced)
    await git(harness, "branch", "--set-upstream-to", "origin/main", "--", synced)

    await start(harness)
    await waitForFrame(harness, (screen) => screen.includes("↓1") && screen.includes("..."))

    // The name owns the shrinkable middle cell. Its ellipsis ends the visible prefix before
    // fixed-width status, and none of its hidden tail can wrap into the next branch's row.
    const lines = frame(harness).split("\n")
    const behindLine = lines.find((line) => line.includes("↓1"))
    const syncedLine = lines.find((line) => line.includes("feature/") && line.includes("✓"))
    if (behindLine === undefined || syncedLine === undefined) throw new Error("Expected both long branch rows")
    expect(behindLine).toContain("...")
    expect(behindLine).toContain("feature/behind-")
    expect(behindLine).toContain("↓1")
    expect(behindLine.indexOf("...")).toBeLessThan(behindLine.indexOf("↓1"))
    expect(behindLine.slice(behindLine.indexOf("...") + 3, behindLine.indexOf("↓1")).trim()).toBe("")
    expect(syncedLine).toContain("...")
    expect(syncedLine).toContain("feature/synced-")
    expect(syncedLine).toContain("✓")
    expect(syncedLine.indexOf("...")).toBeLessThan(syncedLine.indexOf("✓"))
    expect(syncedLine.slice(syncedLine.indexOf("...") + 3, syncedLine.indexOf("✓")).trim()).toBe("")
    expect(frame(harness)).not.toContain("narrow-column")
  }, 30_000)
})
