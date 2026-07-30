# laziergit public API — the `"laziergit"` module

**Method note.** This surface was derived backwards from a corpus of eight worked extensions
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
| `ctx` | eleven members — `config` · `git` · `events` · `commands` · `panes` · `menus` · `popups` · `statusline` · `extensions` · `effect` · `signal` — plus four methods: `exec()`, `open()`, `copy()`, `onDispose()` |
| React hooks | `useGit`, `useGitActivity`, `useEvent`, `useCommand`, `useTheme`, and the pane-building `useListCursor`, `useScrollView`, `useKeyCapture` — 8 hooks (plus `createCell` for activate → component data) |
| Pure helpers | `option` (config), `toneColor` + `createRowSource` (row decorations), `literalPathspec` (pathspec safety), `describeGitFailure` (what to show when git says no), `remoteWebUrl` (a remote's browsable page) — plain functions, no runtime |
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

**Directory form.** A directory Extension is a folder with a `package.json`; the entry point is
its `main` field (default `index.ts`, then `index.tsx`). It may carry helpers, assets, and its own
`node_modules` — Bun installs and resolves local dependencies normally. A lone-file Extension is
self-contained: only that file is copied for cache-busted import, so helpers and assets require
directory form. `laziergit`, `react`, `react/jsx-runtime`, `@opentui/react`, and `@opentui/core`
always resolve to the host's instances regardless of what is installed locally (the runtime
module hooks match those exact specifiers for every importer), so a locally installed React can
never fork the tree. Top-level symbolic links to Extension files or directories are supported;
status and identity keep the logical linked path while loading and fingerprinting follow the
canonical target, including retargets and repairs. Extensions load from three scopes, in
precedence order `bundled` < `global` < `repo`: the bundled scope is the distribution's own
`extensions/` directory, loaded through exactly the same discovery and with exactly the same
privileges as yours. Name collisions: an Extension from a later scope shadows a same-named one
from an earlier scope (the winner's scope is named in the diagnostic — the same precedence as
config); two same-named Extensions in the same scope are a load error for the second.

The smallest complete extension (a palette command that opens the repo on GitHub):

```ts
// ~/.config/laziergit/extensions/open-remote.ts
import { defineExtension, remoteWebUrl } from "laziergit";

export default defineExtension({
  name: "open-remote",
  description: "Open the current repo on its web remote",
  activate(ctx) {
    ctx.commands.register({
      id: "open-remote.open",
      title: "Open repository in browser",
      keys: "go",
      run: async () => {
        // `remoteWebUrl` prefers `origin` and knows the ssh, `ssh://` and HTTP(S) spellings;
        // it returns null for a remote with no web page at all (§1.5). Reaching for
        // `remotes[0]` and rewriting the URL by hand is the wrong answer the moment a fork
        // is added — which is exactly why this is public API rather than a snippet.
        const url = remoteWebUrl(ctx.git.state.remotes);
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
   * Semantic emphasis for small pieces of UI one extension contributes to
   * another's (row decoration badges), so the contributor never picks a raw
   * color. Nothing central draws these: a decoration is rendered by the
   * extension that owns the row, which resolves the tone against the active
   * theme with {@link toneColor} (§1.11). That is the whole point of the
   * indirection — the contributor never sees a theme, and the renderer never
   * has to know the vocabulary the contributor was written against.
   */
  export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

  /**
   * A key or key sequence in @opentui/keymap grammar:
   *
   * - single strokes: `"c"`, `"ctrl+r"`, `"escape"`, `"return"`, `"tab"`. A bare letter
   *   binds its *lowercase* stroke — the parser lowercases the key name when it matches —
   *   so `"D"` binds plain `d`, **not** a shifted `D`. Write `"shift+d"` for the shifted
   *   stroke. `"D"` and `"d"` are therefore one and the same binding (see the diagnostic note below).
   *
   *   The Enter key is `"return"`. `"enter"` is a *different* stroke name — the keymap
   *   knows both, and core does not install the alias field that would join them — so
   *   `"enter"` parses, registers, and appears in the cheat sheet while never firing.
   *   It is the one spelling that fails silently instead of loudly, which is why it is
   *   named here rather than left to be discovered.
   * - platform-aware modifier: `"mod+s"` — ctrl everywhere, upgraded to cmd on
   *   macOS terminals whose keyboard protocol can report it (kitty keyboard
   *   protocol); elsewhere on macOS it stays ctrl. Reporting cmd and *delivering*
   *   it are different things — a terminal is free to keep a cmd stroke for
   *   itself, and several do — so no core or bundled default is spelled with
   *   `mod+` alone (ADR-0004). Yours may be; just pair it with a plain stroke.
   * - multi-key sequences, concatenated: `"gg"`, `"dd"`, `"go"` — but named keys win over
   *   concatenation: a spelling that begins with a named key (`"gt"`, `"up"`, `"f5"`)
   *   parses as that single named stroke, not a sequence
   * - leader sequences: `"<leader>p"` (leader key set in user config)
   *
   * These are *default* bindings. Users can rebind or unbind any command in
   * config.jsonc (`keybindings: { "<command id>": "keys" | null }`); the config
   * value always wins. Conflicting defaults log a diagnostic; last registration wins.
   * Keys are compared case-folded, because a bare letter binds its lowercase stroke —
   * so `"D"` and `"d"` conflict just as two spellings of `"d"` would, and one does not
   * silently shadow the other.
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
     * key in {@link ExtensionApis}. Scopes shadow by precedence
     * (bundled < global < repo); a same-scope collision is a load error (§5.3).
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
    readonly effect: EffectEscape<TName>;

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
     *
     * The child's *exit* is what ends the call, not end-of-file on its pipes:
     * anything the child spawns inherits those pipes and holds them open for as
     * long as it lives (`wl-copy` daemonises exactly this way), so waiting for
     * them would be waiting for a process that is none of your business. The
     * pipes get a short grace period after the exit and then you get what
     * arrived — which, for a program that does not leave survivors behind, is
     * all of it.
     */
    exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecOutput>;

    /**
     * Open a URL (or file path) with the user's default handler — the
     * cross-platform "open in browser" (`open` / `xdg-open` / `start`,
     * resolved per platform so extensions never hardcode one).
     */
    open(url: string): Promise<void>;

    /**
     * Put text on the system clipboard — the sibling of {@link open}, and for
     * the same reason: which tool does it is a property of the machine
     * (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`, tried in that order
     * per platform), and an extension copying an oid has no business
     * knowing. The text goes on the tool's stdin, never in argv, so nothing
     * you copy can be read as an option. Rejects with the tool's own message
     * if none of them is installed or one of them fails — and each writer is
     * bounded, so a tool that hangs costs the next one its turn rather than
     * costing your Command its return. There is no `read`:
     * nothing needs it yet, and a clipboard an extension can *read* is a
     * different question (§5.11).
     */
    copy(text: string): Promise<void>;

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
   * One declared config option, as a union over `kind`. Every option MUST have a
   * default, so extensions always work with zero configuration and `ctx.config` is
   * total (no undefined anywhere). Descriptions surface in config.jsonc
   * autocomplete.
   *
   * A union rather than a `kind` beside an uncorrelated `default`, because the two
   * are not independent: the flat shape let `{ kind: "number", default: "none" }`
   * typecheck, and `ctx.config.limit` then inferred `string` while the reader
   * handed back a `number` — the exact unsoundness this inference exists to rule
   * out. It also had nowhere to put `min`, `max` and `values`, so both readers that
   * need them re-declared a wider shadow type and widened into it by hand.
   */
  export interface StringConfigOption {
    readonly kind: "string";
    readonly default: string;
    readonly description?: string;
  }
  export interface NumberConfigOption {
    readonly kind: "number";
    readonly default: number;
    readonly min?: number;
    readonly max?: number;
    readonly description?: string;
  }
  export interface BooleanConfigOption {
    readonly kind: "boolean";
    readonly default: boolean;
    readonly description?: string;
  }
  export interface EnumConfigOption<V extends string = string> {
    readonly kind: "enum";
    /** Every accepted spelling. `default` is one of them, by construction. */
    readonly values: readonly V[];
    readonly default: V;
    readonly description?: string;
  }
  export interface StringArrayConfigOption {
    readonly kind: "string-array";
    readonly default: readonly string[];
    readonly description?: string;
  }

  export type ConfigOption =
    | StringConfigOption
    | NumberConfigOption
    | BooleanConfigOption
    | EnumConfigOption
    | StringArrayConfigOption;

  /** An extension's config schema: option name → option. */
  export type ConfigSchema = Record<string, ConfigOption>;

  /** Each setting's value type is its variant's `default` type — no conditional needed. */
  export type ConfigValues<S extends ConfigSchema> = {
    readonly [K in keyof S]: S[K]["default"];
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
    string(opts: { default: string; description?: string }): StringConfigOption;
    /** Throws if the default falls outside its own `min`/`max`, or if `min` exceeds `max`. */
    number(opts: {
      default: number;
      description?: string;
      min?: number;
      max?: number;
    }): NumberConfigOption;
    boolean(opts: { default: boolean; description?: string }): BooleanConfigOption;
    /** Throws if the default is not one of `values` — which is also a type error. */
    enum<const V extends readonly string[]>(
      values: V,
      opts: { default: V[number]; description?: string },
    ): EnumConfigOption<V[number]>;
    stringArray(opts: {
      default: readonly string[];
      description?: string;
    }): StringArrayConfigOption;
  };
