import { Effect, Schedule } from "effect"
import { GitError, type GitOutput } from "laziergit"

/**
 * Flags every invocation carries.
 *
 * - `--no-pager` — a pager would fight the renderer for the terminal.
 * - `core.quotepath=false` — without it every non-`-z` surface naming a path arrives as
 *   `"h\303\251llo"`, and something would have to unquote C strings.
 * - `color.ui=false` — a user with `color.ui=always` cannot tint anything we parse.
 * - the `diff.*` four — each rewrites the `--- a/`/`+++ b/` header the diff Pane reads a
 *   section's filename out of. Unpinned, a multi-file diff names every file "(unnamed)".
 *
 * An external differ cannot be pinned here: `-c diff.external=` does not override
 * `GIT_EXTERNAL_DIFF`, and `--no-ext-diff` is rejected by `status`, `add` and `commit`, so it
 * goes on the argvs that actually produce a patch.
 */
const baseFlags = [
  "--no-pager",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
] as const

/**
 * Reads suppress the optional index rewrite `git status` performs to persist its stat cache.
 * Without it the poll would rewrite the index every tick, contending for `index.lock` and
 * invalidating the fingerprint it compares against.
 */
const readFlags = ["--no-optional-locks"] as const

/**
 * `GIT_TERMINAL_PROMPT=0` turns a credential prompt nobody can answer — our stdio is piped —
 * into a fast failure whose stderr we can show. The `LC_*` trio forces byte-stable English,
 * which {@link isLockContention} depends on.
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
 * Matched bare and unanchored, so `index.lock` also catches a linked worktree's and a
 * submodule's. Safe only because {@link isLockContention} reads stderr alone.
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

/**
 * stderr only, where git reports lock contention: stdout is repository content, so a file
 * merely mentioning `index.lock` would otherwise burn the whole retry budget — before
 * `allowFailure` is consulted, so no caller could opt out.
 */
function isLockContention(output: GitOutput): boolean {
  if (output.exitCode === 0) return false
  return lockFragments.some((fragment) => output.stderr.includes(fragment))
}

function argv(args: readonly string[], write: boolean): readonly string[] {
  return write ? [...baseFlags, ...args] : [...baseFlags, ...readFlags, ...args]
}

/**
 * One attempt. Failure here means "worth retrying or reporting", never "git said no": a
 * nonzero exit succeeds carrying its exit code, and `allowFailure` decides what that means.
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

    // The AbortSignal above already terminates the child; this makes the kill part of
    // interruption rather than a race beside it.
    return Effect.sync(() => spawned.kill())
  })
}

/**
 * Runs git with explicit argv, never through a shell. Retries only lock contention; every
 * other nonzero exit is reported on the first attempt. Spawn failure — no `git` on PATH — is a
 * defect rather than a {@link GitError}: there is no exit code to report.
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
    // Exhausted retries leave the last locked output as the outcome, so the caller sees git's
    // own "Unable to create index.lock" rather than a synthetic message.
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
 * Runs git tolerating one nonzero exit as an empty result: `git config --get-regexp` exits 1
 * with no remotes and `git show-ref` exits 1 with no refs. An empty stderr is what separates
 * those from a real error.
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
