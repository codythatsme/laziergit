import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  highlighted,
  installHarnessLifecycle,
  press,
  refreshGit,
  renderApp,
  runCommand,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

const pullRequestsExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "pull-requests")
const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

const branchesSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "branches",
    activate(ctx) {
      ctx.panes.register({ id: "branches", title: "Local", component: () => <text content="local branches" /> })
    },
  })
`

interface GhStub {
  setPullRequests(pullRequests: readonly unknown[]): Promise<void>
  fail(message: string): Promise<void>
  calls(): Promise<readonly string[]>
}

async function installGh(harness: Harness): Promise<GhStub> {
  const bin = join(harness.directory, "bin")
  const response = join(bin, "response.json")
  const failure = join(bin, "failure.txt")
  const log = join(bin, "gh.log")
  await mkdir(bin, { recursive: true })

  const gh = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    'if [ "$1 $2" = "api graphql" ]; then',
    `  if [ -f "${failure}" ]; then cat "${failure}" >&2; exit 1; fi`,
    `  exec cat "${response}"`,
    "fi",
    'if [ "$1 $2" = "pr checkout" ]; then',
    "  git checkout --quiet -b feature/new",
    "  exit $?",
    "fi",
    "exit 1",
    "",
  ].join("\n")

  await Promise.all([
    writeFile(join(bin, "gh"), gh, { mode: 0o755 }),
    writeFile(response, JSON.stringify([queryResponse([])])),
  ])
  process.env.PATH = `${bin}${delimiter}${originalPath}`

  return {
    setPullRequests: async (pullRequests) => {
      await Bun.file(failure)
        .delete()
        .catch(() => undefined)
      await writeFile(response, JSON.stringify([queryResponse(pullRequests)]))
    },
    fail: (message) => writeFile(failure, message),
    calls: async () => ((await Bun.file(log).exists()) ? (await Bun.file(log).text()).trim().split("\n") : []),
  }
}

function queryResponse(pullRequests: readonly unknown[]) {
  return {
    data: {
      viewer: { login: "claudia" },
      repository: {
        pullRequests: { nodes: pullRequests, pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  }
}

function pullRequest(number: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title,
    url: `https://github.com/base/project/pull/${number}`,
    headRefName: `feature/${number}`,
    isDraft: false,
    updatedAt: "2026-08-24T10:00:00Z",
    author: { login: "claudia" },
    ...extra,
  }
}

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

async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".git", "info", "exclude"), "bundled/\nglobal/\nrepo/\nbin/\n*.jsonc\n")
  await writeFile(join(harness.directory, "seed.txt"), "seed\n")
  await git(harness, "add", "seed.txt")
  await git(harness, "commit", "--quiet", "--message", "seed")
}

async function addGithubRemote(harness: Harness): Promise<void> {
  await git(harness, "remote", "add", "origin", "git@github.com:base/project.git")
}

async function start(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(pullRequestsExtension, join(harness.bundled, "pull-requests")),
    writeFile(join(harness.repo, "branches.tsx"), branchesSource),
    writeFile(
      harness.configFiles.repo,
      `{ "layout": { "columns": [[["branches", "pull-requests"]]], "focus": "branches" }, "git": { "refreshIntervalMs": 60000 } }`,
    ),
  ])
  await renderApp(harness)
}

async function pullRequestsHarness(
  options: Parameters<typeof createHarness>[0] = {},
): Promise<{ readonly harness: Harness; readonly gh: GhStub }> {
  const harness = await createHarness({ git: true, width: 150, height: 30, ...options })
  await seed(harness)
  await addGithubRemote(harness)
  const gh = await installGh(harness)
  return { harness, gh }
}

