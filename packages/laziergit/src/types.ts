import { createExtensionDefinition } from "@laziergit/runtime-bridge"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { ComponentType, ReactNode } from "react"

export interface Disposable {
  dispose(): void
}

export type StaleReason = "reload" | "deactivated" | "quit"

export class StaleContextError extends Error {
  readonly extension: string
  readonly reason: StaleReason

  constructor(extension: string, reason: StaleReason) {
    super(`Extension context for "${extension}" is stale after ${reason}`)
    this.name = "StaleContextError"
    this.extension = extension
    this.reason = reason
  }
}

export type ScopedId<TName extends string> = TName | `${TName}.${string}`
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "muted"
export type KeySpec = string
export type NeedName = (keyof ExtensionApis & string) | (string & {})

export function defineExtension<
  const TName extends string,
  const Config extends ConfigSchema = Record<never, never>,
  const Needs extends readonly NeedName[] = readonly [],
  Api = void,
>(spec: ExtensionSpec<TName, Config, Needs, Api>): Extension<TName, Config, Needs, Api> {
  return createExtensionDefinition(spec)
}

export interface ExtensionSpec<
  TName extends string,
  Config extends ConfigSchema,
  Needs extends readonly NeedName[],
  Api,
> {
  name: TName
  description?: string
  config?: Config
  needs?: Needs
  activate(ctx: ExtensionContext<TName, Config, Needs>): Api | Promise<Api>
  deactivate?(): void | Promise<void>
}

export interface Extension<
  TName extends string = string,
  Config extends ConfigSchema = ConfigSchema,
  Needs extends readonly NeedName[] = readonly NeedName[],
  Api = unknown,
> {
  readonly spec: ExtensionSpec<TName, Config, Needs, Api>
}

export type ExtensionApiOf<E> = E extends Extension<infer _N, infer _C, infer _D, infer Api> ? Awaited<Api> : never

export interface ExtensionContext<
  TName extends string = string,
  Config extends ConfigSchema = Record<never, never>,
  Needs extends readonly NeedName[] = readonly [],
> {
  readonly config: ConfigValues<Config>
  readonly git: Git
  readonly events: EventBus<TName>
  readonly commands: CommandRegistry<TName>
  readonly panes: PaneRegistry<TName>
  readonly popups: PopupToolkit
  readonly statusline: Statusline<TName>
  readonly extensions: ExtensionHub<Needs>
  readonly effect: EffectEscape<TName>
  readonly signal: AbortSignal
  exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecOutput>
  /** Suspend the TUI and give a child the terminal, for editors and interactive Git tools. */
  interactive(command: string, args?: readonly string[], options?: InteractiveOptions): Promise<number>
  open(url: string): Promise<void>
  copy(text: string): Promise<void>
  onDispose(fn: () => void | Promise<void>): void
}

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export interface ExecOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface InteractiveOptions {
  cwd?: string
  env?: Record<string, string>
}

export type ConfigValue = string | number | boolean | readonly string[]

interface ConfigOptionBase {
  readonly description?: string
}

export interface StringConfigOption extends ConfigOptionBase {
  readonly kind: "string"
  readonly default: string
}

export interface NumberConfigOption extends ConfigOptionBase {
  readonly kind: "number"
  readonly default: number
  readonly min?: number
  readonly max?: number
}

export interface BooleanConfigOption extends ConfigOptionBase {
  readonly kind: "boolean"
  readonly default: boolean
}

export interface EnumConfigOption<V extends string = string> extends ConfigOptionBase {
  readonly kind: "enum"
  /** Every accepted spelling. {@link default} is one of them, by construction. */
  readonly values: readonly V[]
  readonly default: V
}

export interface StringArrayConfigOption extends ConfigOptionBase {
  readonly kind: "string-array"
  readonly default: readonly string[]
}

/** One declared setting. Discriminated on `kind`, so each variant carries its own bounds. */
export type ConfigOption =
  | StringConfigOption
  | NumberConfigOption
  | BooleanConfigOption
  | EnumConfigOption
  | StringArrayConfigOption

export type ConfigSchema = Record<string, ConfigOption>
export type ConfigValues<S extends ConfigSchema> = {
  readonly [K in keyof S]: S[K]["default"]
}