```

### 1.5 Git — the reactive store, plumbing, and porcelain

```ts
  /**
   * Snapshot of everything laziergit knows about the repository. Core refreshes
   * it after every write issued through `ctx.git`, on a cheap ~2s repo-fingerprint
   * poll (four lock-free reads — `status --porcelain=v2`, `show-ref --head`,
   * `stash list`, and `config --get-regexp '^(remote|branch)\.'`; no fs-watching,
   * see §5.12 for why each is needed), and on focus regain. Always present — core loads it before extensions
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
    /** Cached remote-tracking branches. */
    readonly remoteBranches: readonly RemoteBranch[];
    readonly remotes: readonly Remote[];
    readonly tags: readonly Tag[];
    readonly status: WorkingTreeStatus;
    /** Recent history of HEAD (windowed; page deeper via `git.raw(["log", ...])`). */
    readonly commits: readonly Commit[];
    readonly stash: readonly StashEntry[];
  }

  /**
   * Where HEAD points — the three shapes git can produce, plus the one it cannot
   * because there is no repository to ask. A union rather than four independent
   * fields because the fields are not independent: an unborn HEAD has no commit to
   * name, a detached one has no branch and therefore no upstream, and only a branch
   * with a commit behind it has both. Reading an oid off a repository with no commits
   * is a type error, not a `""`.
   */
  export type Head =
    /**
     * There is no repository here, so HEAD names nothing. Every other slice of
     * {@link GitState} is empty beside it and every write rejects. Its own variant
     * rather than an unborn HEAD with a nameless branch: laziergit runs wherever the
     * user starts it, so "not a repository" is an ordinary state a Pane renders
     * differently from a fresh `git init`.
     */
    | { readonly kind: "noRepository" }
    /**
     * `git init` with nothing committed: HEAD is a symbolic ref to a branch that does
     * not exist yet.
     */
    | { readonly kind: "unborn"; readonly branch: string }
    /** HEAD is a raw commit, so there is no branch to carry an upstream. */
    | { readonly kind: "detached"; readonly oid: string }
    | {
        readonly kind: "onBranch";
        readonly oid: string;
        readonly branch: string;
        /** The upstream of {@link branch} — the very object that branch's row carries. */
        readonly upstream: UpstreamInfo | null;
      };

  export interface UpstreamInfo {
    readonly remote: string;
    /** Branch name on the remote, without its `refs/heads/` prefix. */
    readonly branch: string;
    /**
     * The upstream ref no longer exists on the remote. Git reports `gone` *instead of*
     * a divergence, so `ahead` and `behind` are both 0 here and mean nothing — this
     * flag is the only thing separating a deleted upstream from an in-sync one.
     */
    readonly gone: boolean;
    /** Divergence from the upstream. */
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

  export interface RemoteBranch {
    /** Branch name without the remote prefix. */
    readonly name: string;
    readonly remote: string;
    readonly oid: string;
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

  /**
   * What one side of the index did to a path — porcelain v2's `X` and `Y` letters, named.
   * `X` is HEAD→index, `Y` is index→working tree; they measure different comparisons, which
   * is why one path can be `MM` (ADR-0005).
   */
  export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";

  /** The working-tree side reports one thing the index side cannot: a path git never heard of. */
  export type WorktreeChange = ChangeKind | "untracked";

  /** What one side of a merge did — porcelain v2's unmerged `XY`, one letter each. */
  export type ConflictSide = "added" | "deleted" | "modified";

  /**
   * One path, one entry. A union rather than four loose fields, because an unmerged path has
   * no index-versus-working-tree pair to report at all.
   *
   * Invariant on the `"changed"` arm: at least one of `index` / `worktree` is non-null.
   */
  export type FileChange =
    | {
        readonly kind: "changed";
        /** Path relative to the repo root. */
        readonly path: string;
        /** Original path for renames/copies the index holds, otherwise null. */
        readonly previousPath: string | null;
        /** HEAD → index. `null` when the index matches HEAD. */
        readonly index: ChangeKind | null;
        /** Index → working tree. `null` when the working tree matches the index. */
        readonly worktree: WorktreeChange | null;
      }
    | {
        readonly kind: "conflicted";
        readonly path: string;
        readonly previousPath: null;
        readonly ours: ConflictSide;
        readonly theirs: ConflictSide;
      };

  export interface WorkingTreeStatus {
    /** One entry per path git reported, ordered by path. */
    readonly files: readonly FileChange[];
    readonly isClean: boolean;
  }

  /**
   * The four questions {@link WorkingTreeStatus}'s old four arrays answered, over the one
   * list that replaced them.
   *
   * Predicates rather than arrays or getters: the store publishes `status` by structural
   * comparison and keeps unchanged parts referentially stable, so a derived array hanging
   * off the status object would be rebuilt on every snapshot and defeat that identity.
   *
   * **Memoise where you filter.** These compose into `useGit` selectors the wrong way round:
   *
   * ```ts
   * // Never — a fresh array every snapshot, so `Object.is` never holds and the Pane spins.
   * const staged = useGit((state) => state.status.files.filter(isStaged));
   *
   * // Instead — select the slice, derive from it.
   * const files = useGit((state) => state.status.files);
   * const staged = useMemo(() => files.filter(isStaged), [files]);
   * ```
   *
   * Counts are safe inline, because a number compares by value. There is deliberately no
   * `isTracked`: `git rm --cached` on a file still on disk is both staged and untracked, so
   * any single boolean would have to lie about one of them.
   */
  export function isStaged(change: FileChange): boolean;
  export function isUnstaged(change: FileChange): boolean;
  export function isUntracked(change: FileChange): boolean;
  export function isConflicted(change: FileChange): boolean;

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
    /**
     * Operation-specific environment variables. Laziergit's non-interactive
     * credential policy and C locale remain authoritative.
     */
    env?: Readonly<Record<string, string>>;
  }

  /**
   * Thrown when a git invocation exits nonzero (unless `allowFailure`).
   *
   * `stderr` is git's own account of the failure and is what you show the
   * user — with credential prompting off by design (§5.11), it is often the
   * entire diagnosis. It is also the only thing that says *which* refusal
   * this is: the exit code is 1 for every one of them, so a push that must
   * tell "non-fast-forward" from "stale info" from "[remote rejected]" reads
   * the text. That is supported, not a hack: laziergit runs git under
   * `LC_ALL=C`, so the wording an extension matches on is git's own and does
   * not shift with the user's locale.
   */
  export class GitError extends Error {
    /**
     * The same account, ready to show. The constructor sets it to
     * `stderr.trim()`, falling back to the argv and exit code for the failures
     * git says nothing about — so unlike `stderr` it is never empty, which is
     * the whole reason to prefer it when all you want is a sentence for the
     * user. Reach for `stderr` when you are *matching* on git's wording.
     */
    readonly message: string;
    readonly args: readonly string[];
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  /**
   * The sentence to put in front of the user when git says no — git's own,
   * because it wrote it for this exact situation and a friendlier paraphrase
   * would be a worse one. A {@link GitError} yields its `message` — internal
   * newlines and all, so a rejected `pre-commit` hook reaches the toast across
   * several lines. Anything else reaching here is a bug in the calling
   * extension rather than a refusal from git, and says so plainly instead of
   * hiding behind a generic message.
   *
   * ```ts
   * try {
   *   await ctx.git.commit(message);
   * } catch (error) {
   *   ctx.popups.notify(describeGitFailure(error), "error");
   * }
   * ```
   *
   * Public API rather than a snippet each extension copies: all eight bundled
   * extensions wanted it, six wrote it under five different names, and five of
   * those re-spelled the `stderr.trim() || message` fallback {@link GitError}
   * had already applied for them.
   */
  export function describeGitFailure(error: unknown): string;

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
     * unless `allowFailure`. A mutating argv refreshes the store afterwards,
     * same as the helpers.
     *
     * **Wrap every path you put in the argv in {@link literalPathspec}.** No
     * shell is involved, but git does its own globbing: every path git takes is
     * a *pathspec*, and `--` does not turn that off.
     *
     * **Whether your argv counts as mutating is decided from the argv alone,
     * before git runs**, and the rule is spelled out here because you cannot
     * predict it otherwise. The subcommand is the first argv element that does
     * not start with `-` (a value-taking global — `-c`, `-C`, `--config-env`,
     * `--exec-path`, `--git-dir`, `--namespace`, `--super-prefix`,
     * `--work-tree` — swallows the element after it). It is a **read** if that
     * subcommand is one of `blame`, `cat-file`, `check-attr`, `check-ignore`,
     * `check-ref-format`, `count-objects`, `describe`, `diff`, `diff-files`,
     * `diff-index`, `diff-tree`, `for-each-ref`, `grep`, `log`, `ls-files`,
     * `ls-remote`, `ls-tree`, `merge-base`, `name-rev`, `rev-list`,
     * `rev-parse`, `shortlog`, `show`, `show-ref`, `status`, `var`,
     * `verify-commit`, `verify-tag`, `whatchanged`; or if the subcommand and
     * **the argv element immediately after it** spell one of the read-only
     * pairs `bisect log`, `notes list`, `notes show`, `reflog show`,
     * `remote get-url`, `stash list`, `stash show`, `submodule status`,
     * `worktree list`. Everything else is assumed to mutate — including an argv
     * with no subcommand at all, like `["--version"]` — because a missed refresh
     * leaves the screen disagreeing with the repository while a spurious one
     * costs a coalesced re-read.
     *
     * The pair rule is strict adjacency, and that is the part that surprises
     * people: `["reflog", "show", "-n", "5"]` is a read, while the same command
     * spelled `["reflog", "-n", "5"]` is a write — as are
     * `["branch", "--contains", "HEAD"]`, `["remote", "-v"]` and
     * `["tag", "--list"]`. Spell the second word of a pair immediately after the
     * first, and put your flags after both.
     *
     * A misclassified read is worse than a wasted refresh: a pane that reloads
     * on `git.refreshed` (§1.6) — the pattern the bundled diff pane uses — has
     * its read trigger the refresh that triggers the read, and the loop keeps
     * itself alive with nothing in the repository changing.
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

    /**
     * Stage the given paths, or everything (`"all"`). Staging is whole-file in v1; for
     * hunks and lines, build a patch and pipe it (§5.11):
     * `git.raw(["apply", "--cached"], { stdin: patch })`.
     *
     * An empty array stages nothing — the natural reading, and the one that makes an
     * empty multi-select harmless. Same for {@link unstage} and {@link discard}.
     */
    stage(paths: readonly string[] | "all"): Promise<void>;

    /** Unstage the given paths, or everything (`"all"`). Leaves the working tree untouched. */
    unstage(paths: readonly string[] | "all"): Promise<void>;

    /**
     * Discard working-tree changes to the given paths. Destructive: tracked paths are
     * restored from the index and untracked ones are deleted.
     */
    discard(paths: readonly string[]): Promise<void>;

    /** Create a commit from the index. */
    commit(
      message: string,
      opts?: {
        amend?: boolean;
        allowEmpty?: boolean;
        signoff?: boolean;
        /**
         * Amend the message without including anything currently staged. Rejects unless
         * `amend` is also set: a plain commit has no previous content to keep.
         */
        messageOnly?: boolean;
      },
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

  /**
   * A path, as the git pathspec that matches only that path.
   *
   * Every path git accepts is a *pathspec*, and a pathspec is a glob. `foo[1].txt`
   * also matches `foo1.txt`, and `--` does not change that — `--` only stops a
   * leading dash being read as an option. Nothing upstream escapes anything
   * either: paths reach you verbatim out of `git status --porcelain=v2 -z`, so
   * handing one straight back to git is not the round trip it looks like.
   * Unwrapped, `git.raw(["diff", "--", path])` diffs the neighbours too, and the
   * same mistake in a `clean` or `restore` argv deletes or reverts a file the
   * user never named.
   *
   * `:(literal)` is git's own magic for "this is a path, not a pattern", honoured
   * by every command that takes a pathspec. Exported rather than left to a note
   * on {@link Git.raw} because the failure is silent, destructive, and depends on
   * a git rule an extension author has no reason to know — the one shape of
   * mistake where a five-line helper beats a paragraph (§5.11).
   *
   * The porcelain helpers ({@link Git.stage}, {@link Git.unstage},
   * {@link Git.discard}) already apply it; `raw` cannot, because in `raw` only
   * you know which argv elements are paths.
   *
   * ```ts
   * await ctx.git.raw(["diff", "-U3", "--", literalPathspec(path)]);
   * ```
   */
  export function literalPathspec(path: string): string;

  /**
   * The web page a repository's remotes point at, or `null` if they point at
   * nothing browsable.
   *
   * The `git@host:path` → `https://host/path` transform, plus the `ssh://` and
   * HTTP(S) spellings of the same remote. `origin` is preferred over whatever git
   * listed first, because "the repository" means the canonical remote and
   * `remotes[0]` is the wrong answer the moment a fork is added.
   *
   * Returning `null` is the point: a `file://` remote, a `git://` daemon, a bare
   * directory or a sibling clone has no page, and `null` is what lets an "open on
   * remote" menu item hide itself with `when` rather than hand {@link
   * ExtensionContext.open} a directory to open in a file manager.
   *
   * ```ts
   * const url = remoteWebUrl(ctx.git.state.remotes);
   * // a commit page: `${url}/commit/${oid}`
   * ```
   *
   * Public API rather than a snippet each Extension copies: two Bundled
   * Extensions carried this transform, one menu apart, and had already diverged
   * on the port case by the time anyone compared them (§5.11).
   */
  export function remoteWebUrl(remotes: readonly Remote[]): string | null;
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
    /**
     * Fired after every refresh that read the repository and published a snapshot,
     * whether or not any slice changed. A refresh that publishes nothing — because
     * there is no repository, or because the read failed — emits nothing.
     */
    "git.refreshed": { readonly state: GitState };
    /** Pane focus moved. */
    "app.pane.focused": { readonly paneId: string; readonly previous: string | null };
  }

  /** void-payload events are emitted with no second argument. */
  export type EventPayload<K extends keyof EventMap> =
    EventMap[K] extends void ? [] : [payload: EventMap[K]];

  /**
   * Pub/sub over {@link EventMap}. `emit` snapshots subscribers immediately;
   * each subscription then receives its own FIFO queue, so a slow or retired
   * handler cannot block another subscription or a fresh activation. Disposal
   * excludes future snapshots and skips captured-but-not-started deliveries.
   * Handler errors are caught and logged per delivery. Subscriptions
   * auto-dispose with your Extension.
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
   * A Command is the single unit behind keybindings, the command palette, the
   * cheat sheet ("?"), and the hint bar along the bottom of the screen.
   * Registering one thing gives you all four.
   */
  export interface CommandSpec<TName extends string = string> {
    /** Unique id, compile-checked to start with your extension name ("gh-workflows.refresh"). */
    id: ScopedId<TName>;
    /** Human label — palette row and cheat-sheet text. */
    title: string;
    /**
     * Short label for the **hint bar** — "checkout", not "Check out branch".
     * Its *presence* is the opt-in: a command without one is still bound, still
     * in the palette, still in the cheat sheet, and simply stays off the bar.
     *
     * The bar shows what you can press *here*: the focused pane's commands in
     * registration order, then any global commands whose key that pane has not
     * claimed (so the stash pane's `p` reads "pop" while the global `p` still
     * means pull everywhere else), and during a {@link useKeyCapture} it
     * collapses to that pane's `capture` commands — the same bands the keymap
     * dispatches through, so the bar cannot name a key that would do something
     * else. It clips rather than wrapping, so put what matters first.
     *
     * Leave it off for anything that is on every screen in every mode: `tab`,
     * the palette and `q` are core's, and core does not hint them either.
     */
    hint?: string;
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

    /**
     * Bind `keys` while {@link pane} is capturing raw keyboard input
     * ({@link useKeyCapture}) *instead of* while it is merely focused — the way
     * out of a pane that owns the keys, `mod+s` to submit and `escape` to
     * cancel. Everything else goes inert during a capture, so these are the
     * only commands still listening; the cheat sheet says so by collapsing to
     * them (§5.8). Capture is a property of a pane's keyboard, so this is
     * ignored (with a diagnostic) on a command with no `pane`. A pane's normal
     * and capture layers are never live together, which is why the same key may
     * be claimed once in each: `escape` can cancel an edit and still do
     * whatever it did before the edit began.
     */
    capture?: boolean;
    /** The action. Errors are caught, logged, and surfaced as a notification. */
    run(): void | Promise<void>;
  }

  export interface CommandRegistry<TName extends string = string> {
    /** Register a command (keybinding + palette entry + cheat-sheet row + hint in one). */
    register(spec: CommandSpec<TName>): Disposable;

    /**
     * Invoke any registered Command by id — yours or another Extension's.
     * Pane-scoped Commands focus their Pane first (focus-then-run). Rejects if
     * the id is unknown, or if a pane-scoped Command's Pane has no live
     * instance right now. Once `run` starts, its failures are diagnosed and
     * notified but contained, so this Promise resolves.
     */
    execute(id: string): Promise<void>;
  }
```

**The number row belongs to core.** `1`–`9` focus the first nine Panes of the Layout in
reading order — columns left to right, cells top to bottom, tabs in the order their cell
lists them — and a Pane behind a tab is reached the same way, with the jump bringing it to
the front. Nothing an Extension does earns or claims a digit, which is the point: your Pane
is reachable the moment a Layout places it, and cannot collide with another Extension that
guessed the same number. The commands are `app.focus.1` … `app.focus.9` and rebindable like
any other; their titles follow the Panes they currently point at, so the cheat sheet reads
`1 Focus Files`, `2 Focus Branches`, and so on.

Register a focus command of your own anyway, without `keys` — the bundled Panes all do
(`files.focus`, `branches.focus`, …). It costs nothing, gives the palette a row that names
your Pane, and gives a user an id to bind a key they chose to a Pane they chose, which a
positional jump cannot.

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
    /**
     * Give this pane keyboard focus and reveal it (switching tabs if needed).
     * A deliberate act by the user — a `<name>.focus` command, a click. Throws
     * if the pane has no live instance or the Layout has not placed it.
     */
    focus(): void;
    /**
     * Make this pane the visible tab of its cell WITHOUT moving the keyboard —
     * the verb for a pane that follows someone else's selection. `DiffApi.show`
     * is the case it exists for: the default Layout tab-groups `diff` with
     * `commit-flow`, so after a commit the diff pane is stranded behind the
     * Commit tab and every subsequent cursor move updates something nobody can
     * see. {@link focus} is the wrong tool there — the user is driving the files
     * pane, and stealing the keyboard on every cursor move would be unusable.
     *
     * Silent where `focus` throws: this runs on cursor movement, so "that pane
     * is not on screen right now" is an ordinary condition to do nothing about,
     * not a programming error worth an exception per keystroke. A pane already
     * sharing the *focused* cell becomes focused too — focus is a cell plus its
     * visible tab, so there is no third state for it to land in.
     */
    reveal(): void;
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
   * const branch = useGit((s) => (s.head.kind === "onBranch" ? s.head.branch : null));
   * ```
   */
  export function useGit<T>(
    selector: (state: GitState) => T,
    isEqual?: (a: T, b: T) => boolean,
  ): T;

  /**
   * The git writes in flight right now, oldest first — so `.at(-1)` is the one
   * that started most recently, which is what a one-line surface should name
   * when two overlap.
   *
   * Every write goes through core, so this sees all of them wherever they were
   * invoked from — including other extensions' work and `raw` argv you built
   * yourself. Nothing opts in; nothing can forget.
   *
   * Reads never appear (the diff pane runs one per cursor move), the background
   * poll never appears, and an operation that settles inside ~120ms never
   * appears either — so this is safe to render directly, with no debounce of
   * your own and no spinner blinking once per staged hunk.
   *
   * Its own store rather than a slice of {@link GitState}: that is the
   * repository as last read, republished by a refresh and feeding every
   * selector and `git.<slice>.changed` event. Folding activity in would fire
   * that whole fan-out for a fact no pane asked about.
   *
   * ```tsx
   * const [busy] = useGitActivity().slice(-1);
   * return busy ? <text>{`${spinner} ${busy.label}`}</text> : null;
   * ```
   */
  export function useGitActivity(): readonly GitActivity[];

  /** One git write core is running right now. */
  export interface GitActivity {
    /** Unique for as long as the operation runs. */
    readonly id: number;
    /** A gerund: `"pushing"`, `"amending"`, `"fetching (prune)"`. */
    readonly label: string;
  }

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
   * Only `run` is live — it is read through a ref, so it always sees the current
   * render's closure. `title`, `keys`, `hidden` and `capture` are read once, at
   * registration; changing one on a later render does not re-register. That is
   * deliberate: re-registering would reorder the insertion-ordered `keys`
   * conflict resolution, letting a pane that merely recomputed a title take a key
   * from another pane mid-session. A command whose identity changes should change
   * its `id`, which does re-register.
   *
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
   * Claim the raw keyboard for the enclosing pane while `active` — for a pane
   * rendering its own `<textarea>` or `<input>`, where every ordinary binding is
   * a typo waiting to happen (`q` quits, `?` opens the cheat sheet, `[` and `]`
   * walk tabs).
   *
   * The same mechanism a popup uses, one priority band lower: while a pane
   * captures, the global layer and every pane layer go inert, and only this
   * pane's commands registered with `capture: true` stay live. The exit keys
   * therefore stay Commands — rebindable, in the catalog, in the cheat sheet —
   * rather than a second raw key-handler API beside the Command unit (§5.8). A
   * popup still outranks a capture, so `confirm` mid-edit behaves normally.
   *
   * A capture holds only while its pane is focused: focus cannot leave by
   * keyboard, which is the point, so this guards the other door — an extension
   * focusing elsewhere mid-edit cannot leave a background pane holding the
   * keyboard with no key left to escape it. Claims nest, so two panes editing
   * at once unwind in either order.
   *
   * ```tsx
   * useKeyCapture(editing);
   * useCommand({ id: "x.submit", title: "Commit", keys: "mod+s", capture: true, run: submit });
   * useCommand({ id: "x.cancel", title: "Cancel", keys: "escape", capture: true, run: cancel });
   * ```
   */
  export function useKeyCapture(active: boolean): void;

  /**
   * Cursor state for a list pane, with `j`/`k`/`g`/`G` — and their `down` /
   * `up` / `home` / `end` twins — registered as hidden pane-scoped commands, so
   * vim and arrow-key muscle memory both reach the same motion. What every list
   * pane needs and none of them should write twice (§5.11):
   *
   * ```tsx
   * const cursor = useListCursor({
   *   items: branches,
   *   idPrefix: "branches",
   *   noun: "branch",
   *   query: { mode: "filter", fields: (branch) => branch.name },
   * });
   * // Render cursor.items: filters project it; searches leave it equal to items.
   * ```
   * The index is always in range: clamped when the list shrinks (so the render
   * after a delete already draws a valid cursor rather than highlighting a row
   * that is gone), and unmoved when the list is replaced with an equal-length
   * one — which is what keeps the cursor still across a refresh. It calls
   * {@link useCommand}, so it inherits its pane requirement and its runtime
   * check on `idPrefix`.
   *
   * Attach {@link ListCursor.scrollRef} to the pane's `<scrollbox>` *and*
   * {@link ListCursor.rowId} to each row — a ref has nothing to reveal while the
   * rows are unnamed — or the cursor walks off the bottom of the box and the
   * selection, which is still what every key acts on, becomes invisible.
   * Half-page motions (`ctrl+d` /
   * `ctrl+u`) remain absent here, but they are no longer impossible: a pane
   * that wants them can measure with {@link ScrollView.viewportRows} and move
   * the cursor with {@link ListCursor.setIndex}.
   *
   * `query` adds lazygit's two `/` behaviors without imposing row markup.
   * `"filter"` applies smart-case, whitespace-separated substring terms live,
   * selects the first match as the query changes, and maps the selection back
   * to its source index when Escape clears the filter. `"search"` retains the
   * full list; Enter jumps to the first match after the cursor (wrapping), and
   * `n` / `shift+n` walk matches while `j` / `k` remain ordinary contextual
   * movement. Core draws the editor and match status in the Status Line; the
   * extension supplies the searchable fields and chooses the behavior.
   */
  export function useListCursor<T>(options: ListCursorOptions<T>): ListCursor<T>;

  export interface ListCursorOptions<T> {
    /** The rows the cursor walks; pass the newest array every render. */
    items: readonly T[];
    /**
     * Your extension name — the commands are `${idPrefix}.cursor.down` and
     * friends, and the rows are `${idPrefix}.row.${index}` (see
     * {@link ListCursor.rowId}). An extension with two list panes gives them
     * different prefixes, exactly as their command ids already require.
     */
    idPrefix: string;
    /** Singular noun for the cheat-sheet titles: "file" → "Next file". */
    noun: string;
    query?: ListQueryOptions<T>;
  }

  export interface ListQueryOptions<T> {
    readonly mode: "filter" | "search";
    /**
     * Complete searchable values for one row. Include values clipped from the
     * rendered line when a user should still be able to find them.
     */
    readonly fields: (item: T) => string | readonly string[];
  }

  export interface ListQuery {
    readonly mode: "filter" | "search";
    /** The applied query; a search draft does not replace it until Enter. */
    readonly value: string;
    readonly editing: boolean;
    readonly matchCount: number;
    /** Zero-based for searches; null for filters and searches with no matches. */
    readonly currentMatch: number | null;
    clear(): void;
  }

  export interface ListCursor<T> {
    /**
     * The rows to render: matching rows for a filter, the original rows for a
     * search or a cursor with no query declaration.
     */
    readonly items: readonly T[];
    /** Always in range: 0 while the list is empty, never past its end. */
    readonly index: number;
    readonly selected: T | undefined;
    readonly query: ListQuery | undefined;
    /** Move the cursor — a click, or a row your extension just created. */
    setIndex(index: number): void;
    /**
     * Callback ref for the pane's `<scrollbox>`: attach it, put {@link rowId} on
     * each row, and the selected row is scrolled into view whenever the cursor
     * moves past the edge of the viewport, by the minimum needed (so `j` scrolls
     * one row rather than recentring). Give the box
     * `focusable={false} flexGrow={1} flexBasis={0}` — see {@link ScrollView.ref}
     * for what each of those is load-bearing for.
     *
     * ```tsx
     * <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
     *   {rows}
     * </scrollbox>
     * ```
     * Every row needs `id={cursor.rowId(index)}` on it ({@link rowId}); without
     * that this ref has nothing to reveal.
     */
    readonly scrollRef: (surface: ScrollSurface | null) => void;
    /**
     * The `id` to put on the element drawn for `cursor.items[index]`, so the
     * cursor can find that row and scroll it into view.
     *
     * ```tsx
     * {cursor.items.map((item, index) => (
     *   <box
     *     key={item.id}
     *     id={cursor.rowId(index)}
     *     onMouseDown={() => cursor.setIndex(index)}
     *   >…</box>
     * ))}
     * ```
     *
     * An id rather than a row number, because the two stop being the same number
     * the moment a pane draws anything between its rows — a group header, a blank
     * line, a second line of detail. Layout already knows where the row landed, so
     * revealing asks it (see {@link ScrollSurface.scrollChildIntoView}) instead of
     * keeping a parallel height model that has to agree with it.
     */
    rowId(index: number): string;
  }

  /**
   * Imperative scrolling for a pane that shows more than fits and has no cursor
   * to follow — the bundled diff pane, whose `<diff>` renders a whole patch and
   * has no scroll API of its own. Wrap it in a `<scrollbox>` and drive that.
   *
   * OpenTUI's `<scrollbox>` is focusable and handles its own keys, but laziergit
   * never gives a renderable the terminal's focus (keys arrive as Commands, and
   * focus belongs to the Layout), so that key handling never runs. This hook is
   * the seam that reaches it instead. It is the scroll half of what §5.11
   * declines to ship as a component kit: behavior that must agree with the core,
   * not chrome.
   *
   * ```tsx
   * const scroll = useScrollView();
   * useCommand({ id: "x.down", title: "Scroll down", keys: "j", run: () => scroll.scrollBy(1) });
   * useCommand({ id: "x.page", title: "Page down", keys: "ctrl+d",
   *              run: () => scroll.scrollBy(scroll.viewportRows() / 2) });
   * <scrollbox ref={scroll.ref} focusable={false} flexGrow={1} flexBasis={0}>
   *   <diff diff={patch} view={view} />
   * </scrollbox>
   * ```
   */
  export function useScrollView(): ScrollView;

  export interface ScrollView {
    /**
     * Callback ref for the `<scrollbox>` this view drives. Give the box
     * `flexGrow={1} flexBasis={0}`: without the basis its flex size is its
     * *content* height, so a long document makes the box taller than the pane
     * and paints over the pane's own header instead of scrolling inside it.
     *
     * Give it `focusable={false}` too. OpenTUI's `<scrollbox>` is focusable by
     * default, and OpenTUI has a single focus slot, so a pane leaving the
     * default on puts its box in the running for a focus laziergit hands to the
     * popup layer's inputs — every bundled pane passes it.
     */
    readonly ref: (surface: ScrollSurface | null) => void;
    /**
     * Rows the viewport shows, or 0 before the first layout — the one
     * measurement an extension cannot compute, and what page-wise motions need.
     */
    viewportRows(): number;
    /** Scroll by whole rows; negative is up. Clamped to the content. */
    scrollBy(rows: number): void;
    /** Scroll to an absolute row, or to either end. Clamped to the content. */
    scrollTo(row: number | "start" | "end"): void;
  }

  /**
   * The slice of OpenTUI's `<scrollbox>` the scrolling seam drives. Declared
   * structurally because `ScrollBoxRenderable` lives in `@opentui/core`, which
   * extensions may not import (ADR-0001) — a callback ref still checks the shape
   * against the real renderable on assignment.
   */
  export interface ScrollSurface {
    scrollTop: number;
    /** Total height of the content, in rows. */
    readonly scrollHeight: number;
    readonly viewport: { readonly height: number };
    /**
     * Scroll the descendant carrying `childId` just far enough to be visible, or
     * do nothing if it already is — OpenTUI's own
     * `scrollIntoView({ block: "nearest" })`, which measures the element where it
     * was actually laid out. This is what lets {@link ListCursor} follow a cursor
     * without anyone computing a row number.
     */
    scrollChildIntoView(childId: string): void;
  }

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
   * Semantic #RRGGBB color tokens resolved from the active declarative theme.
   * Use these for fg/bg props so extensions match every theme. Extensions
   * consume themes; they do not register them or depend on one by name.
   */
  export interface Theme {
    readonly text: string;
    readonly textMuted: string;
    readonly accent: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
    readonly info: string;
    /** The Layout canvas. `"transparent"` preserves the terminal's native background. */
    readonly background: string;
    /** Raised chrome such as popups and the status line, not a Pane background. */
    readonly backgroundPanel: string;
    readonly border: string;
    readonly borderFocused: string;
    /** Background for the selected row in a focused list. */
    readonly selection: string;
    readonly diffAdded: string;
    readonly diffRemoved: string;
  }
```

Themes stay outside the executable Extension lifecycle. A reusable theme is a strict JSON
resource in `~/.config/laziergit/themes/*.json`; it may declare `$schema`, `name`,
`description`, `appearance`, `extends`, a named `palette`, and semantic `tokens`. Global
resources may extend or shadow built-ins. See [config.md §theme](./config.md#theme--select-extend-and-preview-palettes)
for the document format, all twelve built-ins, automatic dark/light selection, the generated
terminal-palette `system` theme, diagnostics, and the live-preview picker.

`useTheme()` subscribes to the kernel's theme store. Config changes, terminal appearance
changes, picker previews, and valid theme-resource edits replace its snapshot and re-render
consumers without reactivating the Extension or remounting its component tree. Keep local Pane
state local: it survives every one of those changes.

**OpenTUI intrinsics quick reference.** Pane and segment components are built from OpenTUI's
JSX intrinsics, fully typed in `@opentui/react` once `jsxImportSource` is set — your editor
autocompletes every prop; this table only orients. The ones the examples lean on:

| Intrinsic | Role | Props you'll reach for |
|---|---|---|
| `<box>` | flex container | `flexDirection`, `flexGrow`, `width`/`height` (fixed columns), `padding`, `gap`, `border` |
| `<text>` | one styled text run | `fg`, `bg` (row highlight); children may include `<span>` |
| `<span>` | inline styled fragment inside `<text>` | `fg`, `bg`, `attributes` |
| `<scrollbox>` | scrollable column for overflow content | `focusable={false} flexGrow={1} flexBasis={0}` (see {@link ScrollView.ref}), plus `ref` from {@link useScrollView} or {@link ListCursor.scrollRef} — it does **not** scroll itself, because laziergit never gives a renderable the terminal's focus |
| `<select>` | focusable list with built-in cursor | `options`, selection styling — or roll your own rows with `useCommand` j/k |
| `<diff>` | syntax-highlighted diff | `diff` (unified text), `view` (`"unified"` / `"split"`), `filetype` (per-language tree-sitter highlighting) |
| `<code>` | highlighted source block | `content`, `filetype` |
| `<input>` | single-line text entry | for one field inside your own Pane; the modal version is {@link PopupToolkit.prompt} |
| `<textarea>` | multi-line text entry | commit messages and anything else `prompt` is deliberately too small for (§5.11) |

Anything past this table — truncation, alignment, borders — is a prop on these same
intrinsics; the authority is `@opentui/react`'s JSX types, not this document.

**One row is one line.** `<text>` defaults to `wrapMode: "word"`, so a row wider than its
column reflows into two or three lines and a list stops being a list — one long branch name
pushes every row below it down, and the cursor no longer lands where the eye does. Every
bundled row therefore passes `wrapMode="none"`, which clips at the column edge, and so should
yours. There is no width to truncate against — a pane cannot measure its own column, only its
{@link ScrollView.viewportRows} — so clipping is the whole of the mechanism, and it clips from
the **right**: order a row most-important-first and it degrades by losing the part the reader
can most afford. What a clipped row cannot say belongs in the detail view, which is what
`DiffApi.show` and its `branch` target are for (§1.11).

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
     * `group` names a group id to append to ({@link MenuGroup.id}); no match —
     * or no `group` at all — creates a new trailing group, titled with the id
     * when there is one.
     *
     * Item key conflicts resolve by **position in the merged menu** — groups in
     * order, items in order within a group, the last one standing takes the key
     * — and not by recency. The owner's groups are laid out first and splices
     * appended after them, so a splice takes a contested key from the owner
     * however early it registered, and a splice landing in a trailing group
     * beats one appended into an earlier group whichever registered first.
     * Deliberately not the keymap's last-registration rule: the owner
     * re-registers its whole spec on each of its own hot reloads, so recency
     * would hand every contested key back to it the moment it reloaded, and a
     * splice is meant to be standing. The loser is dropped from the menu
     * entirely, where a Command that loses a key keeps its palette row — a menu
     * item is reachable by its key and nothing else, so keyless and absent are
     * the same thing. Either way the conflict is a logged diagnostic.
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
   *
   * The bottom row is shared: core writes the hint bar for the focused pane
   * along its left ({@link CommandSpec.hint}), and segments follow. `"right"`
   * is therefore where a segment has room — it is where the bundled `sync`
   * segment puts the branch and its divergence — and a left-aligned segment
   * competes with the hints for the same space.
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
    "remote-branches": RemoteBranchesApi;
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

  /**
   * The color a {@link RowDecoration} badge is drawn in — the other half of
   * {@link Tone}. Pure, so it needs no runtime and works anywhere you have a
   * {@link Theme}. An absent tone is ordinary text: a badge is extra data, not
   * an alarm.
   *
   * ```tsx
   * const decoration = host.useDecoration(row);
   * <text fg={toneColor(theme, decoration?.tone)} content={decoration?.badge ?? ""} />
   * ```
   */
  export function toneColor(theme: Theme, tone: Tone | undefined): string;

  /**
   * Builds the {@link RowSource} a list extension exports, and the pane-side
   * hook that renders what other extensions contributed to it. Every list pane
   * owes the same four things — hold the providers, merge them per row, track
   * the selection, re-render when a provider's async data lands — so they live
   * here rather than four times over (§5.11).
   *
   * ```ts
   * const host = createRowSource<FileChange>({
   *   key: (row) => `${row.kind}\0${row.previousPath ?? ""}\0${row.path}`,
   * });
   * // in activate:  return host.api;
   * // in the pane:  host.setSelected(cursor.selected); host.useDecoration(row);
   * ```
   */
  export function createRowSource<Row>(options: RowSourceOptions<Row>): RowSourceHost<Row>;

  export interface RowSourceOptions<Row> {
    /**
     * Stable identity for a row, independent of the object carrying it.
     *
     * The git store hands out a fresh object for a row whenever its data
     * changed and reuses the old one when it did not, so object identity is a
     * cache *hit* test but not a cache *slot*: keyed by object, every refresh
     * would strand the previous generation's entries with nothing able to say
     * they are dead. Keyed by the row's own name — a path, an oid, a stash
     * index — there is exactly one slot per logical row, reused as the store
     * replaces the objects beneath it.
     *
     * Make it unique across the rows this pane shows, and note that "unique"
     * is a claim about the ROW TYPE, not about the screen. Two *different*
     * objects sharing a key would evict each other on every pass and the merged
     * decoration would never settle.
     *
     * Prefer the row's most stable name, not its state: `branches` keys on the
     * branch name, `stash` on the entry's index, and `files` on `change.path`
     * alone — the model gives a path exactly one entry (ADR-0005), so the path
     * *is* the identity. Folding state into the key would move the slot every
     * time the row changed, discarding a decoration the provider would only
     * recompute to the same answer.
     */
    key(row: Row): string;
  }

  export interface RowSourceHost<Row> {
    /** Return this from `activate` — it is what other extensions consume. */
    readonly api: RowSource<Row>;
    /** Call from your pane whenever the cursor moves; feeds `RowSource.selected()`. */
    setSelected(row: Row | undefined): void;
    /**
     * Hook: the merged decoration for one row, live across provider
     * registration, disposal, and {@link RowDecorationHandle.refresh}. Later
     * providers win per FIELD, not wholesale, so a provider that sets only a
     * badge does not erase the tone an earlier one chose; a provider that
     * throws is skipped for the rest of the pass and logged (§5.9), and gets
     * another chance on the next refresh.
     */
    useDecoration(row: Row): RowDecoration | undefined;
  }

  // The eight Bundled Extensions are `files`, `branches`, `remote-branches`,
  // `commits`, `stash`, `diff`, `commit-flow`, and `sync` (push/pull/fetch,
  // and the repository itself). Every one of the eight declares an `.actions`
  // menu id below — the universal splice seam. The five list extensions
  // additionally export RowSource APIs; `diff` and `commit-flow` export the
  // small APIs beneath.
  // `sync` exports no API: it has no rows and nothing to consume — its seam IS
  // its menu, and an ExtensionApis entry exists only where there is an API
  // worth calling.

  export type BranchesApi = RowSource<Branch>;
  export type RemoteBranchesApi = RowSource<RemoteBranch>;
  export type FilesApi = RowSource<FileChange>;
  export type CommitsApi = RowSource<Commit>;
  export type StashApi = RowSource<StashEntry>;

  /**
   * What the diff pane is currently showing — the two shapes that differ in
   * whether they name a ref. A union rather than one record with a nullable
   * `ref`, because `{ kind: "commit", ref: null }` was representable and
   * meant nothing: the diff pane carried a runtime branch for a state no
   * caller could sensibly build. `path` narrows any of them to one file.
   *
   * `branch` and `commit` fetch identically — a branch name is a ref like any
   * other — and differ only in the context the pane prints above the patch.
   * That difference is the whole point of the third kind: list rows are one
   * line each and clip (§1.8), so the name that ran off the right edge has to
   * be readable somewhere, and `{ kind: "commit", ref: tip }` can only ever
   * name the commit.
   */
  export type DiffTarget =
    | { readonly kind: "workingTree" | "staged"; readonly path: string | null }
    | { readonly kind: "commit" | "stash" | "branch"; readonly ref: string; readonly path: string | null };

  /** Exported API of the bundled diff extension. */
  export interface DiffApi {
    /** The target currently shown, or null while the pane is empty. */
    current(): DiffTarget | null;
    /**
     * Point the diff pane at a target (reveals the pane if tabbed away — via
     * {@link PaneHandle.reveal}, which never moves the keyboard, because the
     * caller is a list pane the user is still driving), or at `null` to say
     * there is nothing to show. A list pane whose rows just went away — the
     * last stash dropped, the working tree cleaned — needs the second as much
     * as the first; without it the pane goes on drawing a ref that no longer
     * resolves.
     */
    show(target: DiffTarget | null): void;
  }

  /** How a commit flow ended, for a caller that composed the message. */
  export type CommitFlowResult = "committed" | "abandoned";

  /** Exported API of the bundled commit-flow extension (the commit transient). */
  export interface CommitFlowApi {
    /**
     * Open the commit flow, optionally prefilled — how an extension hands a
     * composed message (conventional-commit, changelog tooling) to the
     * standard commit UX instead of committing blind. Resolves when the flow
     * closes, and says which way it closed, so a composer knows whether to
     * keep its draft. `signoff` is here because the bundled commit menu
     * offers it and a bundled extension holds no privilege an author does
     * not (ADR-0001).
     */
    begin(opts?: {
      message?: string;
      amend?: boolean;
      signoff?: boolean;
      /** Amend only the message, leaving the current index out of the commit. Requires `amend`. */
      messageOnly?: boolean;
    }): Promise<CommitFlowResult>;
  }

  // Bundled menu ids and their target types — `ctx.menus.extend("branches.actions", ...)`
  // is fully typed out of the box:
  export interface MenuMap {
    "branches.actions": Branch;
    "remote-branches.actions": RemoteBranch;
    "files.actions": FileChange;
    "commits.actions": Commit;
    "stash.actions": StashEntry;
    /** The commit transient — the premier Magit-precedent splice target. */
    "commit-flow.actions": WorkingTreeStatus;
    /**
     * Push/pull/fetch, plus the repository-level actions (open in browser,
     * copy root). The whole state rather than just `Head`, because "open *this
     * repository*" needs the remotes and a narrower target is what kept those
     * actions in a pane of their own for as long as there was one.
     */
    "sync.actions": GitState;
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
  export interface EventsService<TName extends string = string> {
    /** Publish only this Extension's own ScopedId events. */
    readonly publish: <K extends keyof EventMap & ScopedId<TName>>(
      event: K,
      ...payload: EventPayload<K>
    ) => Effect.Effect<void>;
    readonly stream: <K extends keyof EventMap & string>(event: K) => Stream.Stream<EventMap[K]>;
  }

  /**
   * The one Effect door. Core is Effect v4 internally, but the public escape
   * hatch exposes only bound services plus `runPromise` for fully-provided
   * Effects. Raw ManagedRuntime access and service keys stay private so Core's
   * service graph cannot leak into Extensions. Work is supervised by the
   * activation lifetime and interrupted on deactivate/reload. Plain-async
   * Extensions never need this. Caveat: these Effect and Stream type names pin
   * to the Effect v4 beta version laziergit vendors, so this opt-in surface is
   * intentionally version-coupled while the ordinary API remains Promise-first.
   */
  export interface EffectEscape<TName extends string = string> {
    readonly git: GitService;
    readonly events: EventsService<TName>;
    readonly runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  }

} // declare module "laziergit"
```

**Implementation status.** The whole core surface is live as of M3 — Commands and keybindings,
Panes and the Layout, menus and splices, popups, the status line, the palette, the cheat sheet,
`ctx.config`, `ctx.events`, `ctx.git`, and `ctx.effect`. `ctx.git` reads a real repository and
its writes are the argv-built porcelain below; `ctx.effect` hands out the core's own git
effects rather than a wrapper around the Promise surface, so both faces drive the same code.
Outside a git repository laziergit still starts: the store serves an empty {@link GitState},
the poll does nothing, and every write fails with a {@link GitError} saying so.

§1.11 is live too, as of M4: the seven Bundled Extensions are real features, not placeholders.
The bundled *scope* is a directory discovered, imported, and shadowed exactly like a user one,
and the seven inside it register six Panes, one status line segment, thirty-eight Commands and
seven menus — every one of them through this document and nothing else, and not one of them
losing a key to another (§1.7's last-wins resolution reports no conflict on a real boot). The `*.actions` ids are
menus with items behind them, so `ctx.menus.extend("commits.actions", …)` splices into something
that exists; the four list extensions export `RowSource` APIs whose decoration providers are
called for every row on screen; `DiffApi.show` moves the diff pane and `CommitFlowApi.begin`
opens the editor and resolves with what the user did. Nothing in `extensions/` imports anything
but `"laziergit"`, `"react"` and `"@opentui/react"` — ADR-0001 holds by construction, which is
what makes the seven a fair test of this API rather than a demonstration of a private one.

Building them changed the API in five places, all of them above. `ctx.copy` (§1.3) arrived
because three of them wanted to copy an oid, a path, and a repository root and the only
alternative was per-platform shelling in every extension that wants it. `DiffTarget` became a
union and `DiffApi.show` began accepting `null`, because the flat record let a `commit` target
carry no ref and the diff pane could not be told its list had gone empty. `CommitFlowApi.begin`
gained `signoff` and a result, because the bundled commit menu offered a signed-off commit that
no other extension could ask for — a privilege ADR-0001 does not allow — and §4.3's composer
had no way to learn whether its message landed. `GitError` is documented as carrying git's own
words in the C locale, because classifying a rejected push means reading them and an extension
needs licence to. The one thing that did *not* change is the list-pane surface: `useListCursor`
and `createRowSource` carried all four list panes unaltered, which is the outcome §5.11
predicted when it promoted them.

The two encodings §5.12 used to name as gaps are also gone, and the git model is the better for
it: `Head` is a discriminated union, so an unborn repository has no oid to misread and a
detached one has no upstream to look for, and `UpstreamInfo.gone` says outright that the
remote deleted the branch instead of reporting it as zero divergence. Both landed early in M4,
where the Bundled Extensions put the first real weight on these types — the
branches Pane has to draw the very distinctions the old shapes flattened.

M4 also added the surfaces the Bundled Extensions needed and could not build for
themselves, all of them live: `toneColor` and `createRowSource` (§1.11), because a decoration
is contributed by one extension and drawn by another and neither can own the merge or the
palette; `useListCursor` (§1.8), because four list panes want one clamping cursor and
ADR-0001 leaves them no sibling package to share it from; and `useKeyCapture` plus
`CommandSpec.capture` (§1.7, §5.8), because a pane rendering a `<textarea>` has to silence
every other binding without introducing a raw key handler beside the Command unit. Each is
public API rather than core-private for the same reason: a third-party list pane or editor
pane must be able to build exactly what the bundled ones did.

Reviewing them closed the gap this note used to leave open — **nothing public could
scroll a pane's viewport** — and added three more surfaces for the same reason as the four
above. `useScrollView` and `ListCursor.scrollRef` (§1.8) are the scroll seam: OpenTUI's
`<scrollbox>` scrolls only for a renderable holding the terminal's focus, and laziergit gives
no renderable that focus, so five real panes (four lists and the diff) had no way to move
their own viewport. `PaneHandle.reveal` (§1.8) is what makes `DiffApi.show` honest — the diff
pane is tab-grouped with `commit-flow`, and `focus()` was the wrong verb for a pane following
someone else's cursor. `literalPathspec` (§1.5) is the smallest fix for the largest bug the
review found: git globs the paths it is given, `--` does not stop it, and an unwrapped path in
a `raw` argv acts on the user's other files.

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
  useListCursor,
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
      const branch = useGit((s) => (s.head.kind === "onBranch" ? s.head.branch : null));
      const [runs, setRuns] = useState<readonly Run[]>([]);
      const [error, setError] = useState<string | null>(null);
      // j/k/g/G, clamped to the list, in one line — every list pane wants the same
      // cursor, so it is API rather than four copies of the same useState (§5.11).
      const cursor = useListCursor({ items: runs, idPrefix: "gh-workflows", noun: "run" });

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
        // No cursor reset: the cursor clamps itself to a shorter list, and a refresh
        // that returns the same runs should leave you where you were looking.
        setRuns(JSON.parse(res.stdout) as Run[]);
      }, [branch]);

      useEffect(() => { void refresh(); }, [refresh]); // initial load + every branch change
      useEvent("gh-workflows.refresh", refresh);       // palette command below

      // A pane-scoped command: active only while this pane is focused, disposed on
      // unmount, listed in the cheat sheet. Also a palette entry — running it from the
      // palette focuses this pane first (focus-then-run), so the selection it acts on
      // is the visible one.
      useCommand({
        id: "gh-workflows.open-run",
        title: "Open workflow run in browser",
        // One registration, three surfaces: the key, the cheat sheet row, and — because it
        // carries a `hint` — the hint bar while this pane is focused (§1.10).
        hint: "open",
        keys: "o",
        run: async () => {
          const run = cursor.selected;
          if (run) await ctx.open(run.url);
        },
      });

      if (error) return <text fg={theme.danger}>{error}</text>;
      if (!branch) return <text fg={theme.textMuted}>detached HEAD — no runs</text>;
      if (runs.length === 0) return <text fg={theme.textMuted}>no runs for {branch}</text>;

      return (
        // Every prop here is load-bearing. `scrollRef` plus the rows' `rowId` keep the
        // selected row — the row every key acts on — inside the viewport. `flexBasis={0}`
        // stops the box being sized by its *content*: a list longer than the pane would
        // make it taller than the pane and paint over its neighbour instead of scrolling.
        // `focusable={false}` keeps it out of OpenTUI's single focus slot, which belongs
        // to the popup layer's inputs.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {runs.map((run, i) => {
            const { glyph, color } = icon(run, theme);
            const selected = i === cursor.index;
            return (
              // `wrapMode="none"` is not optional decoration: without it a long run title
              // reflows over two lines and the list stops being a list (§1.8).
              <text
                key={run.databaseId}
                id={cursor.rowId(i)}
                wrapMode="none"
                bg={selected && focused ? theme.selection : undefined}
                onMouseDown={() => cursor.setIndex(i)}
              >
                {/* The highlight is the whole of the cursor — no `❯` beside it. Every
                    bundled list Pane made the same trade: a marker said a second time what
                    the bar already says, in the two columns a narrow pane can least spare.
                    It buys a real cost, which is that an unfocused pane marks nothing. */}
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
  "layout": { "columns": [["files", "branches", "gh-workflows"], ["diff"]] },
  "keybindings": { "gh-workflows.open-run": "return" } // user override beats the default "o"
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
          // Deliberately the branches menu's own `o`, which opens the *compare* page for
          // the branch. A splice outranks the owner's item (§5.7), so on a branch that has
          // a pull request this replaces it with a link to that pull request — and on one
          // that does not, `when` stands the splice down and the owner's item is back.
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

The bundled rows print no age of their own — one line per row leaves no column for it, and
"how old" is a question most sessions never ask (§1.8). That makes this the demonstration
that a decoration adds back exactly what core left out, for the people who do ask.

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
      const branch = useGit((s) => (s.head.kind === "onBranch" ? s.head.branch : null));
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

### 4.3 conventional-commit — popup flow + a hand-off to `commit-flow`

Composes a conventional-commit subject through prompts, then hands the draft to the bundled
commit editor instead of committing blind — so the user still reviews it, adds a body, and
submits in the standard UX. Exercises `needs` → typed `ctx.extensions.get`, and
`CommitFlowApi.begin`'s {@link CommitFlowResult} to learn whether the message landed.

```ts
import { defineExtension } from "laziergit";

const TYPES = ["feat", "fix", "chore", "docs", "refactor", "test", "perf"] as const;

export default defineExtension({
  name: "conventional-commit",
  description: "Compose a conventional-commit subject, then open it in the commit editor",
  needs: ["commit-flow"], // ← makes ctx.extensions.get("commit-flow") legal and typed

  activate(ctx) {
    ctx.commands.register({
      id: "conventional-commit.create",
      title: "Commit (conventional)",
      // `shift+c`, not `"C"`: a bare letter binds its lowercase stroke, so `"C"` would claim
      // the same `c` as the bundled `commit-flow.commit` and one would shadow the other.
      keys: "shift+c",
      pane: "files", // contextual: bound while the bundled files pane is focused
      run: async () => {
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

        // Hand the composed subject to the standard commit UX rather than committing blind:
        // `begin` prefills the editor and focuses it, the user finishes and submits, and the
        // promise resolves with how the flow closed. commit-flow owns the commit rules
        // (empty message, nothing staged) — this extension only composes.
        const message = `${type}${scope ? `(${scope})` : ""}: ${subject}`;
        const result = await ctx.extensions.get("commit-flow").begin({ message });
        if (result === "committed") ctx.popups.notify("Committed", "success");
      },
    });
  },
});
```

### 4.4 stash-preview — a second pane, `useGit` + raw git in a component

```tsx
/** @jsxImportSource @opentui/react */
import { defineExtension, useCommand, useGit, useListCursor, useTheme, type PaneProps } from "laziergit";
import { useEffect, useState } from "react";

export default defineExtension({
  name: "stash-preview",
  description: "Stash list with inline diff preview",
  activate(ctx) {
    function StashPane({ focused }: PaneProps) {
      const theme = useTheme();
      const stash = useGit((s) => s.stash);
      const [diff, setDiff] = useState("");
      // j/k/g/G, the clamp, and the scroll-into-view, in one line. This example originally
      // hand-rolled the first two out of `useState` and two `hidden` Commands — which is
      // exactly the duplication that made the cursor API rather than four copies (§5.11).
      const cursor = useListCursor({ items: stash, idPrefix: "stash-preview", noun: "stash" });
      const entry = cursor.selected;

      useEffect(() => {
        if (!entry) return setDiff("");
        // `cancelled` is the async tail (§5.3): move the cursor twice quickly and two reads
        // are in flight, so without this the slower one can land last and show the wrong
        // stash's patch. `ctx` stays valid across the await; the *component* may not.
        let cancelled = false;
        void ctx.git.raw(["stash", "show", "-p", `stash@{${entry.index}}`])
          .then((out) => { if (!cancelled) setDiff(out.stdout); });
        return () => { cancelled = true; };
      }, [entry?.oid]);

      // One `<diff>` renders one file (§5.11): handed a patch spanning several it draws the
      // first and says nothing about the rest — and a stash almost always spans several. The
      // boundary is unambiguous because `diff --git` can only begin a line at column 0 in a
      // header; every line inside a hunk starts with ` `, `+`, `-` or `\`.
      const files = diff.split(/^(?=diff --git )/m).filter((section) => section.trim() !== "");

      useCommand({ id: "stash-preview.pop", title: "Pop stash", hint: "pop", keys: "p",
        run: async () => { if (entry) await ctx.git.stash.pop(entry.index); } });

      if (stash.length === 0) return <text fg={theme.textMuted}>no stashes</text>;
      return (
        <box flexDirection="column">
          <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
            {stash.map((s, i) => (
              <text
                key={s.oid}
                id={cursor.rowId(i)}
                wrapMode="none"
                bg={i === cursor.index && focused ? theme.selection : undefined}
                onMouseDown={() => cursor.setIndex(i)}
              >
                {`stash@{${s.index}} ${s.message}`}
              </text>
            ))}
          </scrollbox>
          {files.map((patch, i) => (
            <diff key={i} diff={patch} view="unified" />
          ))}
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

An early sketch of the extension anatomy had an `api` field on the spec; this
design realizes it as the return value of `activate` (VS Code precedent). Reasons: the API almost always closes over state built during activation (the
`byBranch` cache in github-prs); a separate field would either run before that state exists,
need its own factory-with-ctx lifecycle, or force shared state into module scope; and inference
is free — `ExtensionApiOf<typeof extension>` extracts it with zero duplication, so the declared
type can never drift from the implementation. `Api = void` when you return nothing, so simple
extensions never see the concept. The anatomy decision deliberately left the exact shape open
to design, which is what sanctions the move: every sketched field is realized, with `api`
realized as data flow rather than a slot.

### 5.3 Disposal and hot reload

`ctx` **is** a per-activation scope: one internal Effect `Scope` owns a removable JavaScript
finalizer/supervision registry. Every registration — Commands, Panes, menus, events, statusline
segments, subscriptions — attaches to it on creation; the returned `Disposable` is only for
*early* teardown. Hot reload = file save → deactivate ripple (below) → `deactivate?()` with ctx
still live → synchronously mark stale and close the scope (registrations unwind sequentially in
reverse order, async cleanup is awaited, fibers interrupted) → re-import from a
generation-unique source copy → `activate` with a fresh ctx. (OpenTUI's runtime rewrite loader canonicalizes query strings before Bun's module
cache sees them, so query-parameter cache busting does not work here. A sibling source copy
preserves relative imports and local dependency resolution; directory Extensions copy their
whole source tree so imported helpers reload too.) The old ctx and every API object hanging off
it is then **poisoned**: every member *access* (properties included, so `ctx.config` and
`ctx.git.state` too) throws
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

1. `ctx.extensions.get(...)` returns a Core-owned proxy of the provider's API, including callable
   APIs. Method and function results share one processor: PromiseLike values are supervised, and
   any `Disposable` they return (including callable values with `dispose`) is auto-attached to the
   **caller's** scope — so `branches.decorateRows(...)` in github-prs is cleaned up when
   *github-prs* reloads, not leaked into the branches Extension.
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
`ExtensionApis`, config sections), so collisions are resolved, never merged: an extension from a
higher-precedence scope shadows a same-named one from a lower (`bundled` < `global` < `repo`, so
your copy of a bundled extension simply replaces it — diagnostic logged, naming the winning
scope, the same precedence as config merging), and a second same-named extension in the same
scope is a load error.

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
tuple trick rather than a nullable payload. `emit` snapshots subscriptions synchronously, then
each subscription advances its own FIFO queue. Handler errors are caught per delivery and logged;
a slow, failed, or retired subscriber never starves another subscription or fresh activation.

### 5.6 Config schema → typed values

`option.*` builders are tiny runtime objects that (a) return one variant of the `ConfigOption`
union, whose own `default` type is what `ConfigValues<S>` reads — no phantom parameter, and no
way for `kind` and `default` to disagree — and (b) compile to JSON Schema for validation and
config.jsonc editor autocomplete. Constraints live on the variants that have them (`min`/`max`
on number, `values` on enum), which is what lets the config reader and the schema generator
narrow on `kind` instead of each declaring a wider shadow type and widening into it. Two
opinionated constraints keep the types honest: every option **must have a default** (so
`ctx.config` is total — no `| undefined` to fumble), and v1 values are flat scalars / string
arrays (objects would force a schema language; revisit post-v1). A default that its own bounds
exclude throws at definition time rather than silently becoming the fallback nobody sees. Merge
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
hidden, never grayed-out-but-activatable); key conflicts resolve by position in the merged
menu — owner groups first, splices appended after — with a logged diagnostic, so a splice
outranks the owner's own item whatever order the two registered in. Deliberately *not* the
keymap's last-registration rule: the owner re-registers its spec on every hot reload, which
under recency would hand it back every key a splice had taken. The loser is dropped rather than
left keyless, because a menu item has no palette row to survive in the way a Command that loses
a key does. Groups carry a stable `id` for splice addressing
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
extension's pane (conventional-commit binding `shift+c` in the files pane).

Pane-scoped commands stay palette-complete because palette execution is **focus-then-run**
(§1.7): the pane is focused, then the latest render's handler runs — so "open the selected
run" is one `useCommand`, not a `useCommand` plus a global twin. For the reverse direction,
`activate`-scope code reaching *into* a component, there are exactly two channels: a custom
event (the invoke channel — "do something now") and `createCell` (the data channel — "here is
the latest value"). Selection state, meanwhile, flows outward by a different door entirely:
export it, the way the bundled `RowSource.selected()` does.

**A pane that owns the keyboard.** The one case that looks like it wants a raw key handler is
a pane rendering a `<textarea>`: while you type a commit message, `q` must not quit. It gets
`useKeyCapture` instead, which changes *which layers are enabled*, not *how keys are handled*
— exactly what a popup does, one priority band lower (global < pane < capture < popup). The
exit keys stay ordinary Commands marked `capture: true`, so they are still rebindable, still
in the catalog, and still visible before you enter the editor. That is the whole reason the
feature is a flag on `CommandSpec` and a hook that takes a boolean, rather than an
`onKey(event)` that would take the Command unit out of the loop for the one pane that has the
most keys to explain.

The cheat sheet follows from the same principle: it answers "what can I press", so while a
pane captures it collapses to that pane's capture commands and nothing else — listing `q` as
"Quit" while `q` types the letter q would be a lie. Otherwise it is the **focused pane's**
sheet: that pane's ordinary keys, then its capture commands (which is where you read them —
before opening the editor, since `?` is inert once you are inside it), then the globals last.
Other panes are not listed at all. A sheet that enumerated every live pane answered a
question nobody asked — most of it was keys that do nothing until you tab elsewhere — and the
globals trail rather than lead because they are the same on every screen, but the pane-jump
keys are global commands and this is the only place they are written down.

Unlike the palette, the sheet keeps `hidden` commands: `j`/`k`/`g` are exactly what someone
opening it wants confirmed, and the compact answer for everything else is now the hint bar
(§1.7), which leaves the sheet free to be the complete one. The pane-jump keys are the other
reason that rule earns its keep — they are `hidden`, because nine "Focus …" rows beside every
pane's own focus command would drown the palette, and the sheet is where they have to be
legible. The sheet sizes its window to the terminal for the same reason: an answer you have
to scroll to reach is only half an answer.

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

**What containment does not cover: an extension that never finishes.** Every row above catches
a *throw*; none of them catches a *hang*. `deactivate()` is awaited, and so is the scope close
that drains finalizers, so an extension whose `deactivate` never settles — or whose finalizer
does not — wedges reload and quit for the whole app. There is no timeout, deliberately:
bounding the drain would race a still-running finalizer against the next activation, which is
exactly the hot-reload corruption the per-activation scope exists to prevent (§5.3). Under
ADR-0001's in-process, full-trust model a hung extension is the one failure the host cannot
contain, and it is cheaper to say so than to trade a wedged quit for a corrupted reload. (The
renderer still handles ctrl+C independently of the kernel, so the process itself is killable.)

### 5.10 Implementation mapping (public API → vendored mechanism)

| Public API | Internal mechanism |
|---|---|
| `ctx.panes.register` / statusline segments | `@opentui/react` slot registry plugin per pane/segment; the Layout renders one slot per configured id; the registry's built-in error boundary + failure placeholder provide containment for free |
| Commands + `keys` / `useCommand` | `@opentui/keymap` command catalog + `registerLayer({ enabled, bindings })`, one layer per scope; pane scoping → a reactive matcher over laziergit's own focus model rather than renderer focus, so which pane owns the keyboard never depends on which Renderable holds the cursor; `useCommand` re-points handlers via a latest-ref; palette + cheat sheet read the resolved command catalog; `mod+` via a laziergit binding expander (cmd only where the keyboard protocol can report it), `<leader>` via the leader addon |
| `useKeyCapture` / `capture: true` | priority bands, not a separate input path: global 0 < pane 100 < capture 500 < popup 1000. A capture disables the global and pane matchers and enables the capturing pane's capture layer; claims stack in the kernel so nested editors unwind in any order, and a capture is only honored while its pane is focused |
| Menus | plain data + one generic popup component; an open menu pushes a modal high-priority keymap layer |
| Registrations / `onDispose` | Effect `Scope` per activation owning a removable LIFO finalizer/supervision registry; `dispose()` = early finalizer run; consumed-API proxy attaches foreign Disposables to the caller's scope |
| Hot reload | linked-target-aware extension fingerprint poll → reverse-topo deactivate → synchronous stale mark → lease-backed generation copy import → topo activate; serialized reload tails heal after failures |
| `ctx.git` / `useGit` | git plumbing service (argv shell-out, Effect-internal: `Effect.callback` per child, lock retry on a `Schedule`, one concurrent fan-out per refresh) + snapshot store reconciled so unchanged slices and rows keep identity; React via `useSyncExternalStore`; ~2s fingerprint poll (`status --porcelain=v2`, `show-ref --head`, `stash list`, `config --get-regexp` — §5.12), post-write refresh, and a refresh on the renderer's terminal-focus event |
| `ctx.events` | emit-time subscription snapshot; per-subscription FIFO delivery; disposal skips queued work; per-delivery catch |
| `"laziergit"` module | `ensureRuntimePluginSupport({ additional: { laziergit } })` from `@opentui/react/runtime-plugin-support/configure`, imported before anything else — the FIRST install must carry the extra specifier: a later install that adds one the first lacked throws, while later installs without extras are compatible no-ops — so extension imports share the Core's React/OpenTUI/laziergit instances; works in `bun build --compile` binaries |

### 5.11 Deliberately absent

- **Git write interceptors** (`git.intercept` / `GitBlockedError`) — the push-guard
  interceptor experiment from the corpus (§0) motivated them, but they are an extension point
  beyond the v1 list with real hazards
  (classifying mutating argv for `raw`, popup-inside-awaited-git reentrancy); cut for v1 —
  smallest surface wins over one hypothetical extension; revisit with a real queueing design.
- **`ctx.log`** — `console.*` is captured by the host, tagged with the extension name, and
  routed to the log file / debug pane.
- **A patch-level staging helper** (`stageHunk` / `stagePatch`) — v1 staging is file-level, so
  `stage`/`unstage`/`discard` take paths and nothing else. Hunk and line staging are post-v1,
  and `raw` already carries them: `RawOptions.stdin` exists precisely so
  `git.raw(["apply", "--cached"], { stdin: patch })` works today. A helper can be added once a
  real patch-building UI has shown what shape it wants; guessing now would ship a signature
  the first honest consumer has to fight.
- **Credential prompting** — every git invocation runs with `GIT_TERMINAL_PROMPT=0`, so a
  remote that wants a username or password fails immediately with git's own message instead of
  blocking forever on a prompt nobody can answer: laziergit owns the terminal, and git's stdio
  is piped. SSH keys via an agent, and any configured credential helper, work untouched.
  Interactive authentication needs a pty and prompt detection (lazygit's approach) and is
  post-v1; until then `push`/`pull`/`fetch` surface the failure as an ordinary {@link GitError}.
- **A multi-line prompt** — {@link PopupToolkit.prompt} is one line by design. A commit message
  is not a prompt: it is an editing surface with its own layout, validation, and keys, so the
  bundled `commit-flow` renders one from OpenTUI's `<textarea>` in the Pane it already owns.
  Any extension can do the same — `useKeyCapture` is the piece that makes it safe, silencing
  every other binding while the editor has the keys (§5.8) — and widening the popup toolkit
  would make every caller pay for the one case that needs it.
- **Soft dependencies** (`extensions.find`) — an optional lookup has no ordering guarantee,
  reintroducing exactly the staleness `needs` + ripple restart exist to prevent; declare the need.
- **Semver ranges on `needs`** — extensions are source-compiled TS checked against the host's
  declarations at import; a version-negotiation layer buys nothing an activation error doesn't.
- **Config-change / theme-change events** — config changes reload affected Extensions (§5.6),
  while config theme selection, terminal appearance, picker preview, and theme-resource hot
  reload all publish through a per-kernel external store and reflow through `useTheme` without
  reactivation or remount. `ctx.config` is a constant plain object.
- **An imperative statusline API** (`set(key, {text, tone})`) — segments are React components
  like every other UI surface; one paradigm, and `useGit` replaces manual event wiring.
- **A blessed list/table component kit** — OpenTUI's primitives plus `useCommand` cover the
  *rendering*; a list pane composes `<box>`, `<text>`, and a highlight itself, and nothing here
  imposes a row shape, a column model, or a scroll container. What the bundled panes did prove
  out is the invisible half, and it was promoted rather than duplicated: `useListCursor` (the
  cursor and its `j`/`k`/`g`/`G`) and `createRowSource` (the decoration providers, their
  per-field merge, and the selected row). ADR-0001 gives `extensions/*` no sibling package to
  share code through, so a shared component is public API or it is copy-paste — and four copies
  of a clamping cursor is exactly the entropy this list exists to prevent. The line held is
  behavior over chrome: laziergit ships the parts that must agree with the core (the command
  catalog, the decoration contract) and none of the parts that are just markup.
  **Closed in M4, the way this note asked for:** owning no scroll *container* had meant
  owning no scroll *behavior* either, and every bundled list pane walked its cursor off the
  bottom of its own `<scrollbox>` while the diff pane showed one screenful of a patch and
  nothing else. Five real consumers made the shape knowable, so the seam shipped as the ref
  this note predicted — {@link ListCursor.scrollRef} and {@link useScrollView} — and not as
  a component kit. Extensions still write their own `<scrollbox>`, their own rows, and their
  own highlight; what they no longer write is the arithmetic that has to agree with the
  cursor. `ScrollSurface` is structural, so the seam adds no import an extension is not
  already allowed to make. The first version of it *did* still make a pane write that
  arithmetic: the reveal took an item index and used it as a screen row, so `files` — whose
  group headers make the two differ — had to wrap the surface in a getter/setter proxy that
  shifted `scrollTop` in both directions. The seam now reveals rows by id
  ({@link ListCursor.rowId} → {@link ScrollSurface.scrollChildIntoView}), which is OpenTUI
  measuring where it actually drew the row, so headers, multi-line rows and an eventual
  collapsible tree cost a pane nothing. Two coordinate systems that have to agree is a model
  to keep in step; asking layout is not.
- **Toast/progress/spinner APIs beyond `notify`** — a pane that owns long work renders its own
  state. **Partly reversed in M5**, and the reasoning was wrong in a specific way worth
  recording. "The pane that owns the work renders it" assumes the pane that *starts* the work is
  the one with somewhere to draw it, and across the bundled set it usually is not: `commit-flow`
  owns a commit a pre-commit hook can hold for thirty seconds while its editor sits there looking
  hung, and the push at `branches/index.tsx:185` is a network round trip with no surface of its
  own at all. Every extension having to opt in produced exactly what you would expect — `sync`
  did, nobody else did, and the status line went blank on a push instead. What was actually
  missing was not a rendering API but the *fact*: core runs every write, so core is the only
  thing that can know about all of them. {@link useGitActivity} exposes that fact and nothing
  else. The bullet still holds for the part it was really defending: core owns no progress
  *surface* — no `ctx.progress.start()` handle, no spinning toast, no imperative
  `statusline.setBusy`. Who draws, and what it looks like, stays with the extension; the sync
  segment's loader is its own component and its own frame table.
- **A `disabled` state on menu items** — `when` hides; a visible-but-inert item is presentation
  subtlety v1 skips (hiding unsuitable entries is Magit's default too).
- **A `signal` on `ExecOptions`** — scope supervision already kills the child and parks the
  promise at deactivation (§5.3); a per-call AbortSignal would duplicate the one lifetime that
  matters. `ctx.signal` covers the non-ctx async you manage yourself.
- **Activation events / lazy loading / manifests** — everything loads eagerly; extensions are
  single files that import in milliseconds under Bun, and hot reload makes eager loading free.
  A declarative manifest can be derived later from `defineExtension`'s data fields without
  breaking anyone.
- **A multi-file diff in one `<diff>`** — OpenTUI's `DiffRenderable` parses and lays out a
  *single* file's unified patch; handed a diff that spans several files it renders only the
  first. The bundled `diff` pane therefore splits a multi-file patch into one section per file
  and renders a `<diff>` for each (filename above), which is also what lets it label and
  highlight each file and print "no textual diff" for a binary or mode-only section. An
  extension rendering its own diffs must split the same way; an upstream `<diff>` that accepts a
  multi-file patch would let the pane drop the split with no change to this API.
- **Sizing a Pane from its `placement` hint** — {@link PlacementHint} *places* a Pane (column,
  order, `tabWith`) but carries no *size*: a hint-placed column always takes an equal width
  share and cells split their column's height evenly. Column `weight` is config-only
  (`layout.columns[].weight`), and per-cell height has no control at all yet. Likewise the
  default startup focus lands on the Layout's first cell rather than the first Pane with rows to
  walk (config `layout.focus` overrides it). These are layout refinements with known shapes,
  post-v1 (see the roadmap in architecture.md) — not API gaps.
- **A second fake-renderer acceptance layer.** Tests about pure logic, lifecycle, argv, and git
  effects stay in the fast harness; tests about what a person sees or what a real keypress does
  run through Terminal Control against `main.tsx` in a real PTY. The focused `test:e2e` suite
  covers the everyday cross-extension flows and runs separately on macOS and Linux in CI, so the
  default unit loop stays fast. Terminal Control 0.6.0's typed client does not expose OpenTUI's
  semantic snapshot even though the host adapter publishes it, so these tests currently wait on
  settled visible text; [the primary-source research](./research/terminal-control.md) records that
  deliberate fallback and the upgrade path.
- **NOT absent, on purpose: `ctx.exec`.** `Bun.$` remains fully available (full trust), but
  `exec` stays because its repo-root cwd default is a correctness detail that must live inside
  the `.d.ts` an agent learns from — forgetting `.cwd(ctx.git.root)` on `Bun.$` is the kind of
  silent bug types exist to prevent.

### 5.12 What the git store watches, and the one state its types cannot spell

**Watching.** There is no fs-watching of `.git` (ADR-0001's git-service note, and lazygit's
own conclusion). The store refreshes after every write laziergit issues, and otherwise on a
`git.refreshIntervalMs` tick (default 2s, see [config.md](./config.md)) that reads four cheap
things and re-reads the repository only if one of them differs. Each covers a class of change
the others are blind to: `status --porcelain=v2` for working-tree edits, which move nothing
under `.git` at all; `show-ref --head` for commits, checkouts, and fetches; `stash list`,
because dropping any entry but the top one rewrites only the stash *reflog* and leaves
`refs/stash` byte-identical; and `config --get-regexp '^(remote|branch)\.'` for what is
configured rather than committed — a remote added, or an upstream set on a branch that is not
HEAD. None of them touches an object, and all of them suppress optional locks, so the poll can
neither contend with the user's own `git` nor dirty the index and thereby trigger itself. The fingerprint is recorded by the refresh that
publishes, so the tick after any write is quiet. A full refresh also runs whenever the
terminal regains focus — switching back from the terminal you just ran `git` in is both the
likeliest moment for the screen to be stale and the least tolerable moment to wait out an
interval.

**What git can say and the model cannot.** Three such states have been fixed, when the
Bundled Extensions made the cost of leaving them concrete. An **unborn HEAD** used to be
`Head.oid === ""` — unambiguous, since no object is named `""`, but implicit, and a shape a
consumer could hand back to git; `Head` is now a union whose `unborn` variant simply has no
oid, and which also drops the upstream a detached HEAD never had. A **gone upstream** used
to collapse to `{ ahead: 0, behind: 0 }`, identical to a perfectly in-sync branch, which is
the one thing a branches Pane most wants to tell apart; `UpstreamInfo.gone` now says it.
(The branches Pane spends the flag on *colour* rather than a word — one-line rows have no
column to spare for text that is usually absent — but that is a rendering choice the flag
made available; without it there is nothing to render.)
Both were cheaper to change while nothing depended on the old shapes, which is why they went
in with the first Extensions rather than after them.

**No repository** was the third, and it is the one that shows what the ledger is for. It
used to be an unborn HEAD carrying `branch: ""` — a name no refname can have, so unambiguous
in the same way `oid === ""` was, and wrong in the same way. By the end of M4 five of the
then-eight Bundled Extensions decoded that empty string at six sites under three different names,
two of them having built a local union purely to repair it, and `commit-flow` was reading
`kind === "unborn"` to mean "no commit to amend" — correct only by accident, because the
state it actually needed to exclude was hiding inside the variant it tested. `Head` now has
a fourth variant, `{ kind: "noRepository" }`, and the six decoders are gone. The lesson is
the cost curve, not the encoding: the first two were fixed while nothing depended on them
and cost nothing; this one waited until six things did, and the repair had to reach into
five Extensions and a semantic bug none of the types could see.

Both of the two that used to remain here are now closed, by the same change (ADR-0005).

**Which side of a conflict** and **which side of the index a `FileChange` is on** were one
gap wearing two hats. Porcelain v2 spells an unmerged path as `UU`, `AA`, `DU`, and so on,
and `ChangeKind` had one `"conflicted"` value to put it in; separately, a path modified in
both the index and the working tree (`MM`) produced *two* `FileChange` values in two arrays,
each carrying one `kind`, with the group heading the row was drawn under as the only record
of which side it described. Both were the same discarded fact: git's `XY` pair.

`FileChange` is now one entry per path carrying both columns — `index` and `worktree` on the
`"changed"` arm, `ours` and `theirs` on the `"conflicted"` one. The files Pane draws the pair
as two status columns and needs no headings, which is what let it become a folder tree; a
decorating Extension can now tell the staged side from the unstaged one, and the two lines
that used to share a decoration slot are one line.

This one waited for its consumer and was cheaper for it — but only just. The conflict half
was previously written here as something that "should land with the conflicts UI rather than
ahead of it"; the two-column render turned out to be the consumer, because a row that can
only print one glyph for a conflict discards which side did what on precisely the rows where
that is the entire question.

One remains, deliberately:

- **A directory row is not a `FileChange`.** The files Pane draws folder rows, and
  {@link FilesApi} is a `RowSource<FileChange>` — so `FilesApi.selected()` answers
  `undefined` while the cursor is on a folder, a `decorateRows` provider is never handed one,
  and the folder action menu is built ad-hoc rather than registered, so nothing can splice
  into it. That is deliberate for v1: a decoration ("PR #42", "90d") is a property of a file,
  and the alternative — widening `files.actions`' payload to a union — would make every
  third-party splice handle a case it never asked for. The fix, when something needs it, is a
  row-type union in the public API, and it belongs with its first consumer.

**Conflicts in v1: show and delegate.** The bundled `files` extension draws conflicted paths
with git's own `UU` / `AA` / `DU` pair wherever they sit in the tree, marks every directory
above them `!`, offers "open in editor" and "stage resolved" from `files.actions`,
and otherwise stays out of the way — resolution happens in the user's editor or `git
mergetool`. It is deliberately less than lazygit, which renders a pick-ours / pick-theirs /
pick-both hunk picker; that is post-v1 (see the roadmap in architecture.md) and is the work that will want the
patch-level staging surface §5.11 leaves out. Nothing here
is privileged: a third-party extension can register a conflicts Pane and splice into
`files.actions` today, on exactly the API the bundled one uses.