describe.skipIf(process.platform === "win32")("pull requests pane", () => {
  it("lists every authored open or draft pull request by most recent update", async () => {
    const { harness, gh } = await pullRequestsHarness()
    await gh.setPullRequests([
      pullRequest(10, "Older pull request", { updatedAt: "2026-08-20T10:00:00Z" }),
      pullRequest(12, "Someone else's", {
        updatedAt: "2026-08-24T11:00:00Z",
        author: { login: "someone-else" },
      }),
      pullRequest(11, "Draft pull request", {
        headRefName: "feature/draft",
        isDraft: true,
        updatedAt: "2026-08-24T10:00:00Z",
      }),
    ])
    await start(harness)
    expect(await gh.calls()).toEqual([])
    await runCommand(harness, "pull-requests.focus")

    await waitForFrame(harness, "Draft pull request")
    const listed = frame(harness)
    expect(listed).toContain("D #11 Draft pull request")
    expect(listed).toContain("feature/draft")
    expect(listed).toContain("#10 Older pull request")
    expect(listed).toContain("feature/10")
    expect(listed).not.toContain("Someone else's")
    expect(listed.indexOf("Draft pull request")).toBeLessThan(listed.indexOf("Older pull request"))
    expect(highlighted(harness).some((row) => row.includes("#11 Draft pull request"))).toBe(true)

    const query = (await gh.calls())[0] ?? ""
    expect(query).toContain("api graphql --paginate --slurp --hostname github.com")
    expect(query).toContain("states: [OPEN]")
    expect(query).toContain("field: UPDATED_AT")
  }, 30_000)

  it("opens, copies, and safely checks out the selected pull request", async () => {
    let opened = ""
    const expectedUrl = "https://github.com/base/project/pull/42"
    const { harness, gh } = await pullRequestsHarness({
      openExternal: async (url) => {
        opened = url
      },
      clipboardWriters: [
        [process.execPath, ["-e", `if (await Bun.stdin.text() !== ${JSON.stringify(expectedUrl)}) process.exit(1)`]],
      ],
    })
    await gh.setPullRequests([
      pullRequest(42, "Build pull requests pane", { url: expectedUrl, headRefName: "feature/new" }),
    ])
    await start(harness)
    await runCommand(harness, "pull-requests.focus")
    await waitForFrame(harness, "Build pull requests pane")

    await press(harness, "o")
    await waitFor(harness, () => opened === expectedUrl, "the selected pull request to reach the browser opener")

    await press(harness, "y")
    await waitForFrame(harness, "Copied pull request #42 URL")

    await press(harness, " ")
    await waitFor(harness, async () => (await git(harness, "branch", "--show-current")) === "feature/new", "checkout")
    await waitForFrame(harness, "Checked out feature/new")
    expect(highlighted(harness).some((row) => row.includes("#42 Build pull requests pane"))).toBe(true)

    const checkout = (await gh.calls()).find((call) => call.startsWith("pr checkout")) ?? ""
    expect(checkout).toBe("pr checkout 42 --repo github.com/base/project")
    expect(checkout).not.toContain("--force")
  }, 30_000)

  it("keeps the last successful list visible when a manual refresh fails", async () => {
    const { harness, gh } = await pullRequestsHarness()
    await gh.setPullRequests([pullRequest(7, "Still useful while stale")])
    await start(harness)
    await runCommand(harness, "pull-requests.focus")
    await waitForFrame(harness, "Still useful while stale")

    await gh.fail("gh: authenticate with gh auth login")
    await press(harness, "r")
    await waitForFrame(harness, "gh: authenticate with gh auth login")
    expect(frame(harness)).toContain("Still useful while stale")
  }, 30_000)

  it("registers the tab only after a browsable remote appears", async () => {
    const harness = await createHarness({ git: true })
    await seed(harness)
    await installGh(harness)
    await start(harness)

    expect(harness.kernel.panes.getSnapshot().some((pane) => pane.id === "pull-requests")).toBe(false)
    await addGithubRemote(harness)
    await refreshGit(harness)
    expect(harness.kernel.panes.getSnapshot()).toContainEqual(
      expect.objectContaining({ id: "pull-requests", title: "Pull Requests", state: "active" }),
    )
  }, 30_000)
})