export const option = {
  string(opts: { default: string; description?: string }): StringConfigOption {
    return Object.freeze({ kind: "string", ...opts })
  },
  number(opts: { default: number; description?: string; min?: number; max?: number }): NumberConfigOption {
    // At definition time: a default outside its own bounds is handed back verbatim to every
    // user who does not set the option, so nothing downstream would ever surface it.
    const { default: value, min, max } = opts
    if (min !== undefined && max !== undefined && min > max) {
      throw new TypeError(`Number option min ${min} exceeds max ${max}`)
    }
    if (min !== undefined && value < min) throw new TypeError(`Number option default ${value} is below min ${min}`)
    if (max !== undefined && value > max) throw new TypeError(`Number option default ${value} is above max ${max}`)
    return Object.freeze({ kind: "number", ...opts })
  },
  boolean(opts: { default: boolean; description?: string }): BooleanConfigOption {
    return Object.freeze({ kind: "boolean", ...opts })
  },
  enum<const V extends readonly string[]>(
    values: V,
    opts: { default: V[number]; description?: string },
  ): EnumConfigOption<V[number]> {
    if (!values.includes(opts.default)) {
      throw new TypeError(`Enum default "${opts.default}" is not one of its declared values`)
    }
    return Object.freeze({ kind: "enum", values: Object.freeze([...values]), ...opts })
  },
  stringArray(opts: { default: readonly string[]; description?: string }): StringArrayConfigOption {
    return Object.freeze({ kind: "string-array", ...opts, default: Object.freeze([...opts.default]) })
  },
}

/**
 * One git operation core is running right now — see {@link useGitActivity}. Only writes, and
 * only once they have run long enough to be worth drawing.
 */
export interface GitActivity {
  /** Unique for as long as the operation runs. */
  readonly id: number
  /** What git is doing, as a gerund: `"pushing"`, `"amending"`, `"fetching (prune)"`. */
  readonly label: string
}

export interface GitState {
  readonly head: Head
  /** Merge/sequencer state detected from this worktree's Git administrative directory. */
  readonly operation: GitOperation
  readonly branches: readonly Branch[]
  /** Cached remote-tracking branches, most-recently-committed first. */
  readonly remoteBranches: readonly RemoteBranch[]
  readonly remotes: readonly Remote[]
  readonly tags: readonly Tag[]
  readonly status: WorkingTreeStatus
  readonly commits: readonly Commit[]
  readonly stash: readonly StashEntry[]
}

export type GitOperationKind = "merge" | "rebase" | "cherryPick" | "revert"

/**
 * Repository operations can be nested: a revert or cherry-pick may stop inside a rebase.
 * Keep every observed flag and use {@link effective} for the command `m` should control.
 */
export interface GitOperation {
  readonly merging: boolean
  readonly rebasing: boolean
  readonly cherryPicking: boolean
  readonly reverting: boolean
  /** Revert, cherry-pick, merge, then rebase — the same precedence Git's sequencers need. */
  readonly effective: GitOperationKind | null
  /** Session metadata: this LazierGit process observed one of its writes begin the operation. */
  readonly initiatedHere: boolean
}

/**
 * Where HEAD points. A union, because the fields are not independent: an unborn HEAD has no
 * commit to name, and a detached one has no branch and therefore no upstream.
 */
export type Head =
  /**
   * There is no repository here. Every other slice of {@link GitState} is empty beside it and
   * every write rejects.
   */
  | { readonly kind: "noRepository" }
  /**
   * `git init` with nothing committed: HEAD is a symbolic ref to a branch that does not
   * exist yet.
   */
  | { readonly kind: "unborn"; readonly branch: string }
  /** HEAD is a raw commit, so there is no branch to carry an upstream. */
  | { readonly kind: "detached"; readonly oid: string }
  | {
      readonly kind: "onBranch"
      readonly oid: string
      readonly branch: string
      /** The upstream of {@link branch} — the very object that branch's row carries. */
      readonly upstream: UpstreamInfo | null
    }

export interface UpstreamInfo {
  readonly remote: string
  /** Branch name on the remote, without its `refs/heads/` prefix. */
  readonly branch: string
  /**
   * The upstream ref no longer exists on the remote. Git reports `gone` *instead of* a
   * divergence, so {@link ahead} and {@link behind} are both 0 and mean nothing — this flag is
   * all that separates a deleted upstream from an in-sync one.
   */
  readonly gone: boolean
  readonly ahead: number
  readonly behind: number
}

export interface Branch {
  readonly name: string
  readonly oid: string
  readonly isHead: boolean
  readonly upstream: UpstreamInfo | null
  readonly lastCommit: CommitSummary
}

export interface RemoteBranch {
  /** Branch name without the remote prefix. */
  readonly name: string
  readonly remote: string
  readonly oid: string
}

/** The hosted repository whose Authored Pull Requests a Pull Requests Pane lists. */
export interface PullRequestRepository {
  readonly host: string
  readonly owner: string
  readonly name: string
}

