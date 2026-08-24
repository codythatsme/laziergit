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
const originalSetInterval = globalThis.setInterval

afterEach(() => {
  process.env.PATH = originalPath
  globalThis.setInterval = originalSetInterval
})

const branchesSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "branches",
    activate(ctx) {
      const pane = ctx.panes.register({
        id: "branches",
        title: "Local",
        component: () => <text content="local branches" />,
      })
      ctx.commands.register({ id: "branches.focus", title: "Focus local branches", run: () => pane.focus() })
    },
  })
`

interface GhStub {
  setPullRequests(pullRequests: readonly unknown[]): Promise<void>
  fail(message: string): Promise<void>
  warn(message: string): Promise<void>
  failCheckout(message: string): Promise<void>
  calls(): Promise<readonly string[]>
}

async function installGh(harness: Harness): Promise<GhStub> {
  const bin = join(harness.directory, "bin")
  const response = join(bin, "response.json")
  const failure = join(bin, "failure.txt")
  const warning = join(bin, "warning.txt")
  const checkoutFailure = join(bin, "checkout-failure.txt")
  const log = join(bin, "gh.log")
  await mkdir(bin, { recursive: true })

  const gh = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    'if [ "$1 $2" = "api graphql" ]; then',
    `  if [ -f "${failure}" ]; then cat "${failure}" >&2; exit 1; fi`,
    `  cat "${response}"`,
    `  if [ -f "${warning}" ]; then cat "${warning}" >&2; exit 1; fi`,
    "  exit 0",
    "fi",
    'if [ "$1 $2" = "pr checkout" ]; then',
    `  if [ -f "${checkoutFailure}" ]; then`,
    "    git checkout --quiet feature/new",
    `    cat "${checkoutFailure}" >&2`,
    "    exit 1",
    "  fi",
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
    warn: (message) => writeFile(warning, message),
    failCheckout: (message) => writeFile(checkoutFailure, message),
    calls: async () => ((await Bun.file(log).exists()) ? (await Bun.file(log).text()).trim().split("\n") : []),
  }
}

function queryResponse(pullRequests: readonly unknown[]) {
  return {
    data: {
      viewer: {
        login: "claudia",
        pullRequests: { nodes: pullRequests, pageInfo: { hasNextPage: false, endCursor: null } },
      },
      repository: { nameWithOwner: "base/project" },
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
    baseRepository: { nameWithOwner: "base/project" },
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
      pullRequest(12, "Another repository", {
        updatedAt: "2026-08-24T11:00:00Z",
        baseRepository: { nameWithOwner: "elsewhere/project" },
      }),
      pullRequest(11, "Draft pull request", {
        headRefName: "feature/draft",
        isDraft: true,
        updatedAt: "2026-08-24T10:00:00Z",
      }),
    ])
    await start(harness)
    // An absence assertion must outlast startup reconciliation to prove the hidden tab stays lazy.
    // eslint-disable-next-line no-restricted-properties
    await Bun.sleep(500)
    expect(await gh.calls()).toEqual([])
    await runCommand(harness, "pull-requests.focus")

    await waitForFrame(harness, "Draft pull request")
    const listed = frame(harness)
    expect(listed).toContain("D #11 Draft pull request")
    expect(listed).toContain("feature/draft")
    expect(listed).toContain("#10 Older pull request")
    expect(listed).toContain("feature/10")
    expect(listed).not.toContain("Another repository")
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

  it("restores the original branch when gh switches to a divergent pull request branch and fails", async () => {
    const { harness, gh } = await pullRequestsHarness()
    await git(harness, "checkout", "--quiet", "-b", "feature/new")
    await writeFile(join(harness.directory, "feature.txt"), "feature\n")
    await git(harness, "add", "feature.txt")
    await git(harness, "commit", "--quiet", "--message", "feature")
    await git(harness, "checkout", "--quiet", "main")
    await writeFile(join(harness.directory, "main.txt"), "main\n")
    await git(harness, "add", "main.txt")
    await git(harness, "commit", "--quiet", "--message", "main")
    await gh.setPullRequests([pullRequest(42, "Divergent pull request", { headRefName: "feature/new" })])
    await gh.failCheckout("fatal: feature/new cannot be fast-forwarded")
    await start(harness)
    await runCommand(harness, "pull-requests.focus")
    await waitForFrame(harness, "Divergent pull request")

    await press(harness, " ")
    await waitForFrame(harness, "fatal: feature/new cannot be fast-forwarded")
    expect(await git(harness, "branch", "--show-current")).toBe("main")
    expect(await git(harness, "status", "--porcelain")).toBe("")
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

  it("uses complete query data when gh also reports an unrelated GraphQL error", async () => {
    const { harness, gh } = await pullRequestsHarness()
    await gh.setPullRequests([pullRequest(8, "Accessible pull request")])
    await gh.warn("Resource protected by organization SAML enforcement")
    await start(harness)
    await runCommand(harness, "pull-requests.focus")

    await waitForFrame(harness, "Accessible pull request")
    expect(frame(harness)).not.toContain("SAML enforcement")
  }, 30_000)

  it("polls while visible and stops polling when another tab is shown", async () => {
    globalThis.setInterval = ((handler: () => void, delay?: number) =>
      originalSetInterval(handler, delay === 60_000 ? 25 : delay)) as typeof setInterval
    const { harness, gh } = await pullRequestsHarness()
    await gh.setPullRequests([pullRequest(7, "Polling pull request")])
    await start(harness)
    await runCommand(harness, "pull-requests.focus")
    await waitFor(harness, async () => (await gh.calls()).length >= 2, "a visible-tab poll")

    await runCommand(harness, "branches.focus")
    await waitForFrame(harness, "local branches")
    const callsWhileVisible = (await gh.calls()).length
    // Elapsed time is the subject: several accelerated poll ticks must pass after unmount.
    // eslint-disable-next-line no-restricted-properties
    await Bun.sleep(100)
    expect(await gh.calls()).toHaveLength(callsWhileVisible)
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
