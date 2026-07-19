# laziergit public API — the `"laziergit"` module

**Method note.** This surface was derived backwards (after a three-draft judged synthesis —
see PLAN.md) from a corpus of eight worked extensions
(open-remote, branch-age, ci-status, conventional-commit, stash-preview, gh-workflows,
github-prs, and a push-guard interceptor experiment that was ultimately cut — see §5.11): the
API below is what made them shortest and most obvious. Every mini-extension appears in §0 and
§4 (the two flagship examples, fully worked, in §2–§3), so the doc doubles as the example
corpus an agent learns from.

---

## 0. Orientation (what an extension is)

An Extension is one `.ts`/`.tsx` file (or a directory with `package.json`) in
`~/.config/laziergit/extensions/` or `<repo>/.laziergit/extensions/`, whose **default export is
`defineExtension({...})`**. No build step; Bun imports it directly. (Bundled Extensions are the
same shape, shipped inside the distribution rather than these directories.)

**The entire surface an author must learn:**

| Area | Surface |
|---|---|
| Entry point | `defineExtension()` — one function, six fields |
| `ctx` | eleven members — `config` · `git` · `events` · `commands` · `panes` · `menus` · `popups` · `statusline` · `extensions` · `effect` · `signal` — plus three methods: `exec()`, `open()`, `onDispose()` |
| React hooks | `useGit`, `useEvent`, `useCommand`, `useTheme` — 4 hooks (plus `createCell` for activate → component data) |
| Augmentable registries | `ExtensionApis`, `EventMap`, `MenuMap` — 3 interfaces, one pattern |
| Everything else | plain data types |

**One naming rule instead of many:** every id an extension registers — panes, commands, menus,
status segments, custom events — must be its own name or its name followed by a dot
(`"gh-workflows"`, `"gh-workflows.refresh"`). This single rule replaces per-feature namespacing,
collision handling, and "who owns what" questions — and it is a **compile-time guarantee**, not
a convention: `defineExtension` threads your literal `name` type into `ctx`, and every
registration id is typed `ScopedId<TName>` (§1.1). The one exception is `useCommand`, whose id
is runtime-checked — a hook can't see your name type (§1.8). Any extension may *reference* any id.

