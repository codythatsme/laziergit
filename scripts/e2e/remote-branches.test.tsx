import { expect, it } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../../packages/core/src/git/test-repo"
import {
  createHarness,
  frame,
  installHarnessLifecycle,
  renderApp,
  settle,
  type Harness,
} from "../../packages/core/src/test-harness"

installHarnessLifecycle()

const branchesExtension = resolve(import.meta.dir, "..", "..", "extensions", "branches")
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

async function addOrigin(harness: Harness): Promise<void> {
  await git(harness, "-c", "init.defaultBranch=main", "init", "--bare", "--quiet", "origin.git")
  await git(harness, "remote", "add", "origin", join(harness.directory, "origin.git"))
}

async function commit(harness: Harness, contents: string, message: string): Promise<void> {
  await writeFile(join(harness.directory, "work.txt"), contents)
  await git(harness, "commit", "--quiet", "--all", "--message", message)
}

async function press(harness: Harness, action: () => void): Promise<void> {
  await act(async () => {
    action()
    await Bun.sleep(60)
  })
  await settle(harness)
}

async function start(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    symlink(remoteBranchesExtension, join(harness.bundled, "remote-branches")),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(harness.configFiles.repo, `{ "layout": { "columns": [["branches"], ["diff"]] } }`),
  ])
  await renderApp(harness)
}

async function startNumberedLayout(harness: Harness): Promise<void> {
  await Promise.all([
    symlink(branchesExtension, join(harness.bundled, "branches")),
    symlink(remoteBranchesExtension, join(harness.bundled, "remote-branches")),
    writeFile(join(harness.repo, "files.tsx"), filesStub),
    writeFile(join(harness.repo, "diff.tsx"), diffStub),
    writeFile(harness.configFiles.repo, `{ "layout": { "columns": [["files", "branches"], ["diff"]] } }`),
  ])
  await renderApp(harness)
}

