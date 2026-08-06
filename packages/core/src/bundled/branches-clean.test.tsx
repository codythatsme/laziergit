import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  renderApp,
  runCommand,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

const branchesExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "branches")

const commitsStub = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "commits",
    activate() {
      return { renderBrowser: () => null }
    },
  })
`

const diffStub = `
  /** @jsxImportSource @opentui/react */
  import { createCell, defineExtension } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      const target = createCell(null)

      function DiffPane() {
        const current = target.use()
        return <text content={current === null ? "diff none" : "diff " + current.kind} />
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

async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".gitignore"), "bundled/\nglobal/\nrepo/\norigin.git/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "work.txt"), "one\n")
  await git(harness, "add", ".gitignore", "work.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")
}

async function commit(harness: Harness, contents: string, message: string): Promise<void> {
  await writeFile(join(harness.directory, "work.txt"), contents)
  await git(harness, "commit", "--quiet", "--all", "--message", message)
}

async function withDeletedRemoteBranch(harness: Harness, name: string): Promise<string> {
  await seed(harness)
  await git(harness, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", "origin.git")
  await git(
    harness,
    "config",
    `url.${join(harness.directory, "origin.git")}.insteadOf`,
    "git@github.com:acme/tools.git",
  )
  await git(harness, "remote", "add", "origin", "git@github.com:acme/tools.git")
  await git(harness, "remote", "set-url", "--push", "origin", join(harness.directory, "origin.git"))
  await git(harness, "checkout", "--quiet", "-b", name)
  await commit(harness, `${name}\n`, `${name} work`)
  const oid = await git(harness, "rev-parse", name)
  await git(harness, "push", "--quiet", "--set-upstream", "origin", name)
  await git(harness, "checkout", "--quiet", "main")
  await git(harness, "push", "--quiet", "--delete", "origin", name)
  return oid
}

interface GhStub {
  setPullRequests(pullRequests: readonly unknown[]): Promise<void>
  calls(): Promise<readonly string[]>
}

async function installGh(harness: Harness): Promise<GhStub> {
  const bin = join(harness.directory, "bin")
  const answers = join(bin, "pull-requests.json")
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
          `type "${answers}"`,
          "exit /b 0",
          ":api_graphql",
          `type "${answers}"`,
          "exit /b 0",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> "${calls}"`,
          'if [ "$1 $2" = "pr list" ] || [ "$1 $2" = "api graphql" ]; then',
          `  exec cat "${answers}"`,
          "fi",
          "exit 1",
          "",
        ].join("\n")
  const executable = join(bin, process.platform === "win32" ? "gh.cmd" : "gh")
  await Promise.all([writeFile(executable, gh, { mode: 0o755 }), writeFile(answers, "[]")])
  process.env.PATH = `${bin}${delimiter}${originalPath}`

  return {
    setPullRequests: (pullRequests) =>
      writeFile(answers, JSON.stringify({ data: { repository: { branch0: { nodes: pullRequests } } } })),
    calls: async () => ((await Bun.file(calls).exists()) ? (await Bun.file(calls).text()).trim().split("\n") : []),
  }
}

async function start(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    writeFile(join(harness.repo, "commits.ts"), commitsStub),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(
      harness.configFiles.repo,
      `{ "layout": { "columns": [["branches"], ["diff"]] }, "git": { "refreshIntervalMs": 60000 } }`,
    ),
  ])
  await renderApp(harness)
  await runCommand(harness, "branches.focus")
}

describe("cleaning merged branches", () => {
  it("confirms the exact merged-head branches, respects decline, then deletes them", async () => {
    const harness = await createHarness({ git: true })
    const oid = await withDeletedRemoteBranch(harness, "finished")
    const gh = await installGh(harness)
    await gh.setPullRequests([
      {
        headRefName: "finished",
        headRefOid: oid,
        headRepositoryOwner: { login: "acme" },
        state: "MERGED",
        isDraft: false,
        url: "https://github.com/acme/tools/pull/42",
        createdAt: "2026-08-04T00:00:00Z",
      },
    ])
    await start(harness)

    expect(harness.kernel.commands.getSnapshot().find((command) => command.id === "branches.clean")?.title).toBe(
      "Clean branches",
    )
    await press(harness, () => void harness.kernel.commands.execute("branches.clean"))
    await waitForFrame(harness, "Delete 1 local branch?")
    expect(frame(harness)).toContain("Permanently delete the following local branch")
    expect(frame(harness)).toContain("finished")
    expect(frame(harness)).toContain("merged pull request has the")
    expect(frame(harness)).toContain("same head commit")

    await press(harness, "n")
    await waitForFrame(harness, (screen) => !screen.includes("Delete 1 local branch?"))
    expect(await git(harness, "branch", "--list", "finished", "--format=%(refname:short)")).toBe("finished")

    await press(harness, () => void harness.kernel.commands.execute("branches.clean"))
    await waitForFrame(harness, "Delete 1 local branch?")
    await press(harness, "y")
    await waitForFrame(harness, "Deleted local branch finished")
    expect(await git(harness, "branch", "--list", "finished", "--format=%(refname:short)")).toBe("")
    expect((await gh.calls()).some((call) => call.includes("states: [MERGED]") && call.includes("headRefOid"))).toBe(
      true,
    )
  }, 30_000)
})
