import { realpath } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * A repository laziergit can serve, identified by its root. The root comes from git itself
 * rather than from looking for a `.git` directory, which may be a *file* in a linked worktree
 * or a submodule.
 */
export interface Repository {
  readonly root: string
  /** Absolute per-worktree Git directory; distinct for linked worktrees. */
  readonly gitDir: string
}

const revParseArgs = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir"] as const

interface RevParseOutput {
  readonly stdout: string
  readonly exitCode: number
}

async function revParse(cwd: string, env: Record<string, string>): Promise<RevParseOutput> {
  const child = Bun.spawn(["git", ...revParseArgs], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  // Drained so a failing probe cannot leave a full pipe behind.
  void new Response(child.stderr).text()
  return { stdout, exitCode }
}

function readRepository(output: RevParseOutput): Repository | null {
  if (output.exitCode !== 0) return null
  const [root, gitDir] = output.stdout.split("\n")
  return root && gitDir ? { root, gitDir } : null
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  if (left === right) return true
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch {
    return false
  }
}

/**
 * Finds the repository containing `cwd`, walking up as plain `git` does — which is what
 * makes `laziergit` work from a subdirectory. Returns null outside a repository.
 */
export async function discoverRepository(cwd: string): Promise<Repository | null> {
  try {
    return readRepository(await revParse(cwd, {}))
  } catch {
    // A missing or unrunnable `git` is indistinguishable here from "no repository": both mean
    // the git service has nothing to serve.
    return null
  }
}

/**
 * Opens `root` as a repository, refusing to accept an *enclosing* one: `git` normally searches
 * upward, so a directory merely sitting inside a checkout would silently bind to it.
 * `GIT_CEILING_DIRECTORIES` stops the walk, and the toplevel is re-checked because the ceiling
 * does not apply to symlinked paths.
 */
export async function openRepository(root: string): Promise<Repository | null> {
  try {
    const repository = readRepository(await revParse(root, { GIT_CEILING_DIRECTORIES: dirname(root) }))
    if (!repository) return null
    return (await sameDirectory(repository.root, root)) ? repository : null
  } catch {
    return null
  }
}