async function waitUntil(
  harness: Harness,
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await settle(harness)
    let met = false
    await act(async () => {
      met = await condition()
    })
    if (met) return
    await act(async () => {
      await Bun.sleep(30)
    })
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame(harness)}`)
}

async function filterCurrentList(harness: Harness, query: string): Promise<void> {
  await press(harness, () => harness.setup.mockInput.pressKey("/"))
  await act(async () => {
    await harness.setup.mockInput.typeText(query)
    await Bun.sleep(60)
  })
  await settle(harness)
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
  await press(harness, () => harness.setup.mockInput.pressKey("2"))
  expect(frame(harness)).toContain("[Local branches] - Remote")

  await press(harness, () => harness.setup.mockInput.pressKey("2"))
  expect(frame(harness)).toContain("Local branches - [Remote]")

  await press(harness, () => harness.setup.mockInput.pressKey("2"))
  expect(frame(harness)).toContain("[Local branches] - Remote")

  await press(harness, () => harness.setup.mockInput.pressKey("]"))
  expect(frame(harness)).toContain("Local branches - [Remote]")
  await press(harness, () => harness.setup.mockInput.pressKey("["))
  expect(frame(harness)).toContain("[Local branches] - Remote")

  await press(harness, () => harness.setup.mockInput.pressKey("3"))
  await press(harness, () => harness.setup.mockInput.pressKey("z"))
  expect(frame(harness)).toContain("diff focused focused")
}, 30_000)

it("supports the single-remote branch workflow", async () => {
  const harness = await createHarness({ git: true })
  const oid = await withRemoteOnlyBranch(harness)
  await git(harness, "--git-dir", join(harness.directory, "origin.git"), "update-ref", "refs/heads/custom-source", oid)
  await git(harness, "fetch", "--quiet", "origin")

  await start(harness)
  expect(frame(harness)).toContain("[Local branches] - Remote")

  await press(harness, () => harness.setup.mockInput.pressKey("]"))
  expect(frame(harness)).toContain("Local branches - [Remote]")
  expect(frame(harness)).toContain(" origin")
  expect(frame(harness)).toContain("remote-only")

  await filterCurrentList(harness, "remote-only")
  await press(harness, () => harness.setup.mockInput.pressKey(" "))
  await waitUntil(
    harness,
    async () => (await git(harness, "rev-parse", "--abbrev-ref", "HEAD")) === "remote-only",
    "the tracking branch to be checked out",
  )
  expect(await git(harness, "rev-parse", "HEAD")).toBe(oid)
  expect(await git(harness, "config", "--get", "branch.remote-only.remote")).toBe("origin")
  expect(await git(harness, "config", "--get", "branch.remote-only.merge")).toBe("refs/heads/remote-only")

  await press(harness, () => harness.setup.mockInput.pressEscape())
  await filterCurrentList(harness, "custom-source")
  await press(harness, () => harness.setup.mockInput.pressKey("n"))
  expect(frame(harness)).toContain("New local branch from origin/custom-source")
  await press(harness, () => void harness.setup.mockInput.typeText("-local"))
  await press(harness, () => harness.setup.mockInput.pressEnter())
  await waitUntil(
    harness,
    async () => (await git(harness, "rev-parse", "--abbrev-ref", "HEAD")) === "custom-source-local",
    "the custom tracking branch to be checked out",
  )
  expect(await git(harness, "config", "--get", "branch.custom-source-local.remote")).toBe("origin")
  expect(await git(harness, "config", "--get", "branch.custom-source-local.merge")).toBe("refs/heads/custom-source")

  await press(harness, () => harness.setup.mockInput.pressEscape())
  await filterCurrentList(harness, "remote-only")
  await press(harness, () => harness.setup.mockInput.pressKey("u"))
  expect(frame(harness)).toContain("Set upstream for custom-source-local?")
  expect(frame(harness)).toContain("custom-source-local will track origin/remote-only")
  await press(harness, () => harness.setup.mockInput.pressKey("y"))
  await waitUntil(
    harness,
    async () =>
      (await git(harness, "config", "--get", "branch.custom-source-local.merge")) === "refs/heads/remote-only",
    "the selected remote branch to become the current branch's upstream",
  )

  await git(harness, "--git-dir", join(harness.directory, "origin.git"), "update-ref", "refs/heads/new-remote", oid)
  await press(harness, () => harness.setup.mockInput.pressKey("f"))
  await waitUntil(
    harness,
    async () =>
      harness.kernel.git
        .getSnapshot()
        .remoteBranches.some((branch) => branch.remote === "origin" && branch.name === "new-remote"),
    "fetch to refresh the remote branch list",
  )
  await press(harness, () => harness.setup.mockInput.pressEscape())
  expect(frame(harness)).toContain("new-remote")

  await filterCurrentList(harness, "new-remote")
  await press(harness, () => harness.setup.mockInput.pressKey("x"))
  expect(frame(harness)).toContain("Delete from remote")
  await press(harness, () => harness.setup.mockInput.pressKey("d"))
  expect(frame(harness)).toContain("Delete origin/new-remote?")
  expect(frame(harness)).toContain("Any local branch is kept")
  await press(harness, () => harness.setup.mockInput.pressKey("y"))
  await waitUntil(
    harness,
    async () =>
      (await git(harness, "ls-remote", "--heads", "origin", "refs/heads/new-remote")) === "" &&
      !harness.kernel.git
        .getSnapshot()
        .remoteBranches.some((branch) => branch.remote === "origin" && branch.name === "new-remote"),
    "the remote branch to be deleted",
  )

  await press(harness, () => harness.setup.mockInput.pressEscape())
  await filterCurrentList(harness, "remote-only")
  await press(harness, () => harness.setup.mockInput.pressKey("x"))
  expect(frame(harness)).toContain("Remote branch: origin/remote-only")
  expect(frame(harness)).toContain("Check out as detached HEAD")
  await press(harness, () => harness.setup.mockInput.pressKey("h"))
  await waitUntil(
    harness,
    async () => (await git(harness, "rev-parse", "--abbrev-ref", "HEAD")) === "HEAD",
    "HEAD to detach at the remote branch",
  )
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
  await press(harness, () => harness.setup.mockInput.pressKey("]"))

  const picker = frame(harness)
  expect(picker).toContain("origin")
  expect(picker).toContain("upstream")
  expect(picker).toContain("1 branch")

  await press(harness, () => harness.setup.mockInput.pressKey("j"))
  await press(harness, () => harness.setup.mockInput.pressKey(" "))
  expect(frame(harness)).toContain(" upstream")
  expect(frame(harness)).toContain("main")

  await press(harness, () => harness.setup.mockInput.pressEscape())
  expect(frame(harness)).toContain("origin")
  expect(frame(harness)).toContain("upstream")
  expect(frame(harness)).toContain("1 branch")
}, 30_000)
