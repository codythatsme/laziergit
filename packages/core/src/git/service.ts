import { Effect, Queue, Stream } from "effect"
import {
  GitError,
  isUntracked,
  literalPathspec,
  type Disposable,
  type GitOutput,
  type GitState,
  type RawOptions,
} from "laziergit"

import type { GitConfig } from "../config/config"
import { GitActivityStore, labelFor } from "./activity"
import { execGit, execGitAllowingEmpty } from "./exec"
import {
  branchArgs,
  commitArgs,
  parseBranches,
  parseCommits,
  parseHeadRef,
  parseRemotes,
  parseStash,
  parseStatus,
  parseTags,
  readHead,
  refSnapshotArgs,
  configArgs,
  stashArgs,
  statusArgs,
  symbolicRefArgs,
  tagArgs,
} from "./parse"
import { openRepository, type Repository } from "./repository"
import { GitStore } from "./store"

/**
 * Subcommands that are read-only whatever their arguments. Anything outside this set is
 * assumed to mutate and refreshes after: a wasted refresh costs a duplicate read, a missed one
 * leaves the screen disagreeing with the repository. `config` and `symbolic-ref` are absent
 * because they read *or* write depending on their arguments.
 */
const readOnlySubcommands: ReadonlySet<string> = new Set([
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-ref-format",
  "count-objects",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "var",
  "verify-commit",
  "verify-tag",
  "whatchanged",
])

export interface GitServiceOptions {
  /** The directory to open as a repository. Must be the repository root, not a child of one. */
  readonly repoRoot: string
  readonly config: GitConfig
  readonly report: (message: string, error?: unknown) => void
}

/** Read-only only in combination — `git stash list` against every other `git stash` verb. */
const readOnlySubcommandPairs: ReadonlySet<string> = new Set([
  "bisect log",
  "notes list",
  "notes show",
  "reflog show",
  "remote get-url",
  "stash list",
  "stash show",
  "submodule status",
  "worktree list",
])

/** Global options that consume the argument after them, which is therefore not the subcommand. */
const valueTakingGlobals: ReadonlySet<string> = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
])

function subcommandOf(args: readonly string[]): { readonly name: string; readonly operand: string | undefined } | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) break
    if (arg.startsWith("-")) {
      // Without this, `-c core.editor=x log` reads `core.editor=x` as the subcommand.
      if (valueTakingGlobals.has(arg)) index += 1
      continue
    }
    return { name: arg, operand: args[index + 1] }
  }
  return null
}

function isMutating(args: readonly string[]): boolean {
  const subcommand = subcommandOf(args)
  // Argv with no subcommand at all is nothing we can reason about; assume the worst.
  if (subcommand === null) return true
  if (readOnlySubcommands.has(subcommand.name)) return false
  const operand = subcommand.operand
  return operand === undefined || !readOnlySubcommandPairs.has(`${subcommand.name} ${operand}`)
}

/**
 * What the poll compares. Four reads, because each catches what the others cannot: `status`
 * for working-tree edits, which move nothing under `.git`; `refs` for commits, checkouts and
 * fetches; `stash`, because dropping any entry but the top one rewrites only the stash reflog
 * and leaves `refs/stash` identical; `config` for a new remote or upstream.
 */
function fingerprintOf(status: string, refs: string, stash: string, config: string): string {
  return [status, refs, stash, config].join("\u0000\u0000")
}

/**
 * All git access, and the only writer of the {@link GitStore}. Effect owns the I/O —
 * child-process lifetime, lock retry, the concurrent fan-out of a refresh — while the store,
 * coalescing and polling stay plain TypeScript (ADR-0002).
 */
export class GitService {
  readonly store: GitStore
  /**
   * What git is doing right now, written at the one choke point every write passes through so
   * no Extension has to report its own progress. Reads are absent: the diff Pane runs one on
   * every cursor move.
   */
  readonly activity: GitActivityStore
  readonly #repoRoot: string
  readonly #report: (message: string, error?: unknown) => void
  readonly #inflight = new Set<Promise<unknown>>()
  #config: GitConfig
  #repository: Repository | null = null
  #opened: Promise<void> | undefined
  #refreshing: Promise<void> | undefined
  #queued: PromiseWithResolvers<void> | undefined
  #fingerprint: string | undefined
  #pollTimer: ReturnType<typeof setInterval> | undefined
  #polling = false
  #stopped = false

