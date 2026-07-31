import type { GitActivity } from "laziergit"

/**
 * How long an operation must run before it is worth telling the user about. `ctx.git.stage` on
 * one file settles in single-digit milliseconds, and the diff Pane stages hunks as you press
 * keys — publishing those would blink a spinner on the affected row once per keystroke.
 * Anything faster than this never reaches a listener, so it costs no publish and no re-render.
 */
const revealMs = 120

interface Tracked {
  readonly id: number
  readonly label: string
  /** Past {@link revealMs}, and therefore in the published snapshot. */
  revealed: boolean
  readonly timer: ReturnType<typeof setTimeout>
}

const nothing: readonly GitActivity[] = Object.freeze([])

/**
 * What git is doing right now, for anything that wants to draw it. Owned by the
 * {@link GitService}, so it survives a hot reload.
 */
export class GitActivityStore {
  readonly #listeners = new Set<() => void>()
  readonly #tracked = new Map<number, Tracked>()
  readonly #report: (error: unknown) => void
  #snapshot: readonly GitActivity[] = nothing
  #nextId = 1

  constructor(report: (error: unknown) => void) {
    this.#report = report
  }

  /** Stable between publishes: `useSyncExternalStore` re-reads it per render and compares identity. */
  getSnapshot = (): readonly GitActivity[] => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Records one operation, and returns the finisher to call however it settles — success,
   * git saying no, or a throw. The finisher is idempotent, so a caller may hand it to both a
   * `.finally` and a bail-out path without double-counting.
   */
  begin(label: string): () => void {
    const id = this.#nextId
    this.#nextId += 1

    const timer = setTimeout(() => {
      const entry = this.#tracked.get(id)
      if (!entry) return
      entry.revealed = true
      this.#publish()
    }, revealMs)
    // A pending reveal must never keep the process alive: `drain()` waits for the git work
    // itself, and a 120ms timer outliving it would hold the event loop open.
    timer.unref?.()

    this.#tracked.set(id, { id, label, revealed: false, timer })

    let ended = false
    return () => {
      if (ended) return
      ended = true
      const entry = this.#tracked.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.#tracked.delete(id)
      // An operation that finished before it was revealed changes nothing anyone can see.
      if (entry.revealed) this.#publish()
    }
  }

  /** Drops everything in flight. Shutdown only: the timers must not outlive the renderer. */
  clear(): void {
    if (this.#tracked.size === 0) return
    for (const entry of this.#tracked.values()) clearTimeout(entry.timer)
    this.#tracked.clear()
    this.#publish()
  }

  #publish(): void {
    const revealed: GitActivity[] = []
    // Insertion order, so `at(-1)` is the most recently started operation.
    for (const entry of this.#tracked.values()) {
      if (entry.revealed) revealed.push(Object.freeze({ id: entry.id, label: entry.label }))
    }

    const next = revealed.length === 0 ? nothing : Object.freeze(revealed)
    if (this.#snapshot === nothing && next === nothing) return
    this.#snapshot = next

    // Snapshotted, and re-checked: a listener may unsubscribe from inside the notification,
    // and a disposed subscription must go quiet immediately.
    const listeners = [...this.#listeners]
    for (const listener of listeners) {
      if (!this.#listeners.has(listener)) continue
      try {
        listener()
      } catch (error) {
        this.#report(error)
      }
    }
  }
}

/** Flags that change what an operation *is*, rather than how it does it. */
function has(args: readonly string[], ...flags: readonly string[]): boolean {
  return flags.some((flag) => args.includes(flag))
}

/**
 * What to call the operation this argv performs, as a gerund. Read off the argv rather than
 * passed in by each caller, so every route to git is covered by construction. The refinements
 * below are only the ones a user would notice being wrong: a force push is not a push, an
 * amend is not a commit, and `reset --quiet --` is the unstage path, not a reset moving HEAD.
 */
export function labelFor(args: readonly string[], subcommand: string): string {
  switch (subcommand) {
    case "push":
      if (has(args, "--delete")) return "deleting remote branch"
      return has(args, "--force", "--force-with-lease") ? "force-pushing" : "pushing"
    case "pull":
      return has(args, "--rebase") ? "pulling (rebase)" : "pulling"
    case "fetch":
      return has(args, "--prune") ? "fetching (prune)" : "fetching"
    case "commit":
      return has(args, "--amend") ? "amending" : "committing"
    case "checkout":
      return has(args, "-b", "-B") ? "creating branch" : "checking out"
    case "switch":
      return "switching branch"
    case "branch":
      if (has(args, "-d", "-D", "--delete")) return "deleting branch"
      if (has(args, "--set-upstream-to", "--unset-upstream")) return "setting upstream"
      return "creating branch"
    case "add":
      return "staging"
    case "reset":
      // `--quiet --` with a pathspec is what `unstage` builds; a reset naming a mode is moving
      // HEAD, which is a different thing to be told is happening.
      return has(args, "--hard", "--soft", "--mixed", "--keep", "--merge") ? "resetting" : "unstaging"
    case "restore":
    case "clean":
      return "discarding"
    case "stash":
      if (has(args, "apply")) return "applying stash"
      if (has(args, "pop")) return "popping stash"
      if (has(args, "drop")) return "dropping stash"
      return "stashing"
    case "merge":
      return "merging"
    case "rebase":
      return "rebasing"
    case "revert":
      return "reverting"
    case "cherry-pick":
      return "cherry-picking"
    case "tag":
      return "tagging"
    case "rm":
      return "removing"
    case "mv":
      return "moving"
    case "worktree":
      return "updating worktrees"
    case "submodule":
      return "updating submodules"
    default:
      // The subcommand is the honest answer, and better than a spinner labelled "working".
      return `running git ${subcommand}`
  }
}
