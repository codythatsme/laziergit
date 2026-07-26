import { createExtensionDefinition } from "@laziergit/runtime-bridge"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { ComponentType } from "react"

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
  readonly menus: MenuRegistry<TName>
  readonly popups: PopupToolkit
  readonly statusline: Statusline<TName>
  readonly extensions: ExtensionHub<Needs>
  readonly effect: EffectEscape<TName>
  readonly signal: AbortSignal
  exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecOutput>
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

export type ConfigValue = string | number | boolean | readonly string[]

export interface ConfigOption<T extends ConfigValue = ConfigValue> {
  readonly kind: "string" | "number" | "boolean" | "enum" | "string-array"
  readonly default: T
  readonly description?: string
}

export type ConfigSchema = Record<string, ConfigOption>
export type ConfigValues<S extends ConfigSchema> = {
  readonly [K in keyof S]: S[K] extends ConfigOption<infer T> ? T : never
}

type NumberConfigOption = ConfigOption<number> & { readonly min?: number; readonly max?: number }
type EnumConfigOption<T extends string> = ConfigOption<T> & { readonly values: readonly T[] }

export const option = {
  string(opts: { default: string; description?: string }): ConfigOption<string> {
    return Object.freeze({ kind: "string", ...opts })
  },
  number(opts: { default: number; description?: string; min?: number; max?: number }): ConfigOption<number> {
    return Object.freeze({ kind: "number", ...opts }) satisfies NumberConfigOption
  },
  boolean(opts: { default: boolean; description?: string }): ConfigOption<boolean> {
    return Object.freeze({ kind: "boolean", ...opts })
  },
  enum<const V extends readonly string[]>(
    values: V,
    opts: { default: V[number]; description?: string },
  ): ConfigOption<V[number]> {
    if (!values.includes(opts.default)) {
      throw new TypeError(`Enum default "${opts.default}" is not one of its declared values`)
    }
    return Object.freeze({ kind: "enum", values: Object.freeze([...values]), ...opts }) satisfies EnumConfigOption<
      V[number]
    >
  },
  stringArray(opts: { default: readonly string[]; description?: string }): ConfigOption<readonly string[]> {
    return Object.freeze({ kind: "string-array", ...opts, default: Object.freeze([...opts.default]) })
  },
}

export interface GitState {
  readonly head: Head
  readonly branches: readonly Branch[]
  readonly remotes: readonly Remote[]
  readonly tags: readonly Tag[]
  readonly status: WorkingTreeStatus
  readonly commits: readonly Commit[]
  readonly stash: readonly StashEntry[]
}

/**
 * Where HEAD points — the three shapes git can produce, plus the one it cannot because
 * there is no repository to ask.
 *
 * A union rather than four independent fields because the fields are not independent: an
 * unborn HEAD has no commit to name, a detached one has no branch and therefore no
 * upstream, and only a branch with a commit behind it can have both. Reading an oid off a
 * repository with no commits, or an upstream off a detached HEAD, is now a type error
 * rather than a `""`.
 */
export type Head =
  /**
   * There is no repository here, so HEAD names nothing. Every other slice of
   * {@link GitState} is empty beside it and every write rejects.
   *
   * Its own variant rather than an unborn HEAD with a nameless branch: laziergit runs
   * wherever the user starts it, so "not a repository" is an ordinary state a Pane renders
   * differently from a fresh `git init`, and a Pane that must tell them apart should not
   * have to know that `""` is not a legal refname to do it.
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
   * divergence, so {@link ahead} and {@link behind} are both 0 here and mean nothing —
   * this flag is the only thing separating a deleted upstream from an in-sync one.
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

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted"

export interface FileChange {
  readonly path: string
  readonly previousPath: string | null
  readonly kind: ChangeKind
}

export interface WorkingTreeStatus {
  readonly staged: readonly FileChange[]
  readonly unstaged: readonly FileChange[]
  readonly untracked: readonly FileChange[]
  readonly conflicted: readonly FileChange[]
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
  raw(args: readonly string[], options?: RawOptions): Promise<GitOutput>
  checkout(ref: string): Promise<void>
  createBranch(name: string, opts?: { at?: string; checkout?: boolean }): Promise<void>
  deleteBranch(name: string, opts?: { force?: boolean }): Promise<void>
  stage(paths: readonly string[] | "all"): Promise<void>
  unstage(paths: readonly string[] | "all"): Promise<void>
  discard(paths: readonly string[]): Promise<void>
  commit(message: string, opts?: { amend?: boolean; allowEmpty?: boolean; signoff?: boolean }): Promise<void>
  push(opts?: { remote?: string; ref?: string; force?: boolean | "with-lease"; setUpstream?: boolean }): Promise<void>
  pull(opts?: { rebase?: boolean }): Promise<void>
  fetch(opts?: { remote?: string; prune?: boolean }): Promise<void>
  readonly stash: {
    save(opts?: { message?: string; includeUntracked?: boolean; keepIndex?: boolean }): Promise<void>
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
   * Short label for the hint bar — "checkout", not "Check out branch". Its *presence* is
   * the opt-in: a Command without one is still bound, still in the palette, still in the
   * cheat sheet, and simply stays off the bar. Bar order is registration order, and only
   * the Commands live right now are listed, so a Pane's bar is what that Pane can do.
   */
  hint?: string
  /**
   * Keep this Command's keys live while its Pane is capturing raw input
   * ({@link useKeyCapture}) — the exit keys of a Pane that owns the keyboard, `mod+s` to
   * submit and `escape` to cancel. Capture is a property of a Pane's keyboard, so this is
   * ignored (with a logged diagnostic) on a Command with no `pane`; inside a Pane
   * component {@link useCommand} supplies the Pane for you.
   */
  capture?: boolean
  run(): void | Promise<void>
}