/** One open pull request authored by the current GitHub identity. */
export interface PullRequest {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly headRefName: string
  readonly isDraft: boolean
  readonly updatedAt: string
  readonly repository: PullRequestRepository
}

export interface CommitSummary {
  readonly oid: string
  readonly subject: string
  readonly authoredAt: number
}

export interface Commit {
  readonly oid: string
  readonly shortOid: string
  readonly subject: string
  readonly author: { readonly name: string; readonly email: string }
  readonly authoredAt: number
  readonly parents: readonly string[]
}

/**
 * What one side of the index did to a path — porcelain v2's `X` and `Y` letters, named. `X` is
 * HEAD→index and `Y` is index→working tree, two independent comparisons, which is why one path
 * can be `MM`.
 */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange"

/** Only the working-tree side can report a path git has never been told about. */
export type WorktreeChange = ChangeKind | "untracked"

/** What one side of a merge did to a path — porcelain v2's unmerged `XY`, one letter each. */
export type ConflictSide = "added" | "deleted" | "modified"

/**
 * One path, one entry. Narrow on `kind`: an unmerged path has no
 * index-vs-working-tree pair to report at all. Ask the questions with {@link isStaged},
 * {@link isUnstaged}, {@link isUntracked} and {@link isConflicted}.
 *
 * Invariant on the `"changed"` arm: at least one of `index` / `worktree` is non-null, since
 * git does not report a path that matches HEAD on both sides.
 */
export type FileChange =
  | {
      readonly kind: "changed"
      readonly path: string
      /** The name git moved this path away from, on a rename or copy the index holds. */
      readonly previousPath: string | null
      /** HEAD → index. `null` when the index matches HEAD. */
      readonly index: ChangeKind | null
      /** Index → working tree. `null` when the working tree matches the index. */
      readonly worktree: WorktreeChange | null
    }
  | {
      readonly kind: "conflicted"
      readonly path: string
      /** Always null: git reports no rename detection for an unmerged path. */
      readonly previousPath: null
      /** What our side of the merge did. */
      readonly ours: ConflictSide
      /** What their side did. */
      readonly theirs: ConflictSide
    }

export interface WorkingTreeStatus {
  /**
   * One entry per path git reported, ordered by path. Filter it with the predicates, deriving
   * in a `useMemo` — a filter inside a `useGit` selector builds a fresh array every snapshot
   * and never settles.
   */
  readonly files: readonly FileChange[]
  readonly isClean: boolean
}

export interface StashEntry {
  readonly index: number
  readonly oid: string
  readonly message: string
  readonly branch: string | null
  readonly createdAt: number
}

export interface Remote {
  readonly name: string
  readonly fetchUrl: string
  readonly pushUrl: string
}

export interface Tag {
  readonly name: string
  readonly oid: string
}

export interface GitOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface RawOptions {
  stdin?: string
  allowFailure?: boolean
  env?: Readonly<Record<string, string>>
}

export type StashSaveOptions =
  | {
      message?: string
      mode?: "all"
      includeUntracked?: boolean
      keepIndex?: boolean
    }
  | {
      message?: string
      mode: "staged" | "unstaged"
    }

export class GitError extends Error {
  readonly args: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(args: readonly string[], output: GitOutput) {
    super(output.stderr.trim() || `git ${args.join(" ")} exited with ${output.exitCode}`)
    this.name = "GitError"
    this.args = args
    this.exitCode = output.exitCode
    this.stdout = output.stdout
    this.stderr = output.stderr
  }
}

export interface Git {
  readonly root: string
  readonly state: GitState
  subscribe<T>(selector: (state: GitState) => T, onChange: (value: T, previous: T) => void): Disposable
  refresh(): Promise<void>
  /** Wait for Git work already in flight, including each write's state refresh. */
  waitForIdle(): Promise<void>
  /** Loads the configured history window rooted at an arbitrary ref without changing HEAD. */
  commits(ref: string): Promise<readonly Commit[]>
  raw(args: readonly string[], options?: RawOptions): Promise<GitOutput>
  checkout(ref: string): Promise<void>
  createBranch(name: string, opts?: { at?: string; checkout?: boolean }): Promise<void>
  deleteBranch(name: string, opts?: { force?: boolean }): Promise<void>
  deleteRemoteBranch(remote: string, name: string): Promise<void>
  stage(paths: readonly string[] | "all"): Promise<void>
  unstage(paths: readonly string[] | "all"): Promise<void>
  discard(paths: readonly string[]): Promise<void>
  commit(
    message: string,
    opts?: { amend?: boolean; allowEmpty?: boolean; signoff?: boolean; skipHooks?: boolean; messageOnly?: boolean },
  ): Promise<void>
  push(opts?: { remote?: string; ref?: string; force?: boolean | "with-lease"; setUpstream?: boolean }): Promise<void>
  pull(opts?: { rebase?: boolean }): Promise<void>
  fetch(opts?: { remote?: string; prune?: boolean }): Promise<void>
  readonly stash: {
    save(opts?: StashSaveOptions): Promise<void>
    apply(index?: number): Promise<void>
    pop(index?: number): Promise<void>
    drop(index: number): Promise<void>
  }
}

