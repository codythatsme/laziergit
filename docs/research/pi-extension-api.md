# Research: pi's Extension System (badlogic / earendil-works)

Research for **laziergit** — a lazygit-inspired git TUI with a light core and a TypeScript plugin API.
Method: shallow-cloned the repo and read the actual source (commit `216e672e7c9fc65682553394b74e483c0c9e47f7`, 2026-07-16, version **0.80.10**). Local clone at `/private/tmp/claude-501/-Users-codythatsme-Developer-laziergit/6e44eabb-9d73-47f2-867b-8bfae83e2696/scratchpad/pi-mono`.

---

## 0. Repo identity, license, size (verified)

- **The repo has been renamed/moved**: `github.com/badlogic/pi-mono` now serves **`earendil-works/pi`** (GitHub redirect; issue links in the changelog point at `github.com/earendil-works/pi`). Description: "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI". ~71.9k stars as of 2026-07-17. Source: https://github.com/badlogic/pi-mono (redirects).
- **License: MIT** (root `LICENSE`, "Copyright (c) 2025 Mario Zechner"; every workspace package.json also declares `"license": "MIT"`). Safe to vendor for reference.
- npm packages were renamed **`@mariozechner/*` → `@earendil-works/*`**; the extension loader aliases *both* scopes so old extensions keep working (see §2).
- **Monorepo structure** (npm workspaces, Node >= 22.19, all packages version-locked at 0.80.10):

| Package | npm name | src LoC (`.ts`) | Role |
|---|---|---|---|
| `packages/ai` | `@earendil-works/pi-ai` | 38,411 | unified LLM API, providers, OAuth |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | 53,167 | the pi CLI; **extension system lives here** |
| `packages/agent` | `@earendil-works/pi-agent-core` | 8,244 | agent loop |
| `packages/tui` | `@earendil-works/pi-tui` | 12,166 | custom TUI framework (NOT React) |
| `packages/orchestrator` | `@earendil-works/pi-orchestrator` | 1,982 | multi-agent orchestration |

- Whole shallow clone: ~24 MB, 851 `.ts` files. The extension subsystem itself is tiny and readable: `packages/coding-agent/src/core/extensions/` = `types.ts` (1,674 lines), `loader.ts` (708), `runner.ts` (1,189), `wrapper.ts` (45), `index.ts` (184) — **~3,800 lines total for the whole plugin system**.
- 79 entries in `packages/coding-agent/examples/extensions/` (from a `hello.ts` tool to plan-mode, snake, Doom-in-an-overlay, SSH remote execution, sandboxing, custom providers).
- Docs: `packages/coding-agent/docs/extensions.md` (2,911 lines) is the definitive extension guide. Also `packages.md` (distribution), `sdk.md`, `rpc.md`.

Sources:
- https://github.com/badlogic/pi-mono (→ earendil-works/pi)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts

---

## 1. How extensions are authored, discovered, loaded

### Authoring model
An extension is **a TypeScript (or JS) module whose default export is a factory function** receiving the API object. No manifest, no class, no metadata block required — the file *is* the extension:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => ctx.ui.notify(`Hello ${args || "world"}!`, "info"),
  });
}
```

The factory may be `async`; pi awaits it before continuing startup (so async init finishes before `session_start`). Docs explicitly warn factories not to start long-lived resources (they may run in invocations that never start a session) — defer to `session_start`, and clean up in `session_shutdown`.

```ts
/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
  | ExtensionFactory
  | { name: string; factory: ExtensionFactory };
