import { Effect, Schedule } from "effect"
import { GitError, type GitOutput } from "laziergit"

/**
 * Flags every invocation carries.
 *
 * - `--no-pager` — git execs a pager when it believes stdout is a terminal; we own the
 *   terminal, so a pager would fight the renderer for it.
 * - `core.quotepath=false` — `-z` already defeats path quoting, but every non-`-z`
 *   surface (diff headers, error text naming a path) would otherwise arrive as
 *   `"h\303\251llo"`. Setting it once means no C-string unquoter is ever needed.
 * - `color.ui=false` — a user with `color.ui=always` cannot tint anything we parse.
 */
const baseFlags = ["--no-pager", "-c", "core.quotepath=false", "-c", "color.ui=false"] as const

/**
 * Reads additionally suppress the *optional* index rewrite `git status` performs to
 * persist its refreshed stat cache. Without this the ~2s poll would rewrite the index
 * on every tick — contending for `index.lock` with the user's own terminal, and
 * invalidating the very fingerprint the poll compares against.
 */
const readFlags = ["--no-optional-locks"] as const

/**
 * `GIT_TERMINAL_PROMPT=0` is the one that matters: a `fetch` against a remote wanting
 * credentials would otherwise block forever on a prompt nobody can answer, because our
 * stdio is piped and the terminal belongs to the renderer. It becomes a fast failure
 * whose stderr we can show instead.
 *
 * The `LC_*` trio forces byte-stable English. That is not cosmetic — {@link isLockContention}
 * matches `cannot lock ref`, which git translates.
 */
const baseEnv: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  LANG: "C",
  LC_MESSAGES: "C",
})

const readEnv: Readonly<Record<string, string>> = Object.freeze({ ...baseEnv, GIT_OPTIONAL_LOCKS: "0" })

/** lazygit's numbers (`pkg/commands/git_cmd_obj_runner.go`): 20ms doubling, 7 attempts, ~1.26s total. */
const initialRetryDelay = "20 millis"
const retryFactor = 2
const maxRetries = 6

/**
 * Both fragments are matched bare and unanchored, deliberately: `index.lock` alone also
 * catches a linked worktree's and a submodule's lock file, which a fuller path would miss.
 */
const lockFragments = ["index.lock", "cannot lock ref"] as const

export interface GitExecOptions {
  readonly stdin?: string
  /** Reads suppress optional locks and never take one; writes must not. */
  readonly write?: boolean
}

/** A git invocation that never ran, as opposed to one that ran and failed. */
export class GitSpawnError extends Error {
  readonly args: readonly string[]

  constructor(args: readonly string[], cause: unknown) {
    super(`Unable to run git: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "GitSpawnError"
    this.args = args
  }
}

type ExecFailure =
  | { readonly kind: "spawn"; readonly error: GitSpawnError }
  | { readonly kind: "locked"; readonly output: GitOutput }

function isLockContention(output: GitOutput): boolean {
  if (output.exitCode === 0) return false
  const text = `${output.stdout}\n${output.stderr}`
  return lockFragments.some((fragment) => text.includes(fragment))
}

function argv(args: readonly string[], write: boolean): readonly string[] {
  return write ? [...baseFlags, ...args] : [...baseFlags, ...readFlags, ...args]
}

/**
 * One attempt. Failure here means "worth retrying or reporting", never "git said no":
 * a nonzero exit is an ordinary success that carries its exit code, because whether it
 * is an error at all is the caller's decision (`allowFailure`).
 */
function attempt(cwd: string, args: readonly string[], options: GitExecOptions): Effect.Effect<GitOutput, ExecFailure> {
  return Effect.callback<GitOutput, ExecFailure>((resume, signal) => {
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">
    try {
      child = Bun.spawn(["git", ...argv(args, options.write ?? false)], {
        cwd,
        env: { ...process.env, ...(options.write === true ? baseEnv : readEnv) },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal,
      })
    } catch (error) {
      resume(Effect.fail({ kind: "spawn", error: new GitSpawnError(args, error) }))
      return
    }

    const spawned = child
    if (options.stdin !== undefined) spawned.stdin.write(options.stdin)
    void spawned.stdin.end()

    void Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text(), spawned.exited]).then(
      ([stdout, stderr, exitCode]) => {
        const output: GitOutput = { stdout, stderr, exitCode }
        resume(isLockContention(output) ? Effect.fail({ kind: "locked", output }) : Effect.succeed(output))
      },
      (error: unknown) => {
        resume(Effect.fail({ kind: "spawn", error: new GitSpawnError(args, error) }))
      },
    )

    // Runs when the fiber is interrupted. The AbortSignal above already terminates the
    // child; this makes the kill part of interruption rather than a race beside it.
    return Effect.sync(() => spawned.kill())
  })
}

/**
 * Runs git with explicit argv — never through a shell, so no input can ever be parsed
 * as shell syntax. Retries only lock contention, and only for as long as lazygit does;
 * every other nonzero exit is reported on the first attempt.
 *
 * Resolves with the {@link GitOutput} whatever the exit code when `allowFailure`, and
 * fails with {@link GitError} otherwise. Spawn failure (no `git` on PATH) is a defect,
 * not a {@link GitError}: there is no exit code to report and no retry that would help.
 */
export function execGit(
  cwd: string,
  args: readonly string[],
  options: GitExecOptions & { readonly allowFailure?: boolean } = {},
): Effect.Effect<GitOutput, GitError> {
  const retried = Effect.retry(attempt(cwd, args, options), {
    schedule: Schedule.exponential(initialRetryDelay, retryFactor),
    times: maxRetries,
    while: (failure: ExecFailure) => failure.kind === "locked",
  })

  return Effect.flatMap(
    // Exhausting the retries leaves the last locked output as the outcome: the caller
    // then sees git's real "Unable to create index.lock" message instead of a synthetic one.
    Effect.catch(retried, (failure: ExecFailure) =>
      failure.kind === "locked" ? Effect.succeed(failure.output) : Effect.die(failure.error),
    ),
    (output) =>
      output.exitCode === 0 || options.allowFailure === true
        ? Effect.succeed(output)
        : Effect.fail(new GitError(args, output)),
  )
}

/**
 * Runs git tolerating one specific nonzero exit as an empty result. `git config
 * --get-regexp` exits 1 on a repository with no remotes, and `git show-ref` exits 1 on
 * one with no refs — both are "nothing to report", not failures, and both are
 * distinguished from a real error by an empty stderr.
 */
export function execGitAllowingEmpty(
  cwd: string,
  args: readonly string[],
  emptyExitCode: number,
  options: GitExecOptions = {},
): Effect.Effect<GitOutput, GitError> {
  return Effect.flatMap(execGit(cwd, args, { ...options, allowFailure: true }), (output) => {
    if (output.exitCode === 0) return Effect.succeed(output)
    if (output.exitCode === emptyExitCode && output.stderr.trim().length === 0) {
      return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })
    }
    return Effect.fail(new GitError(args, output))
  })
}