export type GitEvents = {
  readonly [K in keyof GitState & string as `git.${K}.changed`]: {
    readonly current: GitState[K]
    readonly previous: GitState[K]
  }
}

export interface EventMap extends GitEvents {
  "git.refreshed": { readonly state: GitState }
  "app.pane.focused": { readonly paneId: string; readonly previous: string | null }
}

export type EventPayload<K extends keyof EventMap> = EventMap[K] extends void ? [] : [payload: EventMap[K]]

export interface EventBus<TName extends string = string> {
  on<K extends keyof EventMap & string>(event: K, handler: (payload: EventMap[K]) => void | Promise<void>): Disposable
  emit<K extends keyof EventMap & ScopedId<TName>>(event: K, ...payload: EventPayload<K>): void
}

export interface CommandSpec<TName extends string = string> {
  id: ScopedId<TName>
  title: string
  keys?: KeySpec | readonly KeySpec[]
  pane?: string
  hidden?: boolean
  /**
   * Short label for the hint bar — "checkout", not "Check out branch". Its presence is the
   * opt-in; a Command without one is still bound, in the palette and in the cheat sheet. Bar
   * order is registration order, and only the currently live Commands are listed.
   */
  hint?: string
  /**
   * Keep this Command's keys live while its Pane is capturing raw input
   * ({@link useKeyCapture}) — the exit keys of a Pane that owns the keyboard. Ignored, with a
   * logged diagnostic, on a Command with no `pane`.
   */
  capture?: boolean
  /** Omit this Command from every surface while it cannot run. Must be synchronous and side-effect-free. */
  when?(): boolean
  run(): void | Promise<void>
}

export type RowCommandSpec<TName extends string, Row> = Omit<CommandSpec<TName>, "pane" | "when" | "run"> & {
  /** Supplies both the Pane scope and the selected row sampled at dispatch. */
  source: RowSource<Row>
  when?(row: Row): boolean
  run(row: Row): void | Promise<void>
}

export interface CommandHandle extends Disposable {
  /** Re-evaluate this Command's conditional availability. A no-op after disposal. */
  refresh(): void
}

export interface CommandRegistry<TName extends string = string> {
  register<Row>(spec: RowCommandSpec<TName, Row>): CommandHandle
  register(spec: CommandSpec<TName>): CommandHandle
  execute(id: string): Promise<void>
}

export interface PaneProps {
  readonly paneId: string
  readonly focused: boolean
}

export interface PlacementHint {
  column?: number
  order?: number
  tabWith?: string
}

export interface PaneSpec<TName extends string = string> {
  id: ScopedId<TName>
  title: string
  component: ComponentType<PaneProps>
  placement?: PlacementHint
}

export interface PaneHandle extends Disposable {
  focus(): void
  reveal(): void
}

export interface PaneRegistry<TName extends string = string> {
  register(spec: PaneSpec<TName>): PaneHandle
}

export interface Cell<T> {
  get(): T
  set(value: T): void
  use(): T
}

export interface Theme {
  readonly text: string
  readonly textMuted: string
  readonly accent: string
  readonly success: string
  readonly warning: string
  readonly danger: string
  readonly info: string
  /** The Layout canvas. `"transparent"` preserves the terminal's native background. */
  readonly background: string
  /**
   * The raised chrome above {@link background} — popups and the status line. Not a Pane
   * background: a Pane draws on {@link background} like everything else in the Layout.
   */
  readonly backgroundPanel: string
  readonly border: string
  readonly borderFocused: string
  readonly selection: string
  readonly diffAdded: string
  readonly diffRemoved: string
}

export interface PopupMenuItem {
  key: string
  label: string
  when?(): boolean
  run(): void | Promise<void>
}

export interface PopupMenuGroup {
  title?: string
  items: readonly PopupMenuItem[]
}