  constructor(options: GitServiceOptions) {
    this.#repoRoot = options.repoRoot
    this.#config = options.config
    this.#report = options.report
    this.store = new GitStore((error) => options.report("store listener", error))
    this.activity = new GitActivityStore((error) => options.report("activity listener", error))
  }

  /** Absolute repository root. Constant for the session, and the cwd every child inherits. */
  get root(): string {
    return this.#repository?.root ?? this.#repoRoot
  }

  /** False outside a repository, where the store serves the empty snapshot and writes reject. */
  get available(): boolean {
    return this.#repository !== null
  }

  getSnapshot = (): GitState => this.store.getSnapshot()

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  subscribeSelector<T>(selector: (state: GitState) => T, onChange: (value: T, previous: T) => void): Disposable {
    return this.store.subscribeSelector(selector, onChange)
  }

  /**
   * Loads the store once, before any Extension activates. Idempotent across hot reloads, which
   * must not republish a snapshot. Never throws: an unreadable repository leaves the empty
   * snapshot in place and reports a diagnostic.
   */
  prime(): Promise<void> {
    this.#opened ??= this.#open()
    return this.#opened
  }

  async #open(): Promise<void> {
    if (this.#stopped) return
    this.#repository = await openRepository(this.#repoRoot)
    // Running outside a repository is a supported mode; `main` is what tells the user.
    if (this.#repository === null) return
    await this.refresh()
  }

  /**
   * Re-reads every slice and publishes. A caller arriving mid-pass gets the queued follow-up
   * rather than that pass, whose reads predate the caller's write. Only one follow-up is ever
   * queued, so a burst of writes costs two refreshes rather than one each.
   */
  refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#queued ??= Promise.withResolvers<void>()
      return this.#queued.promise
    }
    return this.#startPass()
  }

  #startPass(): Promise<void> {
    const pass = this.#refreshNow().finally(() => {
      this.#refreshing = undefined
      const queued = this.#queued
      if (!queued) return
      this.#queued = undefined
      void this.#startPass().then(queued.resolve, queued.resolve)
    })
    this.#refreshing = pass
    return pass
  }

  async #refreshNow(): Promise<void> {
    const repository = this.#repository
    if (!repository || this.#stopped) return
    try {
      const read = await this.#run(this.#readState(repository))
      if (this.#stopped) return
      // From the same pass that produced the snapshot, so the next poll tick is quiet unless
      // the repository really moved.
      this.#fingerprint = read.fingerprint
      this.store.publish(read.state)
    } catch (error) {
      this.#report("refresh", error)
    }
  }

  /** One repository read, fanned out concurrently. `commits` is gated: `git log` fails on an unborn HEAD. */
  #readState(repository: Repository): Effect.Effect<{ state: GitState; fingerprint: string }, GitError> {
    const root = repository.root
    const reads = Effect.all(
      {
        status: execGit(root, statusArgs),
        headRef: execGit(root, symbolicRefArgs, { allowFailure: true }),
        branches: execGit(root, branchArgs),
        // Remotes and branch upstreams both live in config; a repository that has neither
        // reports nothing, and says so with exit 1.
        config: execGitAllowingEmpty(root, configArgs, 1),
        tags: execGit(root, tagArgs),
        stash: execGit(root, stashArgs),
        // Not used to build the snapshot — it is the other half of the poll fingerprint.
        refs: execGitAllowingEmpty(root, refSnapshotArgs, 1),
      },
      { concurrency: "unbounded" },
    )

    return Effect.flatMap(reads, (outputs) => {
      const status = parseStatus(outputs.status.stdout)
      const headBranch = parseHeadRef(outputs.headRef.stdout, outputs.headRef.exitCode)
      const branches = parseBranches(outputs.branches.stdout, headBranch)
      const head = readHead(status, headBranch, branches)

      // A log needs a commit to start from: exactly the two variants carrying an oid.
      const commits =
        head.kind !== "detached" && head.kind !== "onBranch"
          ? Effect.succeed("")
          : Effect.catch(
              Effect.map(execGit(root, commitArgs(this.#config.commitLimit)), (output) => output.stdout),
              // The repository can go unborn between the two reads.
              (error: GitError) => {
                this.#report("reading commits", error)
                return Effect.succeed("")
              },
            )

      return Effect.map(commits, (log) => ({
        fingerprint: fingerprintOf(
          outputs.status.stdout,
          outputs.refs.stdout,
          outputs.stash.stdout,
          outputs.config.stdout,
        ),
        state: {
          head,
          branches,
          remotes: parseRemotes(outputs.config.stdout),
          tags: parseTags(outputs.tags.stdout),
          status: { files: status.files, isClean: status.files.length === 0 },
          commits: parseCommits(log),
          stash: parseStash(outputs.stash.stdout),
        },
      }))
    })
  }

  // ---- polling ---------------------------------------------------------------------

  /** Starts watching for changes made outside laziergit. Polling, never fs-watching `.git`. */
  start(): void {
    if (this.#stopped || this.#pollTimer) return
    this.#armPoll()
  }

  #armPoll(): void {
    this.#pollTimer = setInterval(() => void this.#poll(), Math.max(250, this.#config.refreshIntervalMs))
  }

  #disarmPoll(): void {
    if (!this.#pollTimer) return
    clearInterval(this.#pollTimer)
    this.#pollTimer = undefined
  }

  /**
   * Reads exactly what {@link fingerprintOf} compares. All four suppress optional locks, so
   * the poll neither contends with the user's own `git` nor dirties the index and triggers
   * itself on the next tick.
   */
  async #poll(): Promise<void> {
    const repository = this.#repository
    if (!repository || this.#stopped || this.#polling) return
    this.#polling = true
    try {
      const [status, refs, stash, config] = await this.#run(
        Effect.all(
          [
            execGit(repository.root, statusArgs),
            // A repository with no refs at all, or no remotes and no upstreams, exits 1
            // rather than reporting nothing.
            execGitAllowingEmpty(repository.root, refSnapshotArgs, 1),
            execGit(repository.root, stashArgs),
            execGitAllowingEmpty(repository.root, configArgs, 1),
          ],
          { concurrency: "unbounded" },
        ),
      )
      if (fingerprintOf(status.stdout, refs.stdout, stash.stdout, config.stdout) === this.#fingerprint) return
      await this.refresh()
    } catch (error) {
      this.#report("polling for changes", error)
    } finally {
      this.#polling = false
    }
  }

  /** Applies changed settings live, without republishing a snapshot nothing asked to change. */
  setConfig(config: GitConfig): void {
    const previous = this.#config
    this.#config = config

    if (previous.refreshIntervalMs !== config.refreshIntervalMs && this.#pollTimer) {
      this.#disarmPoll()
      this.#armPoll()
    }
    // The commit window is the one setting that changes what the store contains.
    if (previous.commitLimit !== config.commitLimit && this.#repository) void this.refresh()
  }

  // ---- writes ----------------------------------------------------------------------

  /**
   * Runs an effect and tracks it until it settles, so shutdown can wait for a `git commit`
   * already underway. A reload parks the promise, but the write itself always completes (§5.3).
   */
  #run<A>(effect: Effect.Effect<A, GitError>): Promise<A> {
    const pending = Effect.runPromise(effect)
    this.#inflight.add(pending)
    const tracked = pending.finally(() => {
      this.#inflight.delete(pending)
    })
    // The tracker must not become an unhandled rejection of its own; the caller still sees the
    // original rejection through `pending`.
    void tracked.catch(() => undefined)
    return pending
  }

  /**
   * {@link #run}, plus an entry in {@link activity} for as long as the work lasts. Wrapped
   * around the promise so it ends on every exit, and so it covers `#refreshed`'s follow-up
   * read: until the store catches up the screen still shows the old repository.
   */
  #announced<A>(args: readonly string[], effect: Effect.Effect<A, GitError>): Promise<A> {
    const subcommand = subcommandOf(args)
    // Nothing to name. `isMutating` already assumes the worst about it and refreshes.
    if (subcommand === null) return this.#run(effect)
    const end = this.activity.begin(labelFor(args, subcommand.name))
    return this.#run(effect).finally(end)
  }

  /**
   * Runs `build` against the repository root, or fails with a {@link GitError}. A typed
   * failure, so "there is no repository here" lands in the `catch` an Extension already wrote.
   */
  #withRepository<A>(
    args: readonly string[],
    build: (root: string) => Effect.Effect<A, GitError>,
  ): Effect.Effect<A, GitError> {
    return Effect.suspend(() => {
      const repository = this.#repository
      if (repository) return build(repository.root)
      return Effect.fail(
        new GitError(args, { stdout: "", stderr: `${this.#repoRoot} is not a git repository`, exitCode: 128 }),
      )
    })
  }

  /**
   * Republishes after a write, whether git said yes or no: a conflicting `stash pop`, a
   * `pull --rebase` that stops on a conflict, and a `discard` whose `clean` fails after its
   * `restore` landed all move the repository while rejecting.
   */
  #refreshed<A>(effect: Effect.Effect<A, GitError>): Effect.Effect<A, GitError> {
    return Effect.ensuring(
      effect,
      Effect.promise(() => this.refresh()),
    )
  }

  /** The Effect face of `raw`, and the base every porcelain helper is built from. */
  rawEffect(args: readonly string[], options: RawOptions = {}): Effect.Effect<GitOutput, GitError> {
    const mutating = isMutating(args)
    const invocation = this.#withRepository(args, (root) =>
      execGit(root, args, {
        stdin: options.stdin,
        env: options.env,
        allowFailure: options.allowFailure,
        write: mutating,
      }),
    )
    // Uninterruptible: a hot reload landing mid-`git commit` must not leave the repository
    // half-written. Only the awaited promise is parked (§5.3).
    return mutating ? this.#refreshed(Effect.uninterruptible(invocation)) : invocation
  }

  raw(args: readonly string[], options: RawOptions = {}): Promise<GitOutput> {
    const effect = this.rawEffect(args, options)
    // The same test that decides whether to refresh decides whether to announce.
    return isMutating(args) ? this.#announced(args, effect) : this.#run(effect)
  }

  #write(args: readonly string[]): Promise<void> {
    return this.#announced(
      args,
      this.#refreshed(
        this.#withRepository(args, (root) => Effect.map(execGit(root, args, { write: true }), () => undefined)),
      ),
    )
  }

  checkout(ref: string): Promise<void> {
    // The `--` goes *after* the ref: leading it would mean "these are paths", and
    // `git checkout -- main` restores a file called main instead of switching branch.
    return this.#write(["checkout", ref, "--"])
  }

  createBranch(name: string, opts: { at?: string; checkout?: boolean } = {}): Promise<void> {
    const at = opts.at === undefined ? [] : [opts.at]
    // `branch --` so a name beginning with a dash is a name, not an option — at which
    // point git would silently read the start-point as the branch to create.
    return this.#write(opts.checkout === true ? ["checkout", "-b", name, ...at] : ["branch", "--", name, ...at])
  }

  deleteBranch(name: string, opts: { force?: boolean } = {}): Promise<void> {
    return this.#write(["branch", opts.force === true ? "-D" : "-d", "--", name])
  }

  stage(paths: readonly string[] | "all"): Promise<void> {
    // `--` stops a file named `-f` becoming a flag; it does *not* stop git reading a path as a
    // glob, which is what `literalPathspec` is for.
    return this.#write(paths === "all" ? ["add", "--all", "--"] : ["add", "--", ...literalPaths(paths)])
  }

  unstage(paths: readonly string[] | "all"): Promise<void> {
    // An empty selection means unstage nothing, and must not reach git: a pathspec-less
    // `git reset --` is a mixed reset that would unstage *everything*.
    if (paths !== "all" && paths.length === 0) return Promise.resolve()
    // `git reset -- <paths>` rather than `git restore --staged`, which needs a HEAD and so
    // fails on a repository with no commits. A pathspec'd reset never touches the working tree.
    // `"all"` passes `"."`, a pathspec rather than a user path, so it is not made literal.
    return this.#write(["reset", "--quiet", "--", ...(paths === "all" ? ["."] : literalPaths(paths))])
  }

  /**
   * Two git operations: a tracked file is restored from the index, an untracked one deleted.
   * They cannot be one invocation — `git restore` refuses the whole pathspec if any entry is
   * untracked — so the paths are split by what the store last saw.
   */
  discard(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    const untracked = new Set(
      this.getSnapshot()
        .status.files.filter(isUntracked)
        .map((file) => file.path),
    )
    const toDelete = paths.filter((path) => untracked.has(path))
    const toRestore = paths.filter((path) => !untracked.has(path))

    return this.#announced(
      ["restore"],
      this.#refreshed(
        this.#withRepository(["restore"], (root) => {
          const restored =
            toRestore.length === 0
              ? Effect.succeed(undefined)
              : Effect.map(
                  execGit(root, ["restore", "--worktree", "--", ...literalPaths(toRestore)], { write: true }),
                  () => undefined,
                )
          if (toDelete.length === 0) return restored
          return Effect.flatMap(restored, () =>
            // `-ff`, not `-f`: a single force makes clean silently refuse to descend into an
            // untracked directory that has its own `.git`, exiting 0 having done nothing.
            Effect.map(
              execGit(root, ["clean", "-ffd", "--", ...literalPaths(toDelete)], { write: true }),
              () => undefined,
            ),
          )
        }),
      ),
    )
  }

  commit(
    message: string,
    opts: { amend?: boolean; allowEmpty?: boolean; signoff?: boolean; messageOnly?: boolean } = {},
  ): Promise<void> {
    return this.#write([
      "commit",
      ...(opts.amend === true ? ["--amend"] : []),
      ...(opts.allowEmpty === true || opts.messageOnly === true ? ["--allow-empty"] : []),
      ...(opts.messageOnly === true ? ["--only"] : []),
      ...(opts.signoff === true ? ["--signoff"] : []),
      "--message",
      message,
    ])
  }

  push(
    opts: { remote?: string; ref?: string; force?: boolean | "with-lease"; setUpstream?: boolean } = {},
  ): Promise<void> {
    // git's first positional operand is the *repository*, so a ref given without a remote
    // would be pushed to a remote of that name. The branch's own remote stands in.
    const remote = opts.remote ?? (opts.ref === undefined ? undefined : this.#remoteFor(opts.ref))
    return this.#write([
      "push",
      ...(opts.force === "with-lease" ? ["--force-with-lease"] : opts.force === true ? ["--force"] : []),
      ...(opts.setUpstream === true ? ["--set-upstream"] : []),
      ...(remote === undefined ? [] : [remote]),
      ...(opts.ref === undefined ? [] : [opts.ref]),
    ])
  }

  /** The remote a ref already tracks, else the conventional default, else the first configured. */
  #remoteFor(ref: string): string {
    const state = this.getSnapshot()
    const tracked = state.branches.find((branch) => branch.name === ref)?.upstream?.remote
    if (tracked !== undefined) return tracked
    const names = state.remotes.map((remote) => remote.name)
    return names.includes("origin") ? "origin" : (names[0] ?? "origin")
  }

  pull(opts: { rebase?: boolean } = {}): Promise<void> {
    return this.#write(["pull", ...(opts.rebase === true ? ["--rebase"] : [])])
  }

  fetch(opts: { remote?: string; prune?: boolean } = {}): Promise<void> {
    return this.#write([
      "fetch",
      ...(opts.prune === true ? ["--prune"] : []),
      ...(opts.remote === undefined ? ["--all"] : [opts.remote]),
    ])
  }

  readonly stash = {
    save: (opts: { message?: string; includeUntracked?: boolean; keepIndex?: boolean } = {}): Promise<void> =>
      this.#write([
        "stash",
        "push",
        ...(opts.includeUntracked === true ? ["--include-untracked"] : []),
        ...(opts.keepIndex === true ? ["--keep-index"] : []),
        ...(opts.message === undefined ? [] : ["--message", opts.message]),
      ]),
    apply: (index?: number): Promise<void> => this.#write(["stash", "apply", stashRef(index)]),
    pop: (index?: number): Promise<void> => this.#write(["stash", "pop", stashRef(index)]),
    drop: (index: number): Promise<void> => this.#write(["stash", "drop", stashRef(index)]),
  }

  // ---- the Effect escape hatch -----------------------------------------------------

  /** Re-read on every run, never a captured snapshot. */
  readonly stateEffect: Effect.Effect<GitState> = Effect.sync(() => this.store.getSnapshot())

  /** A snapshot per refresh. The stream's own scope releases the subscription. */
  readonly changes: Stream.Stream<GitState> = Stream.callback<GitState>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => this.store.onPublish((publication) => Queue.offerUnsafe(queue, publication.current))),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ),
  )

  // ---- shutdown --------------------------------------------------------------------

  /**
   * Waits for git work already in flight. Extensions' promises are parked by the time this
   * runs, but the writes behind them are not, and the process must not exit mid-`git commit`.
   */
  async drain(): Promise<void> {
    this.#stopped = true
    this.#disarmPoll()
    await Promise.allSettled([this.#opened, this.#refreshing, ...this.#inflight])
    // After the wait: until the writes settle they really are in flight.
    this.activity.clear()
  }

  /** Clears the poll timer synchronously, before shutdown starts draining. */
  stop(): void {
    this.#stopped = true
    this.#disarmPoll()
    this.activity.clear()
  }
}

function stashRef(index: number | undefined): string {
  return `stash@{${index ?? 0}}`
}

/**
 * Every path in a selection, as a pathspec that matches only itself. Paths arrive verbatim
 * from porcelain, so a name containing `*`, `?`, `[` or a leading `:` would otherwise act on
 * its neighbours. Applied at the argv edge, so there is one place to check.
 */
function literalPaths(paths: readonly string[]): readonly string[] {
  return paths.map(literalPathspec)
}