```

### Discovery (loader.ts `discoverAndLoadExtensions`, verified in source)
Order, deduplicated by resolved path:
1. **Project-local**: `<cwd>/.pi/extensions/` — only loaded after the project is trusted (see trust model, §4).
2. **Global**: `~/.pi/agent/extensions/`.
3. **Explicitly configured** paths from `settings.json` (`"extensions": [...]` and `"packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"]`) and the CLI `-e/--extension` flag (temporary install for the run).

Per directory, three shapes (no recursion beyond one level — deliberate):
1. Direct files `*.ts` / `*.js` → loaded as single-file extensions.
2. Subdirectory with `index.ts`/`index.js` → loaded as multi-file extension.
3. Subdirectory with `package.json` containing a **`"pi"` manifest field** → loads what it declares:

```json
{
  "name": "my-extension",
  "dependencies": { "zod": "^3.0.0" },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

The manifest type (loader.ts):
```ts
interface PiManifest {
  extensions?: string[];
  themes?: string[];
  skills?: string[];
  prompts?: string[];
}
```
The same manifest powers **pi packages**: distributable bundles of extensions/skills/prompts/themes installed via `pi install npm:...` / `git:...` / local path (docs/packages.md). Versioned npm specs are pinned; `pi update --extensions` updates the rest.

### Import mechanism — **jiti** (verified: loader.ts line 1 comment "loads TypeScript extension modules using jiti")
```ts
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  // In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
  // Also disable tryNative so jiti handles ALL imports (not just the entry point)
  // In Node.js/dev: use aliases to resolve to node_modules paths
  ...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
});
const module = await jiti.import(extensionPath, { default: true });
```
Key facts:
- **TypeScript runs without a compile step** (jiti transpiles on import). `import { createJiti } from "jiti/static"`.
- `moduleCache: false` + pi's own factory cache (`extensionCache`, keyed by path, invalidated by cwd change or `clearExtensionCache()`) is what makes **hot reload** work.
- **Dual-runtime strategy**: pi ships both as an npm package (Node) and a compiled **Bun binary**. In the binary, host packages can't be resolved from disk, so the loader statically imports them and exposes them to extensions via jiti's `virtualModules`; in Node it uses jiti `alias` maps. Both the old `@mariozechner/*` and new `@earendil-works/*` names map to the same bundled modules — that's their backward-compat story for the rename.
- Extensions may use **npm dependencies**: put a `package.json` + `node_modules` next to the extension; jiti resolves them naturally. Node built-ins available. For distributed packages, runtime deps must be in `dependencies` (installs use `npm install --omit=dev`).
- Guaranteed-available imports for extensions: `@earendil-works/pi-coding-agent` (types), `typebox` (tool schemas), `@earendil-works/pi-ai`, `@earendil-works/pi-tui`.

---

## 2. The extension API surface

Two objects matter: **`ExtensionAPI`** (`pi`, given to the factory — registration + actions) and **`ExtensionContext`** (`ctx`, given to every event handler / tool execute / command handler — live app state + UI).

### `ExtensionAPI` (types.ts, abridged to signatures; full file is 1,674 lines)

```ts
export interface ExtensionAPI {
  // --- Event subscription: ~35 typed on() overloads (full list in §3 below)
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
  // ... etc

  // --- Registration
  registerTool<TParams extends TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>): void;
  registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
  registerShortcut(shortcut: KeyId, options: {
    description?: string;
    handler: (ctx: ExtensionContext) => Promise<void> | void;
  }): void;
  registerFlag(name: string, options: {
    description?: string; type: "boolean" | "string"; default?: boolean | string;
  }): void;
  getFlag(name: string): boolean | string | undefined;
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

  // --- Actions
  sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
  sendUserMessage(content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" }): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;   // session-persisted, NOT sent to LLM
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  setActiveTools(toolNames: string[]): void;
  getCommands(): SlashCommandInfo[];
  setModel(model: Model<any>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  registerProvider(name: string, config: ProviderConfig): void;   // add/override LLM providers
  unregisterProvider(name: string): void;

  /** Shared event bus for extension communication. */
  events: EventBus;   // { emit(channel, data); on(channel, handler): unsubscribe }
}
```

Handler type (note: return value is the extension's "vote" on the event):
```ts
export type ExtensionHandler<E, R = undefined> =
  (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

### `ExtensionContext` (verbatim from types.ts)

```ts
export interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: ExtensionMode;                    // "tui" | "rpc" | "json" | "print"
  hasUI: boolean;                         // dialogs available (TUI + RPC modes)
  cwd: string;
  sessionManager: ReadonlySessionManager; // read-only session access
  modelRegistry: ModelRegistry;
  model: Model<any> | undefined;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;        // current streaming abort signal
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}
```

**Command handlers get a superset**, `ExtensionCommandContext` — session-control methods that are only safe when user-initiated: `waitForIdle()`, `newSession()`, `fork(entryId)`, `navigateTree(targetId)`, `switchSession(path)`, `reload()`, `getSystemPromptOptions()`. Session-replacing calls take a `withSession(ctx: ReplacedSessionContext)` callback that receives a *fresh* context bound to the new session — the old ctx is deliberately invalidated (see §4).

### `ExtensionUIContext` — the UI capability set (abridged from types.ts)

```ts
export interface ExtensionUIContext {
  // dialogs (work in TUI and RPC modes; support AbortSignal + timeout auto-dismiss)
  select(title: string, options: string[], opts?): Promise<string | undefined>;
  confirm(title: string, message: string, opts?): Promise<boolean>;
  input(title: string, placeholder?: string, opts?): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;

  // chrome / persistent UI
  setStatus(key: string, text: string | undefined): void;          // keyed footer segments
  setWidget(key: string, content: string[] | ComponentFactory | undefined,
            options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  setFooter(factory | undefined): void;   // replace whole footer (gets ReadonlyFooterDataProvider)
  setHeader(factory | undefined): void;
  setTitle(title: string): void;          // terminal tab title
  setWorkingMessage(message?: string): void;
  setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;

  // full custom components with keyboard focus, optionally as overlay
  custom<T>(factory: (tui, theme, keybindings, done: (result: T) => void) => Component,
            options?: { overlay?: boolean; overlayOptions?; onHandle? }): Promise<T>;

  // editor integration
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  setEditorComponent(factory: EditorFactory | undefined): void;  // replace input editor (vim mode etc.)
  addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void;
  onTerminalInput(handler: (data) => { consume?: boolean; data?: string } | undefined): () => void;

  // themes
  readonly theme: Theme;
  getAllThemes(): { name: string; path: string | undefined }[];
  setTheme(theme: string | Theme): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}
```

Notable pattern: **each run mode provides its own `ExtensionUIContext` implementation** (interactive TUI, RPC-over-JSON, or a `noOpUIContext` for print/json modes — verbatim in runner.ts). Extensions guard with `ctx.hasUI` / `ctx.mode === "tui"`. This keeps the same extension usable in headless automation.

### `ToolDefinition` — LLM-callable tools with custom rendering (verbatim, trimmed comments)

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string;             // used in LLM tool calls
  label: string;            // human-readable, for UI
  description: string;      // for LLM
  promptSnippet?: string;   // opt-in one-liner in system prompt "Available tools"
  promptGuidelines?: string[];
  parameters: TParams;      // TypeBox schema
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;  // pre-validation compat shim
  executionMode?: ToolExecutionMode;  // "sequential" | "parallel" per-tool override

  execute(
    toolCallId: string,
    params: Static<TParams>,          // fully typed from the TypeBox schema
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,   // streaming partial results
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;

  renderCall?: (args: Static<TParams>, theme: Theme,
    context: ToolRenderContext<TState, Static<TParams>>) => Component;
  renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions,
    theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
}

// helper to preserve inference when defining tools standalone
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>) { return tool as ...; }
```

Schemas are **TypeBox** (`Type.Object({...})`), giving both JSON Schema for the LLM and static TS types for `execute` — a very clean single-source-of-truth trick worth copying.

### Commands, shortcuts, flags

```ts
export interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) =>
    AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
```
- Commands become `/name`; duplicate names across extensions get disambiguated invocation names (`name:2`, resolved in runner.ts).
- Shortcuts: `pi.registerShortcut("ctrl+x", {...})`. Runner maintains a **reserved-keybinding list** (`app.interrupt`, `app.exit`, `tui.input.submit`, ...) that extensions may NOT override; conflicts with non-reserved built-ins produce a diagnostic warning and the extension wins; extension-vs-extension conflicts warn and last one wins. (runner.ts `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`, `getShortcuts()`.)
- Flags: `pi.registerFlag("my-flag", { type: "boolean" })` adds real CLI flags; values readable via `pi.getFlag()`.

### Custom renderers & persisted state
- `registerMessageRenderer(customType, renderer)` — render custom messages (participate in LLM context).
- `registerEntryRenderer(customType, renderer)` + `appendEntry()` — **durable TUI-only entries** persisted in the session file, not sent to the LLM. This is pi's extension-state persistence story: the docs' recommended pattern is to store state in tool-result `details` / entries and *reconstruct* it by replaying `ctx.sessionManager.getBranch()` on `session_start` (branching-safe).

---

## 3. Events (full catalog, from `ExtensionEvent` union in types.ts)

All handlers run **sequentially, in extension load order, awaited**. "Before" events can cancel or rewrite; results chain from handler to handler.

| Group | Events | Handler result semantics |
|---|---|---|
| Startup | `project_trust` | first `yes`/`no` wins; `undecided` falls through to built-in trust prompt |
| Resources | `resources_discover` | returns extra `skillPaths`/`promptPaths`/`themePaths` |
| Session | `session_start`, `session_info_changed`, `session_before_switch`✋, `session_before_fork`✋, `session_before_compact`✋(can supply own `CompactionResult`), `session_compact`, `session_shutdown`, `session_before_tree`✋, `session_tree` | ✋ = `{ cancel?: true }` cancels |
| Agent loop | `input` (`continue` \| `transform` \| `handled`), `before_agent_start` (inject message, **replace system prompt**), `agent_start`, `turn_start`, `context` (**rewrite the message array sent to the LLM**), `before_provider_headers` (mutate in place), `before_provider_request` (**replace raw provider payload**), `after_provider_response`, `message_start`, `message_update` (token stream), `message_end` (replace finalized message, same role enforced), `turn_end`, `agent_end`, `agent_settled` | |
| Tools | `tool_call` (**`{ block: true, reason }` blocks; mutate `event.input` in place to patch args**), `tool_execution_start/update/end`, `tool_result` (replace `content`/`details`/`isError`) | built-in tools get *typed* event variants (`BashToolCallEvent` with `input: BashToolInput`, etc.); custom tools get `Record<string, unknown>` + `isToolCallEventType()` guards |
| Model | `model_select`, `thinking_level_select` | |
| User bash | `user_bash` (user's `!cmd`) | can supply custom `BashOperations` or a full replacement result — this is how the SSH/sandbox examples reroute execution |

Lifecycle diagram is documented in docs/extensions.md §"Lifecycle Overview" (verified against runner/agent-session source).

---

## 4. Lifecycle: activation, reload, error isolation, trust

### Activation
1. `discoverAndLoadExtensions()` gathers paths → `loadExtension()` per file: jiti-import, check default export is a function, create per-extension `Extension` record (maps of handlers/tools/commands/flags/shortcuts/renderers), build an `ExtensionAPI` closure over it, `await factory(api)`.
2. Loading happens **before the app core is bound**. Action methods on the shared `ExtensionRuntime` start as **throwing stubs** ("Extension runtime not initialized...`"); `ExtensionRunner.bindCore()` later swaps in real implementations, and flushes provider registrations queued during load. Registration methods (`on`, `registerTool`, ...) work immediately. Clean two-phase design.
3. `ExtensionRunner` (one per session runtime) owns dispatch: `emit()`, `emitToolCall()`, `emitContext()`, etc., plus `createContext()` which builds `ctx` objects whose getters resolve *live* at call time.

### Hot reload (`/reload`, `ctx.reload()`)
- Reload emits `session_shutdown` → `clearExtensionCache()` (bumps a generation counter; per-path factory cache invalidated) → rediscovers and re-imports everything (jiti `moduleCache: false` means fresh module code) → new runner → `session_start { reason: "reload" }` + `resources_discover { reason: "reload" }`.
- **Stale-context poisoning**: after reload/session replacement, the old runtime is `invalidate()`d — every method on captured `pi`/`ctx` objects throws a descriptive error ("This extension ctx is stale after session replacement or reload... move post-replacement work into withSession..."). This is a deliberate footgun-guard, and every single API method calls `runtime.assertActive()` first. Docs tell you to treat `await ctx.reload()` as terminal for the handler.

### Error isolation — a crashing extension does NOT kill the app
- **Load-time**: factory throw → collected into `LoadExtensionsResult.errors[]`, reported to user; other extensions still load.
- **Event handlers**: each handler call is individually try/caught in the runner; errors become `ExtensionError { extensionPath, event, error, stack }` emitted to error listeners (TUI shows them); the loop continues with the next handler. Docs: "Extension errors are logged, agent continues."
- **One deliberate exception**: `tool_call` handler errors are *not* swallowed — `emitToolCall` has no try/catch, and the caller in agent-session.ts rethrows so **an erroring `tool_call` hook blocks the tool (fail-safe for permission gates)**. Docs: "`tool_call` errors block the tool (fail-safe)."
- **Tool `execute` errors**: thrown errors are caught, sent to the LLM as `isError: true` result, execution continues.
- No process/VM sandboxing: extensions run **in-process with full user permissions**. Security is handled socially + via the **project trust** system: project-local `.pi/` extensions load only after the user trusts the project (persisted in `trust.json`; `project_trust` event lets a global extension automate the decision).

### Deactivation
No per-extension disable/deactivate API at runtime; teardown is by convention (`session_shutdown` handler must be idempotent). Resources can be enabled/disabled per package via settings ("Enable and Disable Resources" in packages.md).

---

## 5. Built-ins vs extensions (dogfooding)

The philosophy (README "Philosophy", verified):

> "Pi is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with extensions... **No MCP. No sub-agents. No permission popups. No plan mode. No built-in to-dos. No background bash.**"

And CONTRIBUTING.md:

> "If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected. Pi's core exists to be minimal and to be extensible..."

How dogfooding actually plays out in source:

- **Built-in tools use the exact same `ToolDefinition` interface as extension tools** (`packages/coding-agent/src/core/tools/index.ts` imports `ToolDefinition` from `../extensions/types.ts`; `createReadToolDefinition`, `createBashToolDefinition`, etc.). In `agent-session.ts::_refreshToolRegistry`, built-ins are tagged `sourceInfo: <builtin:name>` and wrapped through the **same** `wrapRegisteredTools()` as extension tools. Consequence: **extensions can override built-in tools by registering the same name** (extension tools are inserted after built-ins in the registry); renderCall/renderResult are inherited per-slot if omitted, so you can wrap `read` for access control without reimplementing its UI. There's also `--no-builtin-tools`.
- **Core UI chrome is replaceable, not extension-implemented**: default footer/header/editor are built-in components, but `ui.setFooter/setHeader/setEditorComponent(undefined)` restores them — the extension API is a superset that can swap any of them.
- **The "missing features" are shipped as example extensions**: `plan-mode/` (~558 lines, uses nearly every API), `permission-gate.ts`, `todo.ts`, `git-checkpoint.ts`, `subagent/`, `sandbox/`, custom providers with OAuth, etc. They live in `examples/extensions/` rather than core, and users install equivalents as pi packages.
- **SDK embeds the same system**: `createAgentSession({ resourceLoader })` + `DefaultResourceLoader({ additionalExtensionPaths, extensionFactories })` — inline factory functions (`InlineExtension`) let an embedding app register extensions programmatically without files (examples/sdk/06-extensions.ts).

So: it's not "core is literally built from plugins" (lazygit-style core features are simply *absent*); it's **"minimal hard core + one extension seam that is powerful enough that core features never needed to exist."** The dogfooding is at the *interface* level: built-in tools implement the public `ToolDefinition` contract.

---

## 6. Versioning / stability strategy

- All 5 packages are **version-locked** (root scripts: `npm version -ws` + `scripts/sync-versions.js`); currently **0.80.x** — still 0.x, no semver stability promise.
- **Breaking changes are frequent and explicitly documented** per release in `packages/coding-agent/CHANGELOG.md` under "Breaking Changes" headings (e.g. 0.80.8 changed extension-facing `ModelRegistry.refresh()` from sync to `Promise<void>`).
- No API version negotiation, no `engines`-style compat declaration for extensions, no stability tiers. Mitigations they *do* use:
  - **Compat aliasing** at the loader (old `@mariozechner/*` scope, `pi-ai` root mapped to a `compat` entrypoint that is "a strict superset of the core entrypoint: existing extensions using the old global API keep working at runtime until compat is removed").
  - Deprecated fields kept in types (e.g. `oauth.usesCallbackServer` "@deprecated Retained for source compatibility").
  - `prepareArguments` shim on tools for evolving parameter schemas.
  - Experimental gate: `PI_EXPERIMENTAL=1` env (core/experimental.ts).
- Because extensions are **source-loaded TypeScript compiled at import time against bundled host modules**, there is no ABI: an incompatible extension fails loudly at load/typecheck rather than mysteriously. Type-checking is the developer's job (`npm i -D @earendil-works/pi-coding-agent` for types).

---

## 7. Odds and ends relevant to laziergit

- **pi-tui is not React**: `Component { render(width: number): string[]; handleInput?(data) }` — a width-driven line renderer with imperative focus/overlay management. All extension render hooks return this `Component`. For laziergit (OpenTUI + React), the equivalent seam would be "plugin returns a React element / component factory", which is a *richer* but heavier contract; pi shows the value of also having dumb variants (`setWidget(key, string[])`).
- **Keyed chrome APIs** (`setStatus(key, ...)`, `setWidget(key, ...)`) let multiple extensions coexist without fighting over one status bar — cheap and effective.
- **The event bus** (`pi.events`) is a trivial `EventEmitter` wrapper with per-handler error catching — inter-extension pub/sub with unsubscribe functions.
- **Mode-aware UI abstraction** (`tui` / `rpc` / `json` / `print` with `hasUI`) is what makes extensions reusable in headless/scripted contexts; RPC mode forwards `select/confirm/input/notify` over a JSON protocol.
- **Command context vs event context split** (session-mutating operations only on `ExtensionCommandContext`) is a clean capability-separation idea.
- Extension list is shown at startup; inline SDK factories display as `<inline:name>`.
- Blog rationale: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ and "What if you don't need MCP" https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/

---

## Uncertain / could not verify

- **Star count & exact rename date**: 71.9k stars read from GitHub page 2026-07-17; the badlogic→earendil-works transfer date was not established (git remote still clones fine under the old URL; changelog issue links use both `earendil-works/pi` and `earendil-works/pi-mono` inconsistently, suggesting a recent rename).
- **Whether the old `@mariozechner/*` npm packages still receive updates** — the loader aliases them, but I did not check the npm registry for those package names.
- **RPC-mode UI details** (how `ui.custom()` degrades, exact JSON protocol) — asserted from docs/extensions.md "Mode Behavior" table and rpc.md existence; I did not read rpc.md in full.
- **Windows behavior of jiti loading and Bun binary detection** — untested here.
- **Performance of jiti-on-import for many extensions** — pi has a `time()`/timings instrumentation for extension load, implying they care, but no benchmarks were found.
- **`pi-test.sh`/`orchestrator` package role** in extension testing — not investigated.
- Claims about DeepWiki/Instagit third-party writeups were ignored (not primary sources).

## Primary sources

- Repo (redirects to earendil-works/pi): https://github.com/badlogic/pi-mono — MIT
- Extension types (all interfaces quoted above): https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts
- Loader (jiti, discovery, virtual modules): https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/loader.ts
- Runner (dispatch, error isolation, stale-ctx): https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/runner.ts
- Extension docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Package/distribution docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md
- Examples (79): https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions
- SDK inline extensions: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts
- Philosophy: coding-agent README §Philosophy; CONTRIBUTING.md
