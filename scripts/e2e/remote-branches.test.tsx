import { expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../../packages/core/src/git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  pressEscape,
  renderApp,
  waitFor,
  waitForFrame,
  type Harness,
} from "../../packages/core/src/test-harness"

installHarnessLifecycle()

const branchesExtension = resolve(import.meta.dir, "..", "..", "extensions", "branches")
const commitsExtension = resolve(import.meta.dir, "..", "..", "extensions", "commits")
const commitFlowExtension = resolve(import.meta.dir, "..", "..", "extensions", "commit-flow")
const remoteBranchesExtension = resolve(import.meta.dir, "..", "..", "extensions", "remote-branches")

const filesStub = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "files",
    activate(ctx) {
      ctx.panes.register({
        id: "files",
        title: "Files",
        component: () => <text content="files" />,
      })
    },
  })
`

const diffStub = `
  /** @jsxImportSource @opentui/react */
  import { createCell, defineExtension, useCommand } from "laziergit"

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      const target = createCell(null)

      function DiffPane() {
        const current = target.use()
        useCommand({
          id: "diff.mark-focused",
          title: "Mark diff focused",
          keys: "z",
          run: () => target.set({ kind: "focused", ref: "focused" }),
        })
        const ref = current === null ? "" : String(current.ref).slice(0, 7)
        return <text content={current === null ? "diff none" : "diff " + current.kind + " " + ref} />
      }

      ctx.panes.register({ id: "diff", title: "Diff", component: DiffPane })
      return { current: () => target.get(), show: (next) => target.set(next) }
    },
  })