export interface CommandRegistry<TName extends string = string> {
  register(spec: CommandSpec<TName>): Disposable
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
  readonly background: string
  /**
   * The raised chrome that sits *above* {@link background} — popups and the status line.
   *
   * Not a Pane background, despite the name: a Pane draws on {@link background} like
   * everything else in the Layout, and "panel" here means the lifted surface, not the
   * CONTEXT.md sense of the word. Renaming it is a breaking change to every user theme, so
   * the name stays and this says what it means.
   */
  readonly backgroundPanel: string
  readonly border: string
  readonly borderFocused: string
  readonly selection: string
  readonly diffAdded: string
  readonly diffRemoved: string
  readonly diffHunkHeader: string
}

export interface MenuMap {
  "branches.actions": Branch
  "files.actions": FileChange
  "commits.actions": Commit
  "stash.actions": StashEntry
  "commit-flow.actions": WorkingTreeStatus
  "sync.actions": GitState
  "diff.actions": DiffTarget
}

export interface MenuItem<Target> {
  key: string
  label: string
  when?(target: Target): boolean
  run(target: Target): void | Promise<void>
}

export interface MenuGroup<Target> {
  id?: string
  title?: string
  items: readonly MenuItem<Target>[]
}

export interface MenuSpec<Id extends keyof MenuMap & string> {
  id: Id
  title: string | ((target: MenuMap[Id]) => string)
  groups: readonly MenuGroup<MenuMap[Id]>[]
}

export interface MenuRegistry<TName extends string = string> {
  register<Id extends keyof MenuMap & ScopedId<TName>>(spec: MenuSpec<Id>): Disposable
  extend<Id extends keyof MenuMap & string>(
    id: Id,
    splice: { group?: string; items: readonly MenuItem<MenuMap[Id]>[] },
  ): Disposable
  open<Id extends keyof MenuMap & string>(id: Id, target: MenuMap[Id]): Promise<void>
}

export interface PopupToolkit {
  confirm(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>
  prompt(opts: {
    title: string
    placeholder?: string
    initial?: string
    validate?(value: string): string | null
  }): Promise<string | undefined>
  select<T>(opts: { title: string; items: readonly SelectItem<T>[]; placeholder?: string }): Promise<T | undefined>
  menu(opts: { title: string; groups: readonly MenuGroup<void>[] }): Promise<void>
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
  decorateRows(provider: (row: Row) => RowDecoration | undefined): RowDecorationHandle
  selected(): Row | undefined
}

export type BranchesApi = RowSource<Branch>
export type FilesApi = RowSource<FileChange>
export type CommitsApi = RowSource<Commit>
export type StashApi = RowSource<StashEntry>

/**
 * What the diff Pane is showing, as the two shapes that differ in whether they name a ref.
 *
 * A union rather than a flat record with a nullable `ref`, because `{ kind: "commit", ref:
 * null }` was representable and meant nothing: the diff Pane had to carry a runtime branch
 * for a state no caller could sensibly build. `path` narrows any of them to one file.
 *
 * `branch` and `commit` fetch the same patch — a branch name is a ref like any other — and
 * differ only in the context the Pane prints above it. That difference is the whole point:
 * a Pane whose rows are clipped to one line needs somewhere to show the name in full, and
 * `{ kind: "commit", ref: tip }` can only ever name the commit.
 */
export type DiffTarget =
  | { readonly kind: "workingTree" | "staged"; readonly path: string | null }
  | { readonly kind: "commit" | "stash" | "branch"; readonly ref: string; readonly path: string | null }

export interface DiffApi {
  current(): DiffTarget | null
  /**
   * Point the diff Pane at a target, or at `null` to say there is nothing to show — a list
   * Pane whose rows just went away needs the second as much as the first, and `current()`
   * could already return it.
   */
  show(target: DiffTarget | null): void
}

/** How a commit flow ended, for a caller that composed the message it handed over. */
export type CommitFlowResult = "committed" | "abandoned"

export interface CommitFlowApi {
  begin(opts?: { message?: string; amend?: boolean; signoff?: boolean }): Promise<CommitFlowResult>
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