export interface PopupToolkit {
  confirm(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>
  prompt(opts: {
    title: string
    placeholder?: string
    initial?: string
    validate?(value: string): string | null
  }): Promise<string | undefined>
  compose(opts: {
    title: string
    summaryTitle?: string
    descriptionTitle?: string
    initial?: string
    validate?(value: string): string | null
    onChange?(value: string): void
  }): Promise<string | undefined>
  /** List picker. A filter appears only when its items overflow the visible choices. */
  select<T>(opts: { title: string; items: readonly SelectItem<T>[]; placeholder?: string }): Promise<T | undefined>
  menu(opts: { title: string; groups: readonly PopupMenuGroup[] }): Promise<void>
  notify(message: string, level?: "info" | "success" | "warning" | "error"): void
}

export interface SelectItem<T> {
  label: string
  value: T
  hint?: string
}

export interface StatusSegmentSpec<TName extends string = string> {
  id: ScopedId<TName>
  component: ComponentType
  align?: "left" | "right"
  priority?: number
}

export interface Statusline<TName extends string = string> {
  register(spec: StatusSegmentSpec<TName>): Disposable
}

export interface ExtensionApis {
  branches: BranchesApi
  "remote-branches": RemoteBranchesApi
  "pull-requests": PullRequestsApi
  files: FilesApi
  commits: CommitsApi
  stash: StashApi
  diff: DiffApi
  "commit-flow": CommitFlowApi
}

export interface ExtensionHub<Needs extends readonly NeedName[]> {
  get<Id extends Needs[number] & string>(id: Id): Id extends keyof ExtensionApis ? ExtensionApis[Id] : unknown
}

export interface RowDecoration {
  badge?: string
  tone?: Tone
  dim?: boolean
}

export interface RowDecorationHandle extends Disposable {
  refresh(): void
}

export interface RowSource<Row> {
  /** The Pane whose current selection this source describes. */
  readonly pane: string
  decorateRows(provider: (row: Row) => RowDecoration | undefined): RowDecorationHandle
  selected(): Row | undefined
  /** Subscribe to committed selection changes. The handle is idempotent. */
  subscribeSelection(listener: () => void): Disposable
}

export type BranchesApi = RowSource<Branch>
export type RemoteBranchesApi = RowSource<RemoteBranch>
export type PullRequestsApi = RowSource<PullRequest>
export type FilesApi = RowSource<FileChange>

/** A reusable, read-only commit → changed-files drill-down rendered inside another Pane. */
export interface CommitBrowserProps {
  readonly revision: string
  readonly title: string
  readonly focused: boolean
  /** Command and row id prefix. It must belong to the Extension that owns the containing Pane. */
  readonly idPrefix: string
  readonly onBack: () => void
}

export interface CommitsApi extends RowSource<Commit> {
  /** Render this from a small component owned by the consuming Pane. */
  readonly renderBrowser: (props: CommitBrowserProps) => ReactNode
}
export type StashApi = RowSource<StashEntry>

/**
 * What the diff Pane is showing. `path` narrows any of them to one file. `branch` and `commit`
 * fetch the same patch and differ only in the context line the Pane prints above it.
 */
export type DiffTarget =
  | { readonly kind: "workingTree" | "staged"; readonly path: string | null }
  | { readonly kind: "commit" | "stash" | "branch"; readonly ref: string; readonly path: string | null }

export interface DiffApi {
  current(): DiffTarget | null
  /** Point the diff Pane at a target, or at `null` to say there is nothing to show. */
  show(target: DiffTarget | null): void
  /** Focus the Diff Pane as a marker-side picker for one textual conflict. */
  openConflict?(path: string): Promise<void>
  /** Focus the Diff Pane as a line/hunk staging editor for one ordinary changed file. */
  openStaging?(path: string): Promise<void>
}

export type CommitFlowResult = "committed" | "abandoned"

export interface CommitFlowApi {
  begin(opts?: {
    message?: string
    amend?: boolean
    signoff?: boolean
    skipHooks?: boolean
    messageOnly?: boolean
  }): Promise<CommitFlowResult>
}

export interface GitService {
  readonly raw: (args: readonly string[], options?: RawOptions) => Effect.Effect<GitOutput, GitError>
  readonly state: Effect.Effect<GitState>
  readonly changes: Stream.Stream<GitState>
}

export interface EventsService<TName extends string = string> {
  readonly publish: <K extends keyof EventMap & ScopedId<TName>>(
    event: K,
    ...payload: EventPayload<K>
  ) => Effect.Effect<void>
  readonly stream: <K extends keyof EventMap & string>(event: K) => Stream.Stream<EventMap[K]>
}

export interface EffectEscape<TName extends string = string> {
  readonly git: GitService
  readonly events: EventsService<TName>
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
}
