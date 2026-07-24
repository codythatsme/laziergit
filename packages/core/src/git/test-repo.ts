import { afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const created: string[] = []

/**
 * Repositories built for tests are pinned to a fixed identity and an empty global config,
 * so a developer's own `~/.gitconfig` — signing, default branch, hooks — can never change
 * what a test observes.
 */
const isolation: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
})

export interface TestRepo {
  readonly path: string
  /** Runs git in this repository and fails loudly, since a broken fixture is not a test result. */
  git(...args: readonly string[]): Promise<string>
  write(relativePath: string, contents: string): Promise<void>
  commit(message: string): Promise<void>
}

export function registerRepoCleanup(): void {
  afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })
}

async function run(cwd: string, args: readonly string[]): Promise<string> {
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
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
  return stdout
}

/** A temp directory holding a fresh repository with no commits yet. */
export async function createTestRepo(): Promise<TestRepo> {
  const path = await mkdtemp(join(tmpdir(), "laziergit-git-"))
  created.push(path)
  await run(path, ["-c", "init.defaultBranch=main", "init", "--quiet"])
  await run(path, ["config", "user.name", "Test"])
  await run(path, ["config", "user.email", "test@example.com"])
  await run(path, ["config", "core.autocrlf", "false"])

  const repo: TestRepo = {
    path,
    git: (...args) => run(path, args),
    write: (relativePath, contents) => writeFile(join(path, relativePath), contents),
    async commit(message) {
      await run(path, ["commit", "--quiet", "--message", message])
    },
  }
  return repo
}

/** The common starting point: one commit on `main`. */
export async function createSeededRepo(): Promise<TestRepo> {
  const repo = await createTestRepo()
  await repo.write("seed.txt", "seed\n")
  await repo.git("add", "seed.txt")
  await repo.commit("first commit")
  return repo
}

/** A bare repository standing in for a remote, wired up as `origin`. */
export async function addOrigin(repo: TestRepo): Promise<string> {
  const remote = await mkdtemp(join(tmpdir(), "laziergit-remote-"))
  created.push(remote)
  await run(remote, ["-c", "init.defaultBranch=main", "init", "--bare", "--quiet"])
  await repo.git("remote", "add", "origin", remote)
  await repo.git("push", "--quiet", "--set-upstream", "origin", "main")
  return remote
}
