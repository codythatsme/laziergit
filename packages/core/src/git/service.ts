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
 * assumed to mutate, so `ctx.git.raw` refreshes after it — the failure mode of a wasted
 * refresh is a duplicate read, while the failure mode of a missed one is a screen that
 * silently disagrees with the repository. Commands like `config` and `symbolic-ref` are
 * deliberately absent: they read *or* write depending on their arguments.
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

/**
 * Read-only only in combination — `git stash list` and `git stash show` against every
 * other `git stash` verb. Without these the stash-preview pane in docs/extension-api.md
 * §4.4 would trigger a whole refresh on every cursor movement.
 */
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
 * What the poll compares, and why it is four reads rather than one.
 *
 * `status` catches working-tree edits, which move nothing under `.git` at all. `refs`
 * catches commits, checkouts, and fetches. `stash` is separate because dropping any entry
 * but the top one rewrites only the stash *reflog*, leaving `refs/stash` — and so the refs
 * snapshot — byte-identical. `config` catches what is configured rather than committed:
 * adding a remote, or setting an upstream on a branch that is not HEAD.
 *
 * Joined on a separator no git output can contain.
 */
function fingerprintOf(status: string, refs: string, stash: string, config: string): string {
  return [status, refs, stash, config].join("\u0000\u0000")
}

/**
 * All git access, and the only writer of the {@link GitStore}.
 *
 * Effect owns the I/O — child-process lifetime, lock retry, and the concurrent fan-out of
 * a refresh — while the store, coalescing, and polling stay plain TypeScript, because
 * they are control flow the rest of core already speaks. The Promise surface handed to
 * Extensions never mentions Effect (ADR-0002); the narrow Effect surface behind
 * `ctx.effect` is built from the very same effects rather than re-wrapped.
 */
export class GitService {
  readonly store: GitStore
  /**
   * What git is doing right now. Written here, at the one choke point every write already
   * passes through, so no Extension has to remember to report its own progress — and none
   * can forget. Reads are deliberately absent: the diff Pane runs one on every cursor move.
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
   * Loads the store once, before any Extension activates, so `ctx.git.state` is never
   * empty-because-not-yet-read. Idempotent across hot reloads — reload must not republish
   * a snapshot, or every reactivated Extension would see a spurious change.
   *
   * Never throws: outside a repository, or when git itself fails, the store keeps serving
   * the empty snapshot and the reason is reported as a diagnostic. An unreadable
   * repository degrades laziergit; it does not stop it from starting.
   */
  prime(): Promise<void> {
    this.#opened ??= this.#open()
    return this.#opened
  }