Extensions import the entire API from the single specifier **`"laziergit"`** — a host-provided
virtual module (via OpenTUI's `ensureRuntimePluginSupport({ additional })`), so extension code
resolves against the host's React and OpenTUI instances. Three import rules:

- `import { defineExtension, useGit, ... } from "laziergit"` — the whole public API.
- `import { useState } from "react"` — host React 19 (host-resolved, never double-loaded).
- JSX intrinsics (`<box>`, `<text>`, `<scrollbox>`, `<select>`, `<diff>`, `<code>`, ...) come
  from `@opentui/react`; put `/** @jsxImportSource @opentui/react */` at the top of `.tsx`
  files (or set `"jsxImportSource": "@opentui/react"` in a directory extension's tsconfig).
  laziergit does not re-export UI primitives — OpenTUI's component set *is* the component set
  (quick reference in §1.8).

**Directory form.** A directory extension is a folder with a `package.json`; the entry point is
its `main` field (default `index.ts`, then `index.tsx`). It may carry its own `node_modules` —
Bun installs and resolves local dependencies normally — but `laziergit`, `react`,
`react/jsx-runtime`, `@opentui/react`, and `@opentui/core` always resolve to the host's
instances regardless of what is installed locally (the runtime module hooks match those exact
specifiers for every importer), so a locally installed React can never fork the tree. Name
collisions: a repo extension shadows a same-named global extension (repo wins, diagnostic
logged — the same precedence as config); two same-named extensions in the same scope are a load
error for the second.

The smallest complete extension (a palette command that opens the repo on GitHub):

```ts
// ~/.config/laziergit/extensions/open-remote.ts
import { defineExtension } from "laziergit";

export default defineExtension({
  name: "open-remote",
  description: "Open the current repo on its web remote",
  activate(ctx) {
    ctx.commands.register({
      id: "open-remote.open",
      title: "Open repository in browser",
      keys: "go",
      run: async () => {
        const url = ctx.git.state.remotes[0]?.fetchUrl
          .replace(/^git@(.+?):/, "https://$1/")
          .replace(/\.git$/, "");
        if (url) await ctx.open(url); // cross-platform: open / xdg-open / start
        else ctx.popups.notify("No remote configured", "warning");
      },
    });
  },
});
```

That is the entire lifecycle: `activate(ctx)` runs once, every registration made through `ctx`
is tracked, and on hot reload / disable everything is disposed automatically. There is nothing
to clean up by hand unless you created it by hand (see `ctx.onDispose`).

---

## 1. The complete `"laziergit"` module surface

Everything below lives inside a single ambient module. Written as one continuous declaration,
split into commented sections for reading.

```ts
declare module "laziergit" {
  import type { ComponentType } from "react";
  import type * as Effect from "effect/Effect";
  import type * as Stream from "effect/Stream";
  import type { ManagedRuntime, Context } from "effect"; // effect 4.0.0-beta: Context.Key is the v3 Context.Tag rename
```

### 1.1 Primitives

```ts
  /**
   * Handle for anything registered through the API.
   *
   * You normally never call `dispose()`: every registration made through `ctx`
   * (or through another extension's exported API) is automatically attached to
   * your extension's scope and disposed when your extension deactivates or hot
   * reloads. Keep the handle only if you want to unregister *earlier* than that.
   */
  export interface Disposable {
    /**
     * Unregister now instead of waiting for extension deactivation. Idempotent,
     * and a guaranteed no-op (never a throw) on a handle whose extension has
     * already deactivated — cleanup paths are never punished for running late.
     */
    dispose(): void;
  }

  /**
   * Thrown on every property ACCESS of a stale `ctx` — or of any live API
   * object it handed out (`ctx.git`, registries, handles, consumed extension
   * APIs). A ctx goes stale the moment its activation ends. Poisoning is
   * uniform over members, not just methods, so `ctx.git.state` and
   * `ctx.config` are covered too; plain data you already extracted (a
   * `GitState` snapshot, destructured config values) is inert and stays
   * readable. You can only hit this from code resumed OUTSIDE the ctx promise
   * graph — a timer you didn't clear, a raw fetch/`Bun.$` continuation —
   * because every promise a ctx member returns simply never settles after
   * deactivation (§5.3, "the async tail"). Probe
   * {@link ExtensionContext.signal} (exempt from poisoning) before touching
   * ctx from such code. The stale no-op set — {@link Disposable.dispose} and
   * {@link RowDecorationHandle.refresh} — never throws: both mean "do
   * something to my registration", and the correct answer for a dead
   * registration is "nothing". Re-entering through `activate()` always
   * yields a fresh, live ctx.
   */
  export class StaleContextError extends Error {
    /** Name of the extension whose context went stale. */
    readonly extension: string;
    /** Why the context was invalidated. */
    readonly reason: "reload" | "deactivated" | "quit";
  }

  /**
   * Every id an extension registers must be its own name, or its name followed
   * by a dot: `"gh-workflows"` or `"gh-workflows.refresh"`. `defineExtension`
   * threads your literal name type into `ctx`, so a mis-prefixed id is a
   * COMPILE error (and cross-extension id collisions are unrepresentable).
   * Also enforced at runtime for ids built dynamically.
   */
  export type ScopedId<TName extends string> = TName | `${TName}.${string}`;

  /**
   * Semantic emphasis for small pieces of UI the core renders for you
   * (row decoration badges). The active theme maps each tone to a color;
   * extensions never pick raw colors for these.
   */
  export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

  /**
   * A key or key sequence in @opentui/keymap grammar:
   *
   * - single strokes: `"c"`, `"D"` (shift implied), `"ctrl+r"`, `"escape"`, `"enter"`, `"tab"`
   * - platform-aware modifier: `"mod+p"` — ctrl everywhere, upgraded to cmd on
   *   macOS terminals whose keyboard protocol can report it (kitty keyboard
   *   protocol); elsewhere on macOS it stays ctrl
   * - multi-key sequences, concatenated: `"gg"`, `"dd"`, `"go"` — but named keys win over
   *   concatenation: a spelling that begins with a named key (`"gt"`, `"up"`, `"f5"`)
   *   parses as that single named stroke, not a sequence
   * - leader sequences: `"<leader>p"` (leader key set in user config)
   *
   * These are *default* bindings. Users can rebind or unbind any command in
   * config.jsonc (`keybindings: { "<command id>": "keys" | null }`); the config
   * value always wins. Conflicting defaults log a diagnostic; last registration wins.
   */
  export type KeySpec = string;
```

### 1.2 Extension anatomy — `defineExtension`

```ts
  /**
   * A `needs` entry: a known extension name (autocompleted from
   * {@link ExtensionApis}) or any other extension name.
   */
  export type NeedName = (keyof ExtensionApis & string) | (string & {});

  /**
   * Declares an extension. Must be the module's default export.
   *
   * All type information flows from this one literal:
   * - `name`           → the `ScopedId` prefix every registration id must carry
   * - `config` schema  → the type of `ctx.config`
   * - `needs` tuple    → which ids `ctx.extensions.get()` accepts, and their API types
   * - `activate`'s return value → the API other extensions get from `ctx.extensions.get("<name>")`
   *
   * No type parameters are ever written at the call site.
   */
  export function defineExtension<
    const TName extends string,
    const Config extends ConfigSchema = Record<never, never>,
    const Needs extends readonly NeedName[] = readonly [],
    Api = void,
  >(spec: ExtensionSpec<TName, Config, Needs, Api>): Extension<TName, Config, Needs, Api>;

  export interface ExtensionSpec<
    TName extends string,
    Config extends ConfigSchema,
    Needs extends readonly NeedName[],
    Api,
  > {
    /**
     * Unique id, lowercase kebab-case matching /^[a-z][a-z0-9-]*$/
     * ("git" and "app" are reserved for core event namespaces). Used as:
     * the config section key in config.jsonc, the required prefix of every id
     * you register (commands, panes, menus, segments, custom events), and the
     * key in {@link ExtensionApis}. A repo-scope extension shadows a
     * same-named global one; a same-scope collision is a load error (§5.3).
     */
    name: TName;

    /** One line shown in the extension list and docs tooling. */
    description?: string;

    /**
     * Config options this extension reads, built with {@link option}.
     * Compiled to JSON Schema for validation and config.jsonc autocomplete.
     * Values arrive fully typed and defaulted on `ctx.config`.
     */
    config?: Config;

    /**
     * Extensions this one requires, by name. Guarantees they activate first,
     * deactivate after you, restart you around their hot reloads (§5.3), and
     * makes `ctx.extensions.get(<id>)` legal (and typed) for exactly these ids.
     * Activation fails with a clear error if a need is missing or failed, and
     * `needs` must be acyclic: a cycle fails activation of every extension in
     * it with an error naming the cycle (never a hang). Needed only for API
     * access — menu splices, pane-scoped bindings, and event subscriptions
     * are name-keyed and need no declaration (§5.3).
     */
    needs?: Needs;

    /**
     * Called once when the extension loads (and again after every hot reload).
     * Register everything here. The return value (if any) becomes this
     * extension's exported API — the object other extensions receive from
     * `ctx.extensions.get("<name>")`. Returning it from `activate` lets the API
     * close over live state; see {@link ExtensionApiOf} for how consumers get its type.
     */
    activate(ctx: ExtensionContext<TName, Config, Needs>): Api | Promise<Api>;

    /**
     * Optional teardown for resources NOT created through `ctx` (rare — timers
     * and sockets are better handled with `ctx.onDispose`). Runs with `ctx`
     * still live, before the automatic disposal of everything registered
     * through it.
     */
    deactivate?(): void | Promise<void>;
  }

  /** The value produced by {@link defineExtension}. Opaque to authors; useful for typeof. */
  export interface Extension<
    TName extends string = string,
    Config extends ConfigSchema = ConfigSchema,
    Needs extends readonly NeedName[] = readonly NeedName[],
    Api = unknown,
  > {
    readonly spec: ExtensionSpec<TName, Config, Needs, Api>;
  }

  /**
   * Extracts an extension's exported API type from its `typeof` — used when
   * publishing your API for other extensions (see design note §5.4):
   *
   * ```ts
   * const extension = defineExtension({ ... activate: () => ({ prFor(b: string) {...} }) });
   * export default extension;
   * declare module "laziergit" {
   *   interface ExtensionApis { "github-prs": ExtensionApiOf<typeof extension> }
   * }
   * ```
   */
  export type ExtensionApiOf<E> =
    E extends Extension<infer _N, infer _C, infer _D, infer Api> ? Awaited<Api> : never;
```

### 1.3 The Extension Context (`ctx`)

```ts
  /**
   * The entire API surface handed to `activate`. Everything is scoped to your
   * extension: registrations are auto-disposed on deactivate/reload, and after
   * a reload the *old* ctx is poisoned — every member access throws
   * {@link StaleContextError}, except `signal`, the liveness probe. Every
   * promise a ctx member returns is scope-supervised: if your extension
   * deactivates before it settles, it never settles — the chain is abandoned
   * at its `await`, like the interrupted fiber it internally is, so
   * fire-and-forget async can never trip over a reload (§5.3).
   */
  export interface ExtensionContext<
    TName extends string = string,
    Config extends ConfigSchema = Record<never, never>,
    Needs extends readonly NeedName[] = readonly [],
  > {
    /**
     * Typed, validated, defaulted config values (global config.jsonc merged with
     * the repo's, then validated against your schema; invalid values fall back
     * to their defaults with a logged diagnostic — bad config never blocks
     * activation). A constant snapshot for this activation: editing config
     * triggers a hot reload, so you never watch it.
     */
    readonly config: ConfigValues<Config>;

    /** The reactive git store and git plumbing. */
    readonly git: Git;

    /** Typed event bus: core git/app events plus namespaced custom events. */
    readonly events: EventBus<TName>;

    /** Commands: the unit behind keybindings, the palette, and the cheat sheet. */
    readonly commands: CommandRegistry<TName>;

    /** Register panes (React components placed by the user's Layout). */
    readonly panes: PaneRegistry<TName>;

    /** Data-driven, keyboard-first menus that other extensions can splice into. */
    readonly menus: MenuRegistry<TName>;

    /** Modal toolkit: confirm / prompt / select / menu / notify. */
    readonly popups: PopupToolkit;

    /** Status line segments (small React components). */
    readonly statusline: Statusline<TName>;

    /** Typed access to other extensions' exported APIs (gated by `needs`). */
    readonly extensions: ExtensionHub<Needs>;

    /** Escape hatch into the Effect-native core. Never needed for normal extensions. */
    readonly effect: EffectEscape;

    /**
     * Aborted when this activation ends (reload / disable / quit). The
     * liveness probe for code resumed by non-laziergit promises (raw fetch,
     * `Bun.$`, a timer you manage yourself): check `signal.aborted` before
     * touching ctx, or pass it to APIs that accept one. Exempt from
     * poisoning — always readable, even on a stale ctx.
     */
    readonly signal: AbortSignal;

    /**
     * Run an external program (gh, delta, ...). Resolves with the outcome
     * whatever the exit code — check `exitCode` yourself. Rejects only if the
     * program cannot be spawned or exceeds `timeoutMs`. cwd defaults to the
     * repo root — the one correctness default `Bun.$` can't give you (§5.11).
     * If your extension deactivates first, the child process is killed and
     * the promise never settles (§5.3).
     */
    exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecOutput>;

    /**
     * Open a URL (or file path) with the user's default handler — the
     * cross-platform "open in browser" (`open` / `xdg-open` / `start`,
     * resolved per platform so extensions never hardcode one).
     */
    open(url: string): Promise<void>;

    /**
     * Register cleanup for resources created outside `ctx` (timers, sockets,
     * watchers). Runs on deactivate/hot-reload, after `deactivate()`.
     */
    onDispose(fn: () => void | Promise<void>): void;
  }

  /** Options for {@link ExtensionContext.exec}. */
  export interface ExecOptions {
    /** Working directory. Defaults to the repository root. */
    cwd?: string;
    /** Extra environment variables merged over the host environment. */
    env?: Record<string, string>;
    /** Text piped to stdin. */
    stdin?: string;
    /** Kill the process and reject after this many milliseconds. */
    timeoutMs?: number;
  }

  /** Result of {@link ExtensionContext.exec}. */
  export interface ExecOutput {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }
```

There is deliberately no `ctx.log`: `console.*` inside an extension is captured by the host,
tagged with the extension name, and routed to the log file / debug pane.

### 1.4 Config schema → typed values

```ts
  /** A config value an extension can declare. v1 is deliberately flat. */
  export type ConfigValue = string | number | boolean | readonly string[];

  /**
   * One declared config option. Every option MUST have a default, so extensions
   * always work with zero configuration and `ctx.config` is total (no undefined
   * anywhere). Descriptions surface in config.jsonc autocomplete.
   */
  export interface ConfigOption<T extends ConfigValue = ConfigValue> {
    readonly kind: "string" | "number" | "boolean" | "enum" | "string-array";
    readonly default: T;
    readonly description?: string;
  }

  /** An extension's config schema: option name → option. */
  export type ConfigSchema = Record<string, ConfigOption>;

  /** Maps a schema to the runtime value type of `ctx.config`. */
  export type ConfigValues<S extends ConfigSchema> = {
    readonly [K in keyof S]: S[K] extends ConfigOption<infer T> ? T : never;
  };

  /**
   * Config option builders. Compiled to JSON Schema internally; typed values
   * come out on `ctx.config` with zero generics at the use site:
   *
   * ```ts
   * config: {
   *   limit: option.number({ default: 15, min: 1, max: 100, description: "Max runs" }),
   *   view:  option.enum(["unified", "split"], { default: "unified" }),
   * }
   * // ctx.config.limit: number      ctx.config.view: "unified" | "split"
   * ```
   */
  export const option: {
    string(opts: { default: string; description?: string }): ConfigOption<string>;
    number(opts: {
      default: number;
      description?: string;
      min?: number;
      max?: number;
    }): ConfigOption<number>;
    boolean(opts: { default: boolean; description?: string }): ConfigOption<boolean>;
    enum<const V extends readonly string[]>(
      values: V,
      opts: { default: V[number]; description?: string },
    ): ConfigOption<V[number]>;
    stringArray(opts: {
      default: readonly string[];
      description?: string;
    }): ConfigOption<readonly string[]>;
  };
```

### 1.5 Git — the reactive store, plumbing, and porcelain

```ts
  /**
   * Snapshot of everything laziergit knows about the repository. Core refreshes
   * it after every write issued through `ctx.git`, on a cheap ~2s repo-fingerprint
   * poll (`git for-each-ref` + `.git/HEAD` — no fs-watching), and on focus regain. Always present — core loads it before extensions
   * activate. Unchanged slices keep referential identity across refreshes,
   * which is what makes `useGit` selectors cheap.
   *
   * Every slice of this interface is also an event: the core event map derives
   * `git.<slice>.changed` from these keys by mapped type (§1.6) — the event
   * vocabulary structurally cannot drift from the store shape.
   */
  export interface GitState {
    readonly head: Head;
    /** Local branches, HEAD first, then most-recently-committed first. */
    readonly branches: readonly Branch[];
    readonly remotes: readonly Remote[];
    readonly tags: readonly Tag[];
    readonly status: WorkingTreeStatus;
    /** Recent history of HEAD (windowed; page deeper via `git.raw(["log", ...])`). */
    readonly commits: readonly Commit[];
    readonly stash: readonly StashEntry[];
  }

  export interface Head {
    readonly oid: string;
    /** Current branch name, or null when detached. */
    readonly branch: string | null;
    readonly detached: boolean;
    readonly upstream: UpstreamInfo | null;
  }

  export interface UpstreamInfo {
    readonly remote: string;
    readonly branch: string;
    readonly ahead: number;
    readonly behind: number;
  }

  export interface Branch {
    readonly name: string;
    readonly oid: string;
    readonly isHead: boolean;
    readonly upstream: UpstreamInfo | null;
    readonly lastCommit: CommitSummary;
  }

  export interface CommitSummary {
    readonly oid: string;
    readonly subject: string;
    /** Author date, epoch ms. */
    readonly authoredAt: number;
  }

  export interface Commit {
    readonly oid: string;
    readonly shortOid: string;
    readonly subject: string;
    readonly author: { readonly name: string; readonly email: string };
    /** Author date, epoch ms. */
    readonly authoredAt: number;
    readonly parents: readonly string[];
  }

  export type ChangeKind =
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "typechange"
    | "untracked"
    | "conflicted";

  export interface FileChange {
    /** Path relative to the repo root. */
    readonly path: string;
    /** Original path for renames/copies, otherwise null. */
    readonly previousPath: string | null;
    readonly kind: ChangeKind;
  }

  export interface WorkingTreeStatus {
    readonly staged: readonly FileChange[];
    readonly unstaged: readonly FileChange[];
    readonly untracked: readonly FileChange[];
    readonly conflicted: readonly FileChange[];
    readonly isClean: boolean;
  }

  export interface StashEntry {
    /** Position in the stash list (stash@{index}). */
    readonly index: number;
    readonly oid: string;
    readonly message: string;
    /** Branch the stash was created on, when recorded. */
    readonly branch: string | null;
    readonly createdAt: number;
  }

  export interface Remote {
    readonly name: string;
    readonly fetchUrl: string;
    readonly pushUrl: string;
  }

  export interface Tag {
    readonly name: string;
    readonly oid: string;
  }

  /** Output of a raw git invocation. */
  export interface GitOutput {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }

  export interface RawOptions {
    /** Text piped to git's stdin (e.g. a patch for `apply --cached`). */
    stdin?: string;
    /** Resolve with a nonzero-exit GitOutput instead of throwing {@link GitError}. */
    allowFailure?: boolean;
  }

  /** Thrown when a git invocation exits nonzero (unless `allowFailure`). */
  export class GitError extends Error {
    readonly args: readonly string[];
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  /**
   * All git access. Reads come from the reactive store; writes go through
   * porcelain helpers (which refresh the store) or `raw`. Writes started
   * while your extension is live always run to completion (repo integrity);
   * if you deactivate mid-flight, only the promise is parked (§5.3).
   */
  export interface Git {
    /** Absolute path of the repository root (constant for the session). */
    readonly root: string;

    /** Current snapshot. In React components prefer {@link useGit}. */
    readonly state: GitState;

    /**
     * Observe a slice of the store outside React (decoration caches, exported
     * APIs). `onChange` fires when the selected value changes (Object.is).
     * For React components use {@link useGit} instead.
     */
    subscribe<T>(
      selector: (state: GitState) => T,
      onChange: (value: T, previous: T) => void,
    ): Disposable;

    /** Force a store refresh (e.g. after `exec`-ing something that touched the repo). */
    refresh(): Promise<void>;

    /**
     * Run git with explicit argv (never through a shell). The escape hatch for
     * everything without a helper. Throws {@link GitError} on nonzero exit
     * unless `allowFailure`. Mutating subcommands trigger a store refresh,
     * same as the helpers.
     */
    raw(args: readonly string[], options?: RawOptions): Promise<GitOutput>;

    // ---- Porcelain helpers -------------------------------------------------
    // The curated write set the Bundled Extensions are built on. Each helper
    // encodes the safe flag handling, throws GitError on failure, and
    // refreshes the store. Everything else: `raw`.

    /** Check out a branch, tag, or commit. */
    checkout(ref: string): Promise<void>;

    /** Create a branch at `at` (default HEAD), optionally checking it out. */
    createBranch(name: string, opts?: { at?: string; checkout?: boolean }): Promise<void>;

    /** Delete a local branch (`-d`, or `-D` with `force`). */
    deleteBranch(name: string, opts?: { force?: boolean }): Promise<void>;

    /** Stage the given paths, or everything (`"all"`). */
    stage(paths: readonly string[] | "all"): Promise<void>;

    /** Unstage the given paths, or everything (`"all"`). */
    unstage(paths: readonly string[] | "all"): Promise<void>;

    /** Discard working-tree changes to the given paths (checkout/clean). Destructive. */
    discard(paths: readonly string[]): Promise<void>;

    /** Create a commit from the index. */
    commit(
      message: string,
      opts?: { amend?: boolean; allowEmpty?: boolean; signoff?: boolean },
    ): Promise<void>;

    /** Push HEAD (or `ref`). `force: "with-lease"` is the only force most extensions should use. */
    push(opts?: {
      remote?: string;
      ref?: string;
      force?: boolean | "with-lease";
      setUpstream?: boolean;
    }): Promise<void>;

    /** Pull the current branch's upstream. */
    pull(opts?: { rebase?: boolean }): Promise<void>;

    /** Fetch a remote (default: all remotes). */
    fetch(opts?: { remote?: string; prune?: boolean }): Promise<void>;

    /** Stash porcelain, mirroring `git stash <verb>`. */
    readonly stash: {
      save(opts?: { message?: string; includeUntracked?: boolean; keepIndex?: boolean }): Promise<void>;
      apply(index?: number): Promise<void>;
      pop(index?: number): Promise<void>;
      drop(index: number): Promise<void>;
    };
  }
```

### 1.6 Events

```ts
  /**
   * Core git events, DERIVED from the store shape by mapped type: one event
   * per {@link GitState} slice, named `git.<slice>.changed`. "Events derive
   * from the same store" is therefore not documentation — it is the type
   * definition, and the event vocabulary can never drift from the store.
   * Payloads carry the new and previous slice (identity-stable when unchanged).
   */
  export type GitEvents = {
    readonly [K in keyof GitState & string as `git.${K}.changed`]: {
      readonly current: GitState[K];
      readonly previous: GitState[K];
    };
  };

  /**
   * The typed event map. Core events (the derived {@link GitEvents} plus the
   * entries below) are emitted only by core. Extensions add their own events
   * by augmenting this interface with names under their own id prefix —
   * `"<extension-name>.<event>"`, same separator as every other id. Use `void`
   * for signal-only events (zero-argument emit):
   *
   * ```ts
   * declare module "laziergit" {
   *   interface EventMap { "gh-workflows.refresh": void }
   * }
   * ```
   */
  export interface EventMap extends GitEvents {
    /** Fired after every store refresh cycle, whether or not anything changed. */
    "git.refreshed": { readonly state: GitState };
    /** Pane focus moved. */
    "app.pane.focused": { readonly paneId: string; readonly previous: string | null };
  }

  /** void-payload events are emitted with no second argument. */
  export type EventPayload<K extends keyof EventMap> =
    EventMap[K] extends void ? [] : [payload: EventMap[K]];

  /**
   * Pub/sub over {@link EventMap}. Handler errors are caught, logged, and never
   * break other subscribers. Subscriptions auto-dispose with your extension.
   */
  export interface EventBus<TName extends string = string> {
    /**
     * Subscribe. The payload type is inferred from the event name.
     * Subscriptions are keyed by NAME, so listening to another extension's
     * custom event needs no `needs` declaration and survives the emitter's
     * reloads — it just goes quiet while the emitter is down.
     */
    on<K extends keyof EventMap & string>(
      event: K,
      handler: (payload: EventMap[K]) => void | Promise<void>,
    ): Disposable;

    /**
     * Emit one of YOUR events. The name is typed `ScopedId` over your extension
     * name, so emitting a core event ("git.head.changed") or another
     * extension's event is a COMPILE error — and rejected at runtime for
     * dynamically-built names. No extension can spoof core events.
     */
    emit<K extends keyof EventMap & ScopedId<TName>>(event: K, ...payload: EventPayload<K>): void;
  }
```

### 1.7 Commands, keybindings, palette

```ts
  /**
   * A Command is the single unit behind keybindings, the command palette, and
   * the cheat sheet ("?"). Registering one thing gives you all three.
   */
  export interface CommandSpec<TName extends string = string> {
    /** Unique id, compile-checked to start with your extension name ("gh-workflows.refresh"). */
    id: ScopedId<TName>;
    /** Human label — palette row and cheat-sheet text. */
    title: string;
    /** Default binding(s). Users override per-command in config. Omit for palette-only. */
    keys?: KeySpec | readonly KeySpec[];
    /**
     * Bind `keys` only while this pane is focused (any pane id, yours or
     * another extension's — keyed by pane ID, not pane instance, so the
     * binding goes inert while that pane is unmounted and reattaches when the
     * id returns, across the owner's reloads, with no `needs` declaration).
     * Pane-scoped commands still appear in the palette; running one from the
     * palette or `execute()` focuses the pane first, then runs
     * (focus-then-run). While the pane has no live instance, the palette
     * omits the entry and `execute()` rejects. Omit `pane` for a global
     * binding. Inside a pane component prefer {@link useCommand}, which
     * scopes to the enclosing pane automatically.
     */
    pane?: string;
    /** Hide from the palette (still bindable & in the cheat sheet). For j/k-style motions. */
    hidden?: boolean;
    /** The action. Errors are caught, logged, and surfaced as a notification. */
    run(): void | Promise<void>;
  }

  export interface CommandRegistry<TName extends string = string> {
    /** Register a command (keybinding + palette entry + cheat-sheet row in one). */
    register(spec: CommandSpec<TName>): Disposable;

    /**
     * Invoke any registered command by id — yours or another extension's.
     * Pane-scoped commands focus their pane first (focus-then-run). Rejects
     * if the id is unknown, or if a pane-scoped command's pane has no live
     * instance right now.
     */
    execute(id: string): Promise<void>;
  }
```

### 1.8 Panes and the React surface

```ts
  /** Props laziergit passes to every pane component. */
  export interface PaneProps {
    /** The registered pane id. */
    readonly paneId: string;
    /** True while this pane has keyboard focus (drive your selection highlight from this). */
    readonly focused: boolean;
  }

  /**
   * Placement HINT for panes. The user's Layout in config.jsonc always wins;
   * the hint only decides where the pane lands when config doesn't mention it.
   */
  export interface PlacementHint {
    /** Preferred column index (0 = leftmost sidebar column). */
    column?: number;
    /** Sort order within the column (lower = higher). */
    order?: number;
    /** Prefer joining the tab group of this pane id instead of taking its own cell. */
    tabWith?: string;
  }

  export interface PaneSpec<TName extends string = string> {
    /** Unique pane id, referenced by the Layout config and `CommandSpec.pane`. */
    id: ScopedId<TName>;
    /** Title rendered in the pane's border/tab. */
    title: string;
    /**
     * The pane body. Rendered inside an error boundary: if it throws, only this
     * pane shows an error card; the app keeps running. Define it inside
     * `activate` so it closes over `ctx` — a fresh component identity per
     * activation is exactly what hot reload wants (clean remount).
     */
    component: ComponentType<PaneProps>;
    placement?: PlacementHint;
  }

  export interface PaneHandle extends Disposable {
    /** Give this pane keyboard focus and reveal it (switching tabs if needed). */
    focus(): void;
  }

  export interface PaneRegistry<TName extends string = string> {
    /** Register a pane. The Layout decides whether/where it appears. */
    register(spec: PaneSpec<TName>): PaneHandle;
  }

  // ---- Hooks & cells (hooks callable only inside components you render) -----

  /**
   * Subscribe to a slice of the git store. Re-renders only when the selected
   * value changes (Object.is; pass `isEqual` for derived objects/arrays).
   *
   * ```ts
   * const branch = useGit((s) => s.head.branch);
   * ```
   */
  export function useGit<T>(
    selector: (state: GitState) => T,
    isEqual?: (a: T, b: T) => boolean,
  ): T;

  /**
   * Subscribe to an event while mounted. The latest `handler` is always called —
   * no dependency array or memoization needed.
   */
  export function useEvent<K extends keyof EventMap & string>(
    event: K,
    handler: (payload: EventMap[K]) => void | Promise<void>,
  ): void;

  /**
   * Register a command scoped to the *enclosing pane* for the lifetime of the
   * component. This is how key handlers reach component state (the selected
   * row) without lifting state out of React:
   *
   * ```ts
   * useCommand({ id: "x.open", title: "Open", keys: "o", run: () => open(rows[cursor]) });
   * ```
   * Registered on mount, disposed on unmount; the binding is active only while
   * the pane is focused. The latest render's `run` is always the one invoked
   * (latest-ref, the same guarantee {@link useEvent} makes) — no dependency
   * array or memoization needed; `run: () => open(rows[cursor])` always sees
   * current state. Commands land in the catalog, so the cheat sheet and
   * palette stay complete — and palette execution is focus-then-run (the pane
   * is focused, then the handler runs), which is how a selection-aware
   * command doubles as a palette entry with no second registration. The id
   * must carry your extension prefix — a hook can't see your name type, so
   * this one id is checked at runtime, not compile time. For global commands,
   * register in `activate` instead.
   */
  export function useCommand(spec: Omit<CommandSpec, "pane">): void;

  /**
   * A tiny reactive cell for bridging activate-scope data into your own
   * components — async results, counters, anything your extension computes
   * outside React. `set` from anywhere (activate, event handlers, timers);
   * `use()` inside any component you render subscribes and re-renders on
   * change; `get()` reads anywhere. Because the cell always holds the latest
   * value, a component that mounts after the data arrived just reads it — no
   * mount-order race, no custom event, no EventMap augmentation:
   *
   * ```ts
   * const prCount = createCell<number | null>(null);   // in activate
   * // after each fetch:          prCount.set(prs.length);
   * // in a statusline segment:   const n = prCount.use();
   * ```
   * Not for git data ({@link useGit}) or cross-extension data (exported APIs,
   * events) — this is intra-extension plumbing.
   */
  export function createCell<T>(initial: T): Cell<T>;

  export interface Cell<T> {
    /** Current value. */
    get(): T;
    /** Replace the value; subscribed components re-render (Object.is skip). */
    set(value: T): void;
    /** React hook: read + subscribe. Call only inside components you render. */
    use(): T;
  }

  /** The active theme's semantic color tokens. */
  export function useTheme(): Theme;

  /**
   * Semantic color tokens (hex strings) resolved from the user's theme config.
   * Use these for fg/bg props so extensions match every theme. Theming is
   * config-only in v1: extensions consume tokens, they don't define themes.
   */
  export interface Theme {
    readonly text: string;
    readonly textMuted: string;
    readonly accent: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
    readonly info: string;
    readonly background: string;
    readonly backgroundPanel: string;
    readonly border: string;
    readonly borderFocused: string;
    /** Background for the selected row in a focused list. */
    readonly selection: string;
    readonly diffAdded: string;
    readonly diffRemoved: string;
    readonly diffHunkHeader: string;
  }
```

**OpenTUI intrinsics quick reference.** Pane and segment components are built from OpenTUI's
JSX intrinsics, fully typed in `@opentui/react` once `jsxImportSource` is set — your editor
autocompletes every prop; this table only orients. The ones the examples lean on:

| Intrinsic | Role | Props you'll reach for |
|---|---|---|
| `<box>` | flex container | `flexDirection`, `flexGrow`, `width`/`height` (fixed columns), `padding`, `gap`, `border` |
| `<text>` | one styled text run | `fg`, `bg` (row highlight); children may include `<span>` |
| `<span>` | inline styled fragment inside `<text>` | `fg`, `bg`, `attributes` |
| `<scrollbox>` | scrollable column for overflow content | scrolling handled for you; size via `width`/`height` |
| `<select>` | focusable list with built-in cursor | `options`, selection styling — or roll your own rows with `useCommand` j/k |
| `<diff>` | syntax-highlighted diff | `diff` (unified text), `view` (`"unified"` / `"split"`), `filetype` (per-language tree-sitter highlighting) |
| `<code>` | highlighted source block | `content`, `filetype` |

Anything past this table — truncation, alignment, borders — is a prop on these same
intrinsics; the authority is `@opentui/react`'s JSX types, not this document.

### 1.9 Menus — data, so anyone can splice

```ts
  /**
   * Menu id → the target value a menu is opened *for* (the selected row).
   * Menu owners declare their id here (module augmentation) BEFORE registering;
   * that single declaration types `register`, `extend`, and `open` for everyone.
   * Bundled menu ids are pre-declared below (§1.11). For a private one-off menu
   * nobody needs to splice, use {@link PopupToolkit.menu} — no augmentation needed.
   */
  export interface MenuMap {}

  /** One keyboard-activated entry in a menu. */
  export interface MenuItem<Target> {
    /** Activation key inside the open menu ({@link KeySpec}, single stroke). */
    key: string;
    label: string;
    /**
     * Return false to omit the item for this target entirely — hidden and its
     * key inert, never grayed-out-but-activatable (e.g. no PR for this branch).
     */
    when?(target: Target): boolean;
    /** The action. Errors are caught and surfaced; the menu closes first. */
    run(target: Target): void | Promise<void>;
  }

  /** A titled group of items, rendered as a column/section (Magit-transient style). */
  export interface MenuGroup<Target> {
    /**
     * Stable identity that {@link MenuRegistry.extend} splices address.
     * Defaults to `title` — give any group you expect others to splice into
     * an explicit id, so retitling it never silently reroutes their splices.
     */
    id?: string;
    title?: string;
    items: readonly MenuItem<Target>[];
  }

  export interface MenuSpec<Id extends keyof MenuMap & string> {
    id: Id;
    /** Static title, or derived from the target ("Branch: feature/x"). */
    title: string | ((target: MenuMap[Id]) => string);
    groups: readonly MenuGroup<MenuMap[Id]>[];
  }

  export interface MenuRegistry<TName extends string = string> {
    /**
     * Register a menu you own (its id must carry your prefix — compile-checked).
     * The spec is inert data: other extensions splice into it with `extend`,
     * and the whole thing renders as a keyboard popup.
     */
    register<Id extends keyof MenuMap & ScopedId<TName>>(spec: MenuSpec<Id>): Disposable;

    /**
     * Splice items into ANY menu id (the Magit/Forge move) — no `needs`
     * required. A splice is standing data keyed by the menu ID, not the menu
     * instance: extending an id that isn't registered (yet, or right now) is
     * legal, and the splice applies whenever the owner (re)registers — it
     * survives the owner's reloads and is disposed with YOUR extension.
     * `group` names a group id to append to ({@link MenuGroup.id}); no match
     * creates a new trailing group titled with it. Item key conflicts: later
     * registration wins, with a logged diagnostic.
     */
    extend<Id extends keyof MenuMap & string>(
      id: Id,
      splice: { group?: string; items: readonly MenuItem<MenuMap[Id]>[] },
    ): Disposable;

    /**
     * Open a menu for a target. Resolves when the menu closes; rejects if the
     * id has no registered menu right now. The open menu is a snapshot of the
     * merged spec and the target at open() time; if the owner, the opener, or
     * any extension whose spliced items are showing deactivates, the menu
     * closes as if dismissed (§5.3) — a reload can never route a keypress
     * into a disposed item's closure or hand a pre-reload target to
     * post-reload code.
     */
    open<Id extends keyof MenuMap & string>(id: Id, target: MenuMap[Id]): Promise<void>;
  }
```

### 1.10 Popups and status line

```ts
  /**
   * Modal building blocks. All render as centered popups and trap focus. Each
   * popup belongs to the calling extension: if you deactivate mid-await (a
   * hot reload lands with your prompt open), the popup closes and the pending
   * promise never settles — the flow is abandoned at its `await`, never
   * resumed against a stale ctx (§5.3).
   */
  export interface PopupToolkit {
    /** Yes/no. Resolves false on escape. `danger` styles the confirm action red. */
    confirm(opts: {
      title: string;
      message?: string;
      confirmLabel?: string;
      danger?: boolean;
    }): Promise<boolean>;

    /** Single-line text input. Resolves undefined on escape. */
    prompt(opts: {
      title: string;
      placeholder?: string;
      initial?: string;
      /** Return an error message to block submission, null to accept. */
      validate?(value: string): string | null;
    }): Promise<string | undefined>;

    /** Filterable list picker. Resolves the chosen value, or undefined on escape. */
    select<T>(opts: {
      title: string;
      items: readonly SelectItem<T>[];
      placeholder?: string;
    }): Promise<T | undefined>;

    /**
     * One-off keyed menu: same look and item shape as registered menus, but
     * ad hoc — not in {@link MenuMap}, not spliceable, no augmentation needed.
     * Resolves when the menu closes.
     */
    menu(opts: { title: string; groups: readonly MenuGroup<void>[] }): Promise<void>;

    /** Transient toast notification. Never steals focus. */
    notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
  }

  export interface SelectItem<T> {
    label: string;
    value: T;
    /** Dimmed right-aligned detail text. */
    hint?: string;
  }

  /**
   * One status line segment: a small React component, same paradigm as panes.
   * Use {@link useGit}/{@link useTheme} inside to stay live — no manual event
   * wiring; for async data produced in activate scope, pair with
   * {@link createCell}: `set` from activate, `use()` in the component — or own
   * the polling entirely inside the component, as ci-status does (§4.2).
   * Render null to hide the segment. Keep it to one row of text.
   */
  export interface StatusSegmentSpec<TName extends string = string> {
    /** Users order/hide segments by this id in config. Compile-checked prefix. */
    id: ScopedId<TName>;
    component: ComponentType;
    align?: "left" | "right";
    /** Lower renders closer to its edge. Default 100. */
    priority?: number;
  }

  export interface Statusline<TName extends string = string> {
    /** Register a segment. A render throw collapses only this segment (error boundary). */
    register(spec: StatusSegmentSpec<TName>): Disposable;
  }
```

### 1.11 Extension-to-extension: exported APIs, decorations, bundled seams

```ts
  /**
   * Registry of exported extension APIs: extension name → API type (the awaited
   * return of its `activate`). Bundled extensions are pre-declared below;
   * third-party extensions augment this interface next to their default export
   * (see {@link ExtensionApiOf}).
   */
  export interface ExtensionApis {
    branches: BranchesApi;
    files: FilesApi;
    commits: CommitsApi;
    stash: StashApi;
    diff: DiffApi;
    "commit-flow": CommitFlowApi;
  }

  /**
   * Access to other extensions' exported APIs. `get` only accepts ids you
   * declared in `needs` — the compiler makes you keep `needs` honest, and the
   * result is non-optional because `needs` guarantees activation order and
   * ripple restart (§5.3): within your lifetime, the API is always live.
   *
   * Any {@link Disposable} returned through this API is auto-attached to YOUR
   * extension's scope (core proxies the provider's API), so cross-extension
   * registrations clean up when you reload — with zero effort on your part.
   */
  export interface ExtensionHub<Needs extends readonly NeedName[]> {
    /** The exported API of a declared need. Typed via {@link ExtensionApis}. */
    get<Id extends Needs[number] & string>(
      id: Id,
    ): Id extends keyof ExtensionApis ? ExtensionApis[Id] : unknown;
  }

  /**
   * Visual decoration another extension contributes to one row of a list pane.
   * Providers must be fast and synchronous — cache async data (PR state, CI
   * status) and call {@link RowDecorationHandle.refresh} when it changes.
   */
  export interface RowDecoration {
    /** Short badge appended to the row ("#42 draft", "90d"). */
    badge?: string;
    /** Tone for the badge; the theme picks the color. */
    tone?: Tone;
    /** Render the whole row de-emphasized. */
    dim?: boolean;
  }

  export interface RowDecorationHandle extends Disposable {
    /**
     * Re-run this provider over visible rows (call after async data arrives).
     * Like {@link Disposable.dispose}, a no-op — never a throw — once your
     * extension has deactivated, so a late async tail can't trip on it.
     */
    refresh(): void;
  }

  /**
   * The contract every bundled LIST extension exports (a project rule recorded
   * in ADR-0001: Bundled Extensions must expose their extension points — row
   * decorations wherever rows exist, action-menu items everywhere; the menu
   * side is {@link MenuRegistry.extend} on the ids below).
   */
  export interface RowSource<Row> {
    /** Contribute a decoration per row; return undefined to leave a row alone. */
    decorateRows(provider: (row: Row) => RowDecoration | undefined): RowDecorationHandle;
    /** The currently selected row in that pane, if any. */
    selected(): Row | undefined;
  }

  // The eight Bundled Extensions are `status`, `files`, `branches`, `commits`,
  // `stash`, `diff`, `commit-flow`, and `sync` (push/pull/fetch). Every one of
  // the eight declares an `.actions` menu id below — the universal splice seam.
  // The four list extensions additionally export RowSource APIs; `diff` and
  // `commit-flow` export the small APIs beneath. `status` and `sync` export no
  // API: they have no rows and nothing to consume — their seam IS their menu,
  // and an ExtensionApis entry exists only where there is an API worth calling.

  export type BranchesApi = RowSource<Branch>;
  export type FilesApi = RowSource<FileChange>;
  export type CommitsApi = RowSource<Commit>;
  export type StashApi = RowSource<StashEntry>;

  /** What the diff pane is currently showing. */
  export interface DiffTarget {
    readonly kind: "workingTree" | "staged" | "commit" | "stash";
    /** Commit oid / stash ref when `kind` is "commit"/"stash", else null. */
    readonly ref: string | null;
    /** Restrict to one path, or null for the full diff. */
    readonly path: string | null;
  }

  /** Exported API of the bundled diff extension. */
  export interface DiffApi {
    /** The target currently shown, or null while the pane is empty. */
    current(): DiffTarget | null;
    /** Point the diff pane at a target (reveals the pane if tabbed away). */
    show(target: DiffTarget): void;
  }

  /** Exported API of the bundled commit-flow extension (the commit transient). */
  export interface CommitFlowApi {
    /**
     * Open the commit flow, optionally prefilled — how an extension hands a
     * composed message (conventional-commit, changelog tooling) to the
     * standard commit UX instead of committing blind. Resolves when the flow
     * closes, committed or abandoned.
     */
    begin(opts?: { message?: string; amend?: boolean }): Promise<void>;
  }

  // Bundled menu ids and their target types — `ctx.menus.extend("branches.actions", ...)`
  // is fully typed out of the box:
  export interface MenuMap {
    "branches.actions": Branch;
    "files.actions": FileChange;
    "commits.actions": Commit;
    "stash.actions": StashEntry;
    /** Repo-level actions, opened from the status pane. */
    "status.actions": GitState;
    /** The commit transient — the premier Magit-precedent splice target. */
    "commit-flow.actions": WorkingTreeStatus;
    /** Push/pull/fetch actions. */
    "sync.actions": Head;
    /** Actions on whatever the diff pane is showing. */
    "diff.actions": DiffTarget;
  }
```

### 1.12 Effect escape hatch

```ts
  /** Effect-native face of the git core (mirrors {@link Git}). */
  export interface GitService {
    readonly raw: (
      args: readonly string[],
      options?: RawOptions,
    ) => Effect.Effect<GitOutput, GitError>;
    readonly state: Effect.Effect<GitState>;
    /** Emits a snapshot after every refresh. */
    readonly changes: Stream.Stream<GitState>;
  }

  /** Effect-native face of the event bus. */
  export interface EventsService {
    readonly publish: <K extends keyof EventMap & string>(
      event: K,
      ...payload: EventPayload<K>
    ) => Effect.Effect<void>;
    readonly stream: <K extends keyof EventMap & string>(event: K) => Stream.Stream<EventMap[K]>;
  }

  export type CoreServices = GitService | EventsService;

  /**
   * The one Effect door. Core is Effect v4 internally; `runtime.runPromise(...)`
   * executes effects against the live core services, fiber-supervised inside
   * your extension's scope — fibers you fork are interrupted on
   * deactivate/reload. Service keys use Effect v4's `Context.Key` (the v3
   * `Context.Tag` rename). Plain-async extensions never need this. Caveat:
   * these type names track the Effect v4 BETA and pin to the version
   * laziergit vendors — the one section of this surface typed against a
   * moving target; expect it to shift with the beta.
   */
  export interface EffectEscape {
    readonly runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
    readonly keys: {
      readonly Git: Context.Key<GitService, GitService>;
      readonly Events: Context.Key<EventsService, EventsService>;
    };
  }

} // declare module "laziergit"
```

---

## 2. Worked example A — `gh-workflows`

A pane listing GitHub Actions runs for the current branch (via the `gh` CLI), refreshing on
branch change, with a pane keybinding (`o` opens the run) and a palette command.

```tsx
/** @jsxImportSource @opentui/react */
// ~/.config/laziergit/extensions/gh-workflows.tsx
import {
  defineExtension,
  option,
  useCommand,
  useEvent,
  useGit,
  useTheme,
  type PaneProps,
  type Theme,
} from "laziergit";
import { useCallback, useEffect, useState } from "react";

interface Run {
  databaseId: number;
  displayTitle: string;
  workflowName: string;
  /** "queued" | "in_progress" | "completed" | "waiting" | ... — gh's set grows; compare, don't exhaust */
  status: string;
  /** "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "" | ... */
  conclusion: string;
  url: string;
}

// Custom event so the palette command (registered in activate) can poke the
// pane component. Prefixed with the extension name (compile-enforced on emit);
// `void` payload means emit takes zero arguments.
declare module "laziergit" {
  interface EventMap {
    "gh-workflows.refresh": void;
  }
}

function icon(run: Run, theme: Theme): { glyph: string; color: string } {
  if (run.status !== "completed") return { glyph: "●", color: theme.warning };
  if (run.conclusion === "success") return { glyph: "✓", color: theme.success };
  if (run.conclusion === "failure") return { glyph: "✗", color: theme.danger };
  return { glyph: "-", color: theme.textMuted };
}

export default defineExtension({
  name: "gh-workflows",
  description: "GitHub Actions runs for the current branch (requires the `gh` CLI)",

  config: {
    limit: option.number({ default: 15, min: 1, max: 100, description: "How many runs to list" }),
  },

  activate(ctx) {
    // Pane components are defined inside activate so they can close over `ctx`.
    function WorkflowRunsPane({ focused }: PaneProps) {
      const theme = useTheme();
      const branch = useGit((s) => s.head.branch);
      const [runs, setRuns] = useState<readonly Run[]>([]);
      const [cursor, setCursor] = useState(0);
      const [error, setError] = useState<string | null>(null);

      const refresh = useCallback(async () => {
        if (!branch) return setRuns([]);
        const res = await ctx.exec("gh", [
          "run", "list",
          "--branch", branch,
          "--limit", String(ctx.config.limit),
          "--json", "databaseId,displayTitle,workflowName,status,conclusion,url",
        ]);
        if (res.exitCode !== 0) return setError(res.stderr.trim() || "gh failed");
        setError(null);
        setRuns(JSON.parse(res.stdout) as Run[]);
        setCursor(0);
      }, [branch]);

      useEffect(() => { void refresh(); }, [refresh]); // initial load + every branch change
      useEvent("gh-workflows.refresh", refresh);       // palette command below

      // Pane-scoped commands: active only while this pane is focused,
      // disposed on unmount, listed in the cheat sheet.
      useCommand({ id: "gh-workflows.next", title: "Next run", keys: "j", hidden: true,
        run: () => setCursor((c) => Math.min(c + 1, runs.length - 1)) });
      useCommand({ id: "gh-workflows.prev", title: "Previous run", keys: "k", hidden: true,
        run: () => setCursor((c) => Math.max(c - 1, 0)) });
      // Also a palette entry: running it from the palette focuses this pane
      // first (focus-then-run), so the selection it acts on is the visible one.
      useCommand({
        id: "gh-workflows.open-run",
        title: "Open workflow run in browser",
        keys: "o",
        run: async () => {
          const run = runs[cursor];
          if (run) await ctx.open(run.url);
        },
      });

      if (error) return <text fg={theme.danger}>{error}</text>;
      if (!branch) return <text fg={theme.textMuted}>detached HEAD — no runs</text>;
      if (runs.length === 0) return <text fg={theme.textMuted}>no runs for {branch}</text>;

      return (
        <scrollbox>
          {runs.map((run, i) => {
            const { glyph, color } = icon(run, theme);
            return (
              <text
                key={run.databaseId}
                bg={i === cursor && focused ? theme.selection : undefined}
              >
                <span fg={color}>{glyph}</span> {run.workflowName} — {run.displayTitle}
              </text>
            );
          })}
        </scrollbox>
      );
    }

    const pane = ctx.panes.register({
      id: "gh-workflows",
      title: "Actions",
      component: WorkflowRunsPane,
      placement: { column: 0, order: 50 }, // hint only; the user's Layout wins
    });

    ctx.commands.register({
      id: "gh-workflows.refresh",
      title: "GitHub Actions: refresh runs",
      run: () => {
        pane.focus();
        ctx.events.emit("gh-workflows.refresh"); // void payload → zero args
      },
    });
  },
});
```

User config for it, in `~/.config/laziergit/config.jsonc` (schema-validated, autocompleted):

```jsonc
{
  "extensions": { "gh-workflows": { "limit": 30 } },
  "layout": { "columns": [["status", "files", "branches", "gh-workflows"], ["diff"]] },
  "keybindings": { "gh-workflows.open-run": "enter" } // user override beats the default "o"
}
```

---

## 3. Worked example B — `github-prs`

No pane. Decorates branch rows with PR status and splices "Open pull request" into the
branches extension's action menu. Exercises `needs` → typed `ctx.extensions.get`, typed menu
splicing, `ctx.onDispose` for a hand-made timer, and exporting an API of its own.

```ts
// <repo>/.laziergit/extensions/github-prs.ts
import { defineExtension, type ExtensionApiOf, type Tone } from "laziergit";

interface Pr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
}

function badge(pr: Pr): { text: string; tone: Tone } {
  if (pr.state === "MERGED") return { text: `#${pr.number} merged`, tone: "muted" };
  if (pr.state === "CLOSED") return { text: `#${pr.number} closed`, tone: "danger" };
  if (pr.isDraft) return { text: `#${pr.number} draft`, tone: "warning" };
  return { text: `#${pr.number}`, tone: "success" };
}

const extension = defineExtension({
  name: "github-prs",
  description: "PR status on branch rows + Open PR in the branch menu (requires `gh`)",
  needs: ["branches"], // ← makes ctx.extensions.get("branches") legal and typed

  activate(ctx) {
    const branches = ctx.extensions.get("branches"); // BranchesApi, no cast, no generic
    const byBranch = new Map<string, Pr>();

    // Row decorations: synchronous provider over cached data; refresh() when data lands.
    // The returned handle is auto-attached to THIS extension's scope even though
    // the registration went through the branches extension (see note §5.3).
    const decoration = branches.decorateRows((branch) => {
      const pr = byBranch.get(branch.name);
      return pr ? { badge: badge(pr).text, tone: badge(pr).tone } : undefined;
    });

    // Splice into the branches extension's action menu. `branch` is typed via
    // MenuMap["branches.actions"] — declared by the branches extension.
    ctx.menus.extend("branches.actions", {
      group: "GitHub",
      items: [
        {
          key: "o",
          label: "Open pull request in browser",
          when: (branch) => byBranch.has(branch.name),
          run: async (branch) => {
            await ctx.open(byBranch.get(branch.name)!.url);
          },
        },
      ],
    });

    async function refresh(): Promise<void> {
      const res = await ctx.exec("gh", [
        "pr", "list",
        "--state", "all",
        "--limit", "200",
        "--json", "number,title,url,isDraft,state,headRefName",
      ]);
      if (res.exitCode !== 0) {
        console.warn("gh pr list failed", res.stderr); // captured + tagged by the host
        return;
      }
      byBranch.clear();
      for (const pr of JSON.parse(res.stdout) as Pr[]) {
        if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr);
      }
      decoration.refresh();
    }

    ctx.events.on("git.branches.changed", refresh); // auto-disposed
    // Fire-and-forget is safe: if a reload lands mid-refresh, the pending
    // ctx.exec never settles and the chain is silently abandoned (§5.3).
    void refresh();

    // The ONE kind of resource ctx can't track for you: something you made by hand.
    const timer = setInterval(refresh, 120_000);
    ctx.onDispose(() => clearInterval(timer));

    // Exported API: the return value of activate IS the API other extensions get.
    return {
      /** The PR associated with a local branch, if any. */
      prFor(branchName: string): Pr | undefined {
        return byBranch.get(branchName);
      },
    };
  },
});