`

/** Inside `act`, because a refresh landing mid-spawn is a React update. */
async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  let stdout = ""
  await act(async () => {
    const child = Bun.spawn(["git", ...args], {
      cwd: harness.directory,
      env: { ...process.env, ...gitIsolationEnv },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
    stdout = out.trim()
  })
  return stdout
}

async function seed(harness: Harness): Promise<void> {
  await writeFile(join(harness.directory, ".gitignore"), "bundled/\nglobal/\nrepo/\norigin.git/\n*.json\n*.jsonc\n")
  await writeFile(join(harness.directory, "work.txt"), "one\n")
  await git(harness, "add", ".gitignore", "work.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")
}

async function addOrigin(harness: Harness): Promise<void> {
  await git(harness, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", "origin.git")
  await git(harness, "remote", "add", "origin", join(harness.directory, "origin.git"))
}

async function commit(harness: Harness, contents: string, message: string): Promise<void> {
  await writeFile(join(harness.directory, "work.txt"), contents)
  await git(harness, "commit", "--quiet", "--all", "--message", message)
}

async function start(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    symlink(commitsExtension, join(harness.bundled, "commits")),
    symlink(commitFlowExtension, join(harness.bundled, "commit-flow")),
    symlink(remoteBranchesExtension, join(harness.bundled, "remote-branches")),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(
      harness.configFiles.repo,
      `{ "layout": { "columns": [["branches"], ["diff"]] }, "git": { "refreshIntervalMs": 60000 } }`,
    ),
  ])
  await renderApp(harness)
}

async function startNumberedLayout(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    symlink(commitsExtension, join(harness.bundled, "commits")),
    symlink(commitFlowExtension, join(harness.bundled, "commit-flow")),
    symlink(remoteBranchesExtension, join(harness.bundled, "remote-branches")),
    writeFile(join(harness.repo, "files.tsx"), filesStub),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(
      harness.configFiles.repo,
      `{ "layout": { "columns": [["files", "branches"], ["diff"]] }, "git": { "refreshIntervalMs": 60000 } }`,
    ),
  ])
  await renderApp(harness)
}

async function filterCurrentList(harness: Harness, query: string): Promise<void> {
  await press(harness, "/")
  await waitForFrame(harness, "Filter:")
  await press(harness, () => void harness.setup.mockInput.typeText(query))
  await waitForFrame(harness, `Filter: ${query}`)
  await press(harness, () => harness.setup.mockInput.pressEnter())
}

async function withRemoteOnlyBranch(harness: Harness): Promise<string> {
  await seed(harness)
  await addOrigin(harness)
  await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
  await git(harness, "checkout", "--quiet", "-b", "remote-only")
  await commit(harness, "remote\n", "remote work")
  const oid = await git(harness, "rev-parse", "HEAD")
  await git(harness, "push", "--quiet", "origin", "remote-only")
  await git(harness, "checkout", "--quiet", "main")
  await git(harness, "branch", "-D", "remote-only")
  return oid
}

it("keeps local and remote branches in pane 2 and cycles its tabs with 2 or brackets", async () => {
  const harness = await createHarness({ git: true })
  await seed(harness)
  await addOrigin(harness)
  await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")

  await startNumberedLayout(harness)
  await press(harness, "2")
  await waitForFrame(harness, "[Local branches] - Remote")

  await press(harness, "2")
  await waitForFrame(harness, "Local branches - [Remote]")

  await press(harness, "2")
  await waitForFrame(harness, "[Local branches] - Remote")

  await press(harness, "]")
  await waitForFrame(harness, "Local branches - [Remote]")
  await press(harness, "[")
  await waitForFrame(harness, "[Local branches] - Remote")

  await press(harness, "0")
  await press(harness, "z")
  await waitForFrame(harness, "diff focused focused")
}, 30_000)

it("supports the single-remote branch workflow", async () => {
  const harness = await createHarness({ git: true })
  const oid = await withRemoteOnlyBranch(harness)
  await git(harness, "--git-dir", join(harness.directory, "origin.git"), "update-ref", "refs/heads/custom-source", oid)
  await git(harness, "fetch", "--quiet", "origin")

  await start(harness)
  expect(frame(harness)).toContain("[Local branches] - Remote")

  await press(harness, "]")
  await waitForFrame(harness, "Local branches - [Remote]")
  expect(frame(harness)).toContain(" origin")
  expect(frame(harness)).toContain("remote-only")

  await filterCurrentList(harness, "remote-only")
  await press(harness, " ")
  // From the store, so the wait also covers the write's follow-up refresh.
  await waitFor(
    harness,
    () => {
      const head = harness.kernel.git.getSnapshot().head
      return head.kind === "onBranch" && head.branch === "remote-only"
    },
    "the tracking branch to be checked out",
  )
  expect(await git(harness, "rev-parse", "HEAD")).toBe(oid)
  expect(await git(harness, "config", "--get", "branch.remote-only.remote")).toBe("origin")
  expect(await git(harness, "config", "--get", "branch.remote-only.merge")).toBe("refs/heads/remote-only")

  await pressEscape(harness)
  await filterCurrentList(harness, "custom-source")
  await press(harness, "n")
  await waitForFrame(harness, "New local branch from origin/custom-source")
  await press(harness, () => void harness.setup.mockInput.typeText("-local"))
  await press(harness, () => harness.setup.mockInput.pressEnter())
  await waitFor(
    harness,
    () => {
      const head = harness.kernel.git.getSnapshot().head
      return head.kind === "onBranch" && head.branch === "custom-source-local"
    },
    "the custom tracking branch to be checked out",
  )
  expect(await git(harness, "config", "--get", "branch.custom-source-local.remote")).toBe("origin")
  expect(await git(harness, "config", "--get", "branch.custom-source-local.merge")).toBe("refs/heads/custom-source")

  await pressEscape(harness)
  await filterCurrentList(harness, "remote-only")
  await press(harness, "u")
  await waitForFrame(harness, "Set upstream for custom-source-local?")
  expect(frame(harness)).toContain("custom-source-local will track origin/remote-only")
  await press(harness, "y")
  await waitFor(
    harness,
    () =>
      harness.kernel.git
        .getSnapshot()
        .branches.some((branch) => branch.name === "custom-source-local" && branch.upstream?.branch === "remote-only"),
    "the selected remote branch to become the current branch's upstream",
  )
  expect(await git(harness, "config", "--get", "branch.custom-source-local.merge")).toBe("refs/heads/remote-only")

  await git(harness, "--git-dir", join(harness.directory, "origin.git"), "update-ref", "refs/heads/new-remote", oid)
  await press(harness, "f")
  await waitFor(
    harness,
    () =>
      harness.kernel.git
        .getSnapshot()
        .remoteBranches.some((branch) => branch.remote === "origin" && branch.name === "new-remote"),
    "fetch to refresh the remote branch list",
  )
  await pressEscape(harness)
  await waitForFrame(harness, "new-remote")

  await filterCurrentList(harness, "new-remote")
  await press(harness, "d")
  await waitForFrame(harness, "Delete origin/new-remote?")
  expect(frame(harness)).toContain("Any local branch is kept")
  await press(harness, "y")
  await waitFor(
    harness,
    () =>
      !harness.kernel.git
        .getSnapshot()
        .remoteBranches.some((branch) => branch.remote === "origin" && branch.name === "new-remote"),
    "the remote branch to be deleted",
  )
  expect(await git(harness, "ls-remote", "--heads", "origin", "refs/heads/new-remote")).toBe("")

  await pressEscape(harness)
  await filterCurrentList(harness, "remote-only")
  expect(harness.kernel.popups.top).toBeUndefined()
  await press(harness, "h")
  await waitFor(
    harness,
    () => harness.kernel.git.getSnapshot().head.kind === "detached",
    "HEAD to detach at the remote branch",
  )
  expect(harness.kernel.popups.top).toBeUndefined()
  expect(await git(harness, "rev-parse", "HEAD")).toBe(oid)
}, 30_000)

it("requires choosing a remote when more than one is configured", async () => {
  const harness = await createHarness({ git: true })
  await seed(harness)
  await addOrigin(harness)
  await git(harness, "push", "--quiet", "--set-upstream", "origin", "main")
  await git(harness, "remote", "add", "upstream", join(harness.directory, "origin.git"))
  await git(harness, "fetch", "--quiet", "upstream")

  await start(harness)
  await press(harness, "]")
  await waitForFrame(harness, "1 branch")

  const picker = frame(harness)
  expect(picker).toContain("origin")
  expect(picker).toContain("upstream")

  await press(harness, "j")
  await press(harness, " ")
  // The picker leaving is what says the choice landed, not the names, which it also shows.
  await waitForFrame(harness, (screen) => !screen.includes("1 branch") && screen.includes(" upstream"))
  expect(frame(harness)).toContain("main")

  await pressEscape(harness)
  await waitForFrame(harness, "1 branch")
  expect(frame(harness)).toContain("origin")
  expect(frame(harness)).toContain("upstream")
}, 30_000)