  async #open(): Promise<void> {
    if (this.#stopped) return
    this.#repository = await openRepository(this.#repoRoot)
    // Running outside a repository is a supported mode, not a failure, so it is not
    // diagnosed here. Whoever chose the directory is the one who can explain it — for the
    // binary that is `main`, which tells the user in the running app.
    if (this.#repository === null) return
    await this.refresh()
  }

  /**
   * Re-reads every slice and publishes.
   *
   * A caller arriving while a pass is running does **not** get that pass: its reads were
   * already in flight before the caller's write landed, so awaiting it would resolve
   * against a snapshot that predates the very change the caller just made. It gets the
   * queued follow-up instead. Only one follow-up is ever queued — a burst of writes must
   * not cost a refresh each — but the last of them is always observed.
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
      // Recorded from the same pass that produced the snapshot, so the fingerprint always
      // describes what was just published — the next poll tick is quiet unless the
      // repository really moved, whether the refresh came from a write or from a poll.
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

      // Asking for a log needs a commit to start from, which is exactly the two variants
      // carrying an oid — spelled positively so a later variant cannot slip through.
      const commits =
        head.kind !== "detached" && head.kind !== "onBranch"
          ? Effect.succeed("")
          : Effect.catch(
              Effect.map(execGit(root, commitArgs(this.#config.commitLimit)), (output) => output.stdout),
              // The repository can go unborn between the two reads. One empty slice beats
              // failing a whole refresh over history that momentarily does not exist.
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
          // `isClean` stays a stored boolean rather than a getter: it is read in eight
          // places, computed in exactly this one, and a value compares `Object.is`-stably
          // inside a `useGit` selector where a derived array would not.
          status: { files: status.files, isClean: status.files.length === 0 },
          commits: parseCommits(log),
          stash: parseStash(outputs.stash.stdout),
        },
      }))
    })
  }

  // ---- polling ---------------------------------------------------------------------

  /**
   * Starts watching for changes made outside laziergit. Deliberately not fs-watching
   * `.git`: lazygit's experience is that polling a cheap fingerprint is both simpler and
   * more reliable across platforms and filesystems.
   */
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
   * Reads exactly what {@link fingerprintOf} compares, and nothing else — four small
   * commands, none of which touches an object. All of them suppress optional locks, so the
   * poll can neither contend with the user's own `git` nor dirty the index and thereby
   * trigger itself on the next tick.
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
      // The refresh records the fingerprint from its own reads, not this tick's, so a
      // change landing between the two passes is caught next tick rather than lost.
      await this.refresh()
    } catch (error) {
      this.#report("polling for changes", error)
    } finally {
      this.#polling = false
    }
  }

  /**
   * Applies changed settings live. Nothing here republishes the snapshot: a settings edit
   * that changed no git setting must not fire seven slice events and re-render every pane.
   */
  setConfig(config: GitConfig): void {
    const previous = this.#config
    this.#config = config

    if (previous.refreshIntervalMs !== config.refreshIntervalMs && this.#pollTimer) {
      this.#disarmPoll()
      this.#armPoll()
    }
    // The commit window is the one setting that changes what the store *contains*, so it
    // is also the one whose edit legitimately publishes new state.
    if (previous.commitLimit !== config.commitLimit && this.#repository) void this.refresh()
  }

  // ---- writes ----------------------------------------------------------------------

  /**
   * Runs an effect and tracks it until it settles, so shutdown can wait for a `git commit`
   * that is already underway. Extension-facing supervision is a separate concern: the
   * activation scope parks the *promise* on reload, while the write itself always runs to
   * completion (docs/extension-api.md §5.3).
   */
  #run<A>(effect: Effect.Effect<A, GitError>): Promise<A> {
    const pending = Effect.runPromise(effect)
    this.#inflight.add(pending)
    const tracked = pending.finally(() => {
      this.#inflight.delete(pending)
    })
    // The tracker must not become an unhandled rejection of its own; the caller still sees
    // the original rejection through `pending`.
    void tracked.catch(() => undefined)
    return pending
  }

  /**
   * {@link #run}, plus an entry in {@link activity} for as long as the work lasts.
   *
   * Wrapped around the promise rather than folded into the effect so it ends on every exit —
   * git refusing, the repository being absent, a defect — and so it survives `#refreshed`
   * running the follow-up read *inside* the effect: the operation stays announced until the
   * store has caught up, because until then the screen still shows the old repository.
   */
  #announced<A>(args: readonly string[], effect: Effect.Effect<A, GitError>): Promise<A> {
    const subcommand = subcommandOf(args)
    // Argv with no subcommand is nothing to name. `isMutating` already assumes the worst
    // about it and refreshes; there is just no honest word to put on the status line.
    if (subcommand === null) return this.#run(effect)
    const end = this.activity.begin(labelFor(args, subcommand.name))
    return this.#run(effect).finally(end)
  }

  /**
   * Runs `build` against the repository root, or fails with a {@link GitError} naming the
   * reason. A typed failure rather than a thrown defect: to an Extension "there is no
   * repository here" is the same kind of answer as "git said no", and both belong in the
   * `catch` it already wrote.
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
   * Republishes after a write, so the caller's `await` already sees the result on the
   * screen — whether git said yes or no. A failed write is not a write that did nothing: a
   * conflicting `stash pop`, a `pull --rebase` that stops on a conflict, a `discard` whose
   * `clean` fails after its `restore` landed, all move the repository while rejecting, and
   * a success-only refresh would leave the store reporting the state from before. A refresh
   * that turns out to have nothing to report is already coalesced, so it costs one read.
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
      execGit(root, args, { stdin: options.stdin, allowFailure: options.allowFailure, write: mutating }),
    )
    // Uninterruptible for the same reason `ctx.git`'s Promise face passes no cancel
    // callback: a write started while the Extension was live must run to completion, or a
    // hot reload landing mid-`git commit` leaves the repository half-written
    // (docs/extension-api.md §5.3). Only the awaited promise is parked.
    return mutating ? this.#refreshed(Effect.uninterruptible(invocation)) : invocation
  }

  raw(args: readonly string[], options: RawOptions = {}): Promise<GitOutput> {
    const effect = this.rawEffect(args, options)
    // The same test that decides whether to refresh decides whether to announce, and for the
    // same reason: a read is something the app does while you look at it, a write is something
    // you asked for and are now waiting on.
    return isMutating(args) ? this.#announced(args, effect) : this.#run(effect)
  }

  /** A porcelain write. Every helper encodes its own safe flag handling and nothing else. */
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
    // `--all` takes no pathspec at all, so there is nothing here to make literal.
    // `--` separates paths from options so a file named `-f` can never become a flag; it
    // does *not* stop git reading a path as a glob, which is what `literalPathspec` is for.
    return this.#write(paths === "all" ? ["add", "--all", "--"] : ["add", "--", ...literalPaths(paths)])
  }

  unstage(paths: readonly string[] | "all"): Promise<void> {
    // An empty selection means unstage nothing, and must not reach git: a pathspec-less
    // `git reset --` is a mixed reset that would unstage *everything*.
    if (paths !== "all" && paths.length === 0) return Promise.resolve()
    // `git reset -- <paths>` rather than `git restore --staged`, which needs a HEAD to
    // restore from and so fails outright on a repository with no commits yet — where
    // unstaging is both meaningful and common. A pathspec'd reset never touches the
    // working tree.
    //
    // `"all"` passes `"."`, which is a pathspec but not a user path: making it literal
    // would ask for a file actually named `.`.
    return this.#write(["reset", "--quiet", "--", ...(paths === "all" ? ["."] : literalPaths(paths))])
  }

  /**
   * Discarding means two different git operations: a tracked file is restored from the
   * index, an untracked one is deleted. They cannot be one invocation — `git restore`
   * refuses the *whole* pathspec if any entry is untracked, silently leaving the tracked
   * edits in place too — so the paths are split by what the store last saw, which is the
   * same list the user was looking at when they chose them.
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
            // `-ff`, not `-f`: a single force makes clean silently refuse to descend into
            // an untracked directory that has its own `.git`, exiting 0 having done nothing.
            Effect.map(
              execGit(root, ["clean", "-ffd", "--", ...literalPaths(toDelete)], { write: true }),
              () => undefined,
            ),
          )
        }),
      ),
    )
  }

  commit(message: string, opts: { amend?: boolean; allowEmpty?: boolean; signoff?: boolean } = {}): Promise<void> {
    return this.#write([
      "commit",
      ...(opts.amend === true ? ["--amend"] : []),
      ...(opts.allowEmpty === true ? ["--allow-empty"] : []),
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

  /**
   * A snapshot per refresh. The subscription is released by the stream's own scope, so a
   * consumer that stops consuming stops observing — no listener outlives its fiber.
   */
  readonly changes: Stream.Stream<GitState> = Stream.callback<GitState>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => this.store.onPublish((publication) => Queue.offerUnsafe(queue, publication.current))),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ),
  )

  // ---- shutdown --------------------------------------------------------------------

  /**
   * Waits for git work already in flight. Called after Extensions deactivate — their
   * promises are parked by then, but the writes behind them are still running and the
   * process must not exit mid-`git commit`.
   */
  async drain(): Promise<void> {
    this.#stopped = true
    this.#disarmPoll()
    await Promise.allSettled([this.#opened, this.#refreshing, ...this.#inflight])
    // After the wait, not before: until the writes settle they really are in flight, and
    // anything still rendering should keep saying so.
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
 * Every path in a selection, as a pathspec that matches only itself.
 *
 * The paths reaching these helpers come verbatim out of `status --porcelain=v2 -z`, so
 * nothing upstream has escaped them and a name containing `*`, `?`, `[` or a leading `:`
 * would otherwise act on its neighbours — `discard(["foo[1].txt"])` restoring `foo1.txt`
 * over the user's edits, and `git clean -ffd` deleting an untracked `bar1.txt` nobody
 * named. Applied at the argv edge rather than at the API edge so there is exactly one
 * place to check that every path git sees went through it.
 */
function literalPaths(paths: readonly string[]): readonly string[] {
  return paths.map(literalPathspec)
}