export default extension;

// Publish the exported API type. Any extension with needs: ["github-prs"] now
// gets a typed `prFor` from ctx.extensions.get("github-prs").
declare module "laziergit" {
  interface ExtensionApis {
    "github-prs": ExtensionApiOf<typeof extension>;
  }
}
```

---

## 4. The mini-extensions that shaped the API

These are the other examples written before the types were fixed (plus `open-remote` in §0).
Each is complete and runnable as shown.

### 4.1 branch-age — row decorations only

```ts
import { defineExtension } from "laziergit";

export default defineExtension({
  name: "branch-age",
  description: "Flag branches whose last commit is getting old",
  needs: ["branches"],
  activate(ctx) {
    ctx.extensions.get("branches").decorateRows((branch) => {
      const days = Math.floor((Date.now() - branch.lastCommit.authoredAt) / 86_400_000);
      if (days < 30) return undefined;
      return { badge: `${days}d`, tone: days > 90 ? "danger" : "warning" };
    });
  },
});
```

### 4.2 ci-status — a status line segment (React, like everything else)

```tsx
/** @jsxImportSource @opentui/react */
import { defineExtension, useGit, useTheme } from "laziergit";
import { useEffect, useState } from "react";

export default defineExtension({
  name: "ci-status",
  description: "CI state of the current branch in the status line",
  activate(ctx) {
    // Segments are components: useGit IS the branch-change subscription, and
    // the polling timer lives (and dies) with the component — no ctx cleanup.
    function CiSegment() {
      const theme = useTheme();
      const branch = useGit((s) => s.head.branch);
      const [state, setState] = useState<"none" | "running" | "passed" | "failed">("none");

      useEffect(() => {
        if (!branch) { setState("none"); return; }
        let cancelled = false;
        async function poll() {
          const res = await ctx.exec("gh", [
            "run", "list", "--branch", branch!, "--limit", "1", "--json", "status,conclusion",
          ]);
          if (cancelled || res.exitCode !== 0) return;
          const run = (JSON.parse(res.stdout) as { status: string; conclusion: string }[])[0];
          setState(!run ? "none"
            : run.status !== "completed" ? "running"
            : run.conclusion === "success" ? "passed" : "failed");
        }
        void poll();
        const timer = setInterval(poll, 60_000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [branch]);

      if (state === "none") return null; // hidden segment
      const [glyph, color] =
        state === "running" ? ["CI ●", theme.warning]
        : state === "passed" ? ["CI ✓", theme.success]
        : ["CI ✗", theme.danger];
      return <text fg={color}>{glyph}</text>;
    }

    ctx.statusline.register({ id: "ci-status", component: CiSegment, align: "right" });
  },
});
```

### 4.3 conventional-commit — popup flow + porcelain

```ts
import { defineExtension } from "laziergit";

const TYPES = ["feat", "fix", "chore", "docs", "refactor", "test", "perf"] as const;

export default defineExtension({
  name: "conventional-commit",
  description: "Guided conventional-commit prompt",
  activate(ctx) {
    ctx.commands.register({
      id: "conventional-commit.create",
      title: "Commit (conventional)",
      keys: "C",
      pane: "files", // contextual: bound while the bundled files pane is focused
      run: async () => {
        if (ctx.git.state.status.staged.length === 0) {
          return ctx.popups.notify("Nothing staged", "warning");
        }
        const type = await ctx.popups.select({
          title: "Type",
          items: TYPES.map((t) => ({ label: t, value: t })),
        });
        if (!type) return;
        const scope = await ctx.popups.prompt({ title: "Scope (optional)" });
        const subject = await ctx.popups.prompt({
          title: "Subject",
          validate: (v) => (v.trim().length === 0 ? "Subject is required" : null),
        });
        if (!subject) return;
        await ctx.git.commit(`${type}${scope ? `(${scope})` : ""}: ${subject}`);
        ctx.popups.notify("Committed", "success");
      },
    });
  },
});
```

### 4.4 stash-preview — a second pane, `useGit` + raw git in a component

```tsx
/** @jsxImportSource @opentui/react */
import { defineExtension, useCommand, useGit, useTheme, type PaneProps } from "laziergit";
import { useEffect, useState } from "react";

export default defineExtension({
  name: "stash-preview",
  description: "Stash list with inline diff preview",
  activate(ctx) {
    function StashPane({ focused }: PaneProps) {
      const theme = useTheme();
      const stash = useGit((s) => s.stash);
      const [cursor, setCursor] = useState(0);
      const [diff, setDiff] = useState("");

      const entry = stash[Math.min(cursor, stash.length - 1)];

      useEffect(() => {
        if (!entry) return setDiff("");
        void ctx.git.raw(["stash", "show", "-p", `stash@{${entry.index}}`])
          .then((out) => setDiff(out.stdout));
      }, [entry?.oid]);

      useCommand({ id: "stash-preview.next", title: "Next stash", keys: "j", hidden: true,
        run: () => setCursor((c) => Math.min(c + 1, stash.length - 1)) });
      useCommand({ id: "stash-preview.prev", title: "Previous stash", keys: "k", hidden: true,
        run: () => setCursor((c) => Math.max(c - 1, 0)) });
      useCommand({ id: "stash-preview.pop", title: "Pop stash", keys: "p",
        run: async () => { if (entry) await ctx.git.stash.pop(entry.index); } });

      if (stash.length === 0) return <text fg={theme.textMuted}>no stashes</text>;
      return (
        <box flexDirection="column">
          {stash.map((s, i) => (
            <text key={s.oid} bg={i === cursor && focused ? theme.selection : undefined}>
              {`stash@{${s.index}} ${s.message}`}
            </text>
          ))}
          <diff diff={diff} view="unified" />
        </box>
      );
    }

    ctx.panes.register({ id: "stash-preview", title: "Stash", component: StashPane });
  },
});
```

---

## 5. Design notes (only where types encode non-obvious semantics)

### 5.1 One naming rule, compile-checked

Every registered id — pane, command, menu, status segment, custom event — starts with the
extension's name, with `.` as the only separator everywhere (events included; there is no
second `:` convention). `defineExtension` infers `TName` from the `name` literal and threads it
into `ctx`, where every registration id is typed `ScopedId<TName>` — so a wrong prefix is a
compile error, cross-extension collisions are unrepresentable, and `emit` structurally cannot
spoof `git.*`/`app.*` events. Runtime re-checks catch dynamically built strings and
`useCommand` ids (the one surface a hook's types can't reach — §1.8), and the two
core prefixes are reserved names.

### 5.2 `api` lives in `activate`'s return value

The project's extension-anatomy decision (PLAN.md) sketched an `api` field on the spec; this
design realizes it as the return value of `activate` (VS Code precedent) — a deliberate,
visible deviation from the sketched anatomy. Reasons: the API almost always closes over state built during activation (the
`byBranch` cache in github-prs); a separate field would either run before that state exists,
need its own factory-with-ctx lifecycle, or force shared state into module scope; and inference
is free — `ExtensionApiOf<typeof extension>` extracts it with zero duplication, so the declared
type can never drift from the implementation. `Api = void` when you return nothing, so simple
extensions never see the concept. The anatomy decision deliberately left the exact shape open
to design, which is what sanctions the move: every sketched field is realized, with `api`
realized as data flow rather than a slot.

### 5.3 Disposal and hot reload

`ctx` **is** a scope (internally an Effect `Scope`). Every registration — commands, panes,
menus, events, statusline segments, subscriptions — attaches to it on creation; the returned
`Disposable` is only for *early* teardown. Hot reload = file save → deactivate ripple (below) →
`deactivate?()` with ctx still live → close scope (registrations unwind in reverse order,
fibers interrupted) → re-import with a cache-busting query param (Bun) → `activate` with a
fresh ctx. The old ctx and every API object hanging off it is then **poisoned**: every member
*access* (properties included, so `ctx.config` and `ctx.git.state` too) throws
`StaleContextError` carrying `{ extension, reason: "reload" | "deactivated" | "quit" }` (a
trick borrowed from pi, the coding agent whose in-process extension host pioneered it —
applied wholesale). Three deliberate exceptions: `ctx.signal` stays readable (it is the
liveness probe), and the stale no-op set — `dispose()` and `RowDecorationHandle.refresh()` —
does nothing rather than throwing, because both mean "do something to my registration" and the
correct answer for a dead registration is "nothing". Plain data extracted earlier (a `GitState`
snapshot, destructured config values) is inert and stays readable; only live API surfaces are
poisoned. While an extension is down mid-reload, its pane slots render a "reloading"
placeholder instead of collapsing the layout cell.

**The async tail.** Poisoning alone would turn routine reloads into unhandled rejections: a
`refresh()` mid-`await ctx.exec("gh", ...)` when the reload lands would resume against a stale
ctx and throw into a floating promise. So deactivation *interrupts* rather than poison-and-pray:
every promise returned by a ctx member (`exec`, `open`, `git.*`, `popups.*`, `menus.open`,
`commands.execute`) is scope-supervised, and if the extension deactivates before it settles it
**never settles** — the continuation after the `await` simply never runs, exactly like the
interrupted fiber it internally is. No unhandled rejection, no error toast; the abandoned
chain's closures drop with the scope, and the fresh activation starts its own work. Side
effects at the boundary: `exec`/`open` child processes are killed; `ctx.git` writes started
while live run to completion (repo integrity), only their notification is dropped. The only way
to reach a stale ctx is therefore a continuation resumed by a *non-ctx* promise — raw `fetch`,
`Bun.$`, a timer not registered with `onDispose` — and for those, `ctx.signal.aborted` is the
check (or pass the signal along). This is what makes the corpus's fire-and-forget patterns
(`void refresh()`, `setInterval(refresh, ...)` + `onDispose(clearInterval)`) safe exactly as
written.

**Modal UI across reload.** Popups and menus are modal state, and modal state belongs to
scopes. A popup (`confirm` / `prompt` / `select` / `popups.menu`) belongs to its caller: if the
caller deactivates mid-await, the popup closes and the pending promise is parked by the
async-tail rule — the flow is abandoned, never resumed against a stale ctx; the user re-invokes
after the reload. An open registered menu is a **snapshot** of the merged spec and target taken
at `open()` (menus are data), but core records every scope that contributed to it — the owner,
each splicer with items showing, the opener — and closes the menu, as if dismissed, the moment
any of them deactivates. Ripple ordering makes this deterministic: dependents close before
their provider goes down. Net effect: no keypress can reach a disposed item's closure, and no
pre-reload target object is ever handed to post-reload code.

Two rules make cross-extension registrations safe with zero author effort:

1. `ctx.extensions.get(...)` returns a core-owned proxy of the provider's API. Any
   `Disposable` returned through that proxy is auto-attached to the **caller's** scope — so
   `branches.decorateRows(...)` in github-prs is cleaned up when *github-prs* reloads, not
   leaked into the branches extension. (This is why `Disposable` is object-shaped rather than a
   bare function: the proxy can recognize it structurally.)
2. **Ripple restart.** `needs` forms a DAG — a cycle fails activation of every extension in it
   with an error naming the cycle, never a deadlock. Activation runs in topological order,
   deactivation in reverse. When a provider hot-reloads, its dependents deactivate *before* the
   provider goes down and re-activate after it comes back — so a consumed API's lifetime is
   strictly nested inside the provider's activation window, and a live extension can never
   observe a dead or stale dependency. The honest cost is UI state, not time: a dependent's
   panes remount on the provider's reload (cursor and scroll reset, transitively down the DAG —
   and config edits reload too, §5.6). v1 accepts the remount to buy lifetime soundness:
   activation is cheap by design, reloads are development-loop events, and pane-state
   persistence across reloads is a post-v1 concern.

**Name-keyed seams need no `needs`.** Ripple restart protects the one channel that hands you
live objects (`ctx.extensions.get`). The other cross-extension channels key on *names*, and
names never go stale: menu splices key on the menu id (standing data, applied whenever the
owner (re)registers — extending before, during, or after the owner's lifetime all behave the
same), pane-scoped bindings key on the pane id (inert while the pane is unmounted, reattached
on remount), and event subscriptions key on the event name (quiet while the emitter is down).
Declare `needs` when you call an API; never for splices, bindings, or subscriptions.

**Identity edge cases.** Extension names are the unit of identity everywhere (`ScopedId`,
`ExtensionApis`, config sections), so collisions are resolved, never merged: a repo extension
shadows a same-named global one (repo wins, diagnostic logged — the same precedence as config
merging), and a second same-named extension in the same scope is a load error.

### 5.4 How `ctx.extensions.get("branches")` gets its type

Three pieces, no generics at use sites:

- `interface ExtensionApis {}` in the `"laziergit"` module is the name→API registry. Bundled
  extensions are declared directly in the shipped types; third-party extensions add one
  `declare module "laziergit"` augmentation next to their default export, using
  `ExtensionApiOf<typeof extension>` so the declared type can never drift from the code.
- `needs` is inferred as a literal tuple (`const Needs`), and `ExtensionHub<Needs>.get` only
  accepts members of that tuple. Calling `get` on an undeclared id is a **compile error** — the
  type system forces `needs` to be honest, which is exactly what an agent needs to be told.
- Declared needs are activation-ordered and hard-required, so `get` never returns undefined.

Ids without a published augmentation fall back to `unknown` (not `any`), so untyped consumption
is possible but deliberately noisy. There are no soft/optional dependencies and no runtime
version negotiation in v1: soft lookups have no ordering guarantee (reintroducing exactly the
staleness class `needs` exists to prevent), and since extensions are source-compiled TS, types
are checked against the host's declarations at import time — incompatibilities fail loudly at
load, not silently at call time.

### 5.5 Event map typing

One augmentable `interface EventMap` (name → payload) drives `on`, `emit`, and `useEvent`
through mapped signatures — **not** overloads, because module augmentation can extend an
interface but cannot add overloads to a method (pi's equivalent event list is overload-based
and therefore closed to third parties; this map isn't). The core git half is a mapped type
over `GitState`: `git.<slice>.changed` with `{ current, previous }` as payload — the project
decision that events derive from the same store is the type definition itself, so the vocabulary cannot drift from the store shape, and `previous` is
there when you need the diff. Core events are emitted only by core; `emit` is typed
`ScopedId<TName>` (compile error) and runtime-checked (dynamic names), so no extension can
spoof another's events. `void`-payload events get a zero-argument `emit` via the `EventPayload`
tuple trick rather than a nullable payload. Handler errors are caught per-handler and logged;
one broken subscriber never starves the rest.

### 5.6 Config schema → typed values

`option.*` builders are tiny runtime objects that (a) carry a phantom value type for
`ConfigValues<S>` inference and (b) compile to JSON Schema for validation and config.jsonc
editor autocomplete. Two opinionated constraints keep the types honest: every option **must
have a default** (so `ctx.config` is total — no `| undefined` to fumble), and v1 values are
flat scalars / string arrays (objects would force a schema language; revisit post-v1). Merge
order is global → repo → validate → freeze; values that fail validation fall back to their
defaults with a logged diagnostic, so bad config degrades an extension, never blocks it.
Config is an activation-constant snapshot: editing config hot-reloads the affected extensions,
which removes any need for a reactive config API — reload IS the change event.

### 5.7 Menus as data

`MenuSpec` is inert data keyed by an augmentable `MenuMap` (id → target type). Declaring the
id's target type once — by the menu owner — types `register`, `extend`, and `open` for every
party, which is what makes Forge-style splicing (`github-prs` adding "Open PR" to the branches
menu) both possible and fully typed; spliceable-by-default is the point of menus-as-data.
`register` additionally constrains the id to your own prefix, so you can only *own* menus under
your name while extending anyone's. For a private one-off menu, `ctx.popups.menu` renders the
same `MenuGroup` data ad hoc with no registry entry — the popup toolkit's `menu` without the
global-augmentation friction. `when(target)` keeps spliced items honest per-row (false =
hidden, never grayed-out-but-activatable); key conflicts resolve last-wins with a logged
diagnostic (mirroring the keymap layer). Groups carry a stable `id` for splice addressing
(defaulting to `title`) so a menu owner can retitle presentation text without silently
rerouting other extensions' splices, and splices themselves are standing data keyed by menu id
— they survive the owner's reloads and apply on (re)registration (§5.3). Transient-style
toggleable arguments (Magit infixes) are deliberately out of v1; groups and items were
sufficient for every example written.

### 5.8 `useCommand` and the pane scope

The most common TUI pattern — "a key that acts on the selected row" — needs component state.
`useCommand` registers a command through the *pane's* React lifetime (mounted → registered,
unmounted → disposed) and scopes its binding to the enclosing pane automatically, so selection
handlers stay next to the `useState` they read. Commands still land in the catalog, so the
cheat sheet, palette, and user rebinding stay complete without any extra registration — there
is deliberately no second "raw key handler" API that would bypass the Command unit. Global
commands belong in `activate`; the `pane` field on `CommandSpec` covers binding into *another*
extension's pane (conventional-commit binding `C` in the files pane).

Pane-scoped commands stay palette-complete because palette execution is **focus-then-run**
(§1.7): the pane is focused, then the latest render's handler runs — so "open the selected
run" is one `useCommand`, not a `useCommand` plus a global twin. For the reverse direction,
`activate`-scope code reaching *into* a component, there are exactly two channels: a custom
event (the invoke channel — "do something now") and `createCell` (the data channel — "here is
the latest value"). Selection state, meanwhile, flows outward by a different door entirely:
export it, the way the bundled `RowSource.selected()` does.

### 5.9 Error containment

Full trust, no sandbox — containment is structural, per surface:

| Surface | Boundary | Blast radius |
|---|---|---|
| `activate` throw/reject | loader try/catch | extension marked failed; its dependents (via `needs`) blocked with a naming error; app unaffected |
| Pane / segment render | per-slot React error boundary | error card in that pane / collapsed segment only |
| Event handler | per-handler try/catch in dispatcher | logged; other handlers still run |
| Command / menu-item `run`, `when` | try/catch at dispatch | error toast + log |
| Decoration provider | try/catch per row pass | provider skipped for the pass; logged |
| `deactivate` / `onDispose` finalizers | try/catch per finalizer | logged; disposal continues |
| Effect fibers | runtime scoped to activation | interrupted at deactivation |
| In-flight async at deactivation | scope supervision — ctx promises never settle after scope close (§5.3) | continuation silently abandoned; nothing leaks into the new activation |

`GitError` carries argv/exit/stderr so command handlers can show real git messages.

### 5.10 Implementation mapping (public API → vendored mechanism)

| Public API | Internal mechanism |
|---|---|
| `ctx.panes.register` / statusline segments | `@opentui/react` slot registry plugin per pane/segment; the Layout renders one slot per configured id; the registry's built-in error boundary + failure placeholder provide containment for free |
| Commands + `keys` / `useCommand` | `@opentui/keymap` command catalog + `registerLayer({ commands, bindings })`; pane scoping → layer targeted at the pane renderable (`targetMode: "focus-within"`), re-targeted by pane id when a remount replaces the renderable; `useCommand` re-points handlers via a latest-ref; palette = `getCommands()`, cheat sheet = `createBindingLookup` extras; `mod+` via the mod-bindings addon, `<leader>` via the leader addon |
| Menus | plain data + one generic popup component; an open menu pushes a modal high-priority keymap layer |
| Registrations / `onDispose` | Effect `Scope` per activation; `dispose()` = early finalizer run; consumed-API proxy attaches foreign Disposables to the caller's scope |
| Hot reload | fs watcher → reverse-topo deactivate → poison (`assertActive` behind every ctx member) → re-import with cache-bust → topo activate |
| `ctx.git` / `useGit` | git plumbing service (shell-out, Effect-internal) + snapshot store; React via `useSyncExternalStore`; ~2s repo-fingerprint poll (`for-each-ref` + `.git/HEAD`) + post-helper refresh |
| `ctx.events` | store snapshot diff per refresh cycle (coalesced — one event per changed slice), sequential dispatch, per-handler catch |
| `"laziergit"` module | `ensureRuntimePluginSupport({ additional: { laziergit } })` from `@opentui/react/runtime-plugin-support/configure`, imported before anything else — the FIRST install must carry the extra specifier: a later install that adds one the first lacked throws, while later installs without extras are compatible no-ops — so extension imports share the Core's React/OpenTUI/laziergit instances; works in `bun build --compile` binaries |

### 5.11 Deliberately absent

- **Git write interceptors** (`git.intercept` / `GitBlockedError`) — the push-guard
  interceptor experiment from the corpus (§0) motivated them, but they are an extension point
  beyond the v1 list with real hazards
  (classifying mutating argv for `raw`, popup-inside-awaited-git reentrancy); cut for v1 —
  smallest surface wins over one hypothetical extension; revisit with a real queueing design.
- **`ctx.log`** — `console.*` is captured by the host, tagged with the extension name, and
  routed to the log file / debug pane.
- **Soft dependencies** (`extensions.find`) — an optional lookup has no ordering guarantee,
  reintroducing exactly the staleness `needs` + ripple restart exist to prevent; declare the need.
- **Semver ranges on `needs`** — extensions are source-compiled TS checked against the host's
  declarations at import; a version-negotiation layer buys nothing an activation error doesn't.
- **Config-change / theme-change events** — both are "extension reloads" by definition (§5.6);
  theme changes reflow through `useTheme` automatically. `ctx.config` is a constant plain object.
- **An imperative statusline API** (`set(key, {text, tone})`) — segments are React components
  like every other UI surface; one paradigm, and `useGit` replaces manual event wiring.
- **A blessed list/table component kit** — OpenTUI's primitives plus `useCommand` cover it; the
  bundled panes will grow shared components that can be promoted later if they prove out, which
  is cheaper than shrinking a shipped kit.
- **Toast/progress/spinner APIs beyond `notify`** — a pane that owns long work renders its own state.
- **A `disabled` state on menu items** — `when` hides; a visible-but-inert item is presentation
  subtlety v1 skips (hiding unsuitable entries is Magit's default too).
- **A `signal` on `ExecOptions`** — scope supervision already kills the child and parks the
  promise at deactivation (§5.3); a per-call AbortSignal would duplicate the one lifetime that
  matters. `ctx.signal` covers the non-ctx async you manage yourself.
- **Activation events / lazy loading / manifests** — everything loads eagerly; extensions are
  single files that import in milliseconds under Bun, and hot reload makes eager loading free.
  A declarative manifest can be derived later from `defineExtension`'s data fields without
  breaking anyone.
- **NOT absent, on purpose: `ctx.exec`.** `Bun.$` remains fully available (full trust), but
  `exec` stays because its repo-root cwd default is a correctness detail that must live inside
  the `.d.ts` an agent learns from — forgetting `.cwd(ctx.git.root)` on `Bun.$` is the kind of
  silent bug types exist to prevent.
