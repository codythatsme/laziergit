# opencode Architecture Research (for laziergit)

Researched: 2026-07-17
Method: shallow clone of `github.com/sst/opencode` (redirects to `anomalyco/opencode`, default branch `dev`) inspected locally at commit `3a1c6df9e24672f0761a6ced18e1315d89334baf` (2026-07-17), plus GitHub API and web search. All file paths below are relative to the repo root; local copy at `/private/tmp/claude-501/-Users-codythatsme-Developer-laziergit/6e44eabb-9d73-47f2-867b-8bfae83e2696/scratchpad/opencode-ref`.

Primary sources:
- Repo: https://github.com/anomalyco/opencode (formerly `sst/opencode`; the old URL redirects)
- OpenTUI: https://github.com/anomalyco/opentui
- Docs (authored in-repo): `packages/web/src/content/docs/*.mdx`, published at https://opencode.ai/docs

---

## 0. Identity, license, repo size (vendoring feasibility)

Verified via GitHub API (`gh api repos/sst/opencode`, 2026-07-17):

| Fact | Value |
|---|---|
| Canonical repo | `anomalyco/opencode` (org renamed; SST team is now "Anomaly") |
| Default branch | `dev` |
| Stars | 186,636 |
| Created | 2025-04-30 |
| License | MIT (root `LICENSE`, "Copyright (c) 2025 opencode"; workspace packages each declare `"license": "MIT"` — verified in `packages/plugin`, `packages/sdk/js`, `packages/tui`, `packages/opencode`) |
| Server-side git size | ~403 MB (412,751 KB) |
| Shallow clone (depth 1) | 216 MB total; **135 MB working tree**; `.git` 81 MB |
| Tracked files | **6,284** |
| Workspace version | 1.18.3 |

Largest directories (working tree): `packages/console` 49 MB (their SaaS console), `packages/opencode` 19 MB, `packages/web` 13 MB (docs site), `packages/ui` 11 MB, `packages/app` 8.9 MB, `packages/desktop` 8.8 MB. The parts interesting for laziergit (`core` 3.6 MB, `tui` 1.8 MB, `plugin`, `protocol`, `client`, `sdk` 1.7 MB, `schema`, `server`) total roughly 15–30 MB. **Vendoring verdict: full repo is heavy but feasible as a shallow clone; a sparse checkout of ~9 packages is the better option.** MIT license permits it outright.

---

## 1. Overall architecture: client/server split, runtime

**Yes, strict client/server split, and it is contract-first.** The backend is an HTTP server exposing an OpenAPI 3.1 API; every UI (TUI, desktop, web, ACP/IDE) is a client of it. From `packages/web/src/content/docs/server.mdx`:

> "When you run `opencode` it starts a TUI and a server. Where the TUI is the client that talks to the server. The server exposes an OpenAPI 3.1 spec"

**Runtime: Bun**, everywhere. `"packageManager": "bun@1.3.14"` in root `package.json`; all dev/build/test scripts are `bun run` / `bun test`; npm plugins are installed with Bun at runtime; workers are Bun `Worker`s; `bunfig.toml` at root. Interestingly the HTTP listener is created with `node:http`'s `createServer` through Effect's Node platform adapter (`NodeHttpServer` from `@effect/platform-node`) running under Bun (`packages/opencode/src/server/server.ts`).

### The interesting part: one process, two threads, in-process HTTP

In the default `opencode` TUI mode there is **no separate server process**. The CLI main thread runs the TUI; it spawns a **Bun Worker** (`packages/opencode/src/cli/tui/worker.ts`) that hosts the entire backend. The TUI's SDK client is given a fake base URL and a custom `fetch` that tunnels requests over a tiny RPC channel into the worker, where they hit the Effect HTTP app **in memory** — no socket at all:

```ts
// packages/opencode/src/cli/cmd/tui.ts
const transport = external
  ? { url: (await client.call("server", network)).url, fetch: undefined, events: undefined, headers }
  : {
      url: "http://opencode.internal",
      fetch: createWorkerFetch(client),     // RPC → worker → Server.Default().app.fetch(request)
      events: createEventSource(client),    // RPC event subscription
    }
```

```ts
// packages/opencode/src/cli/tui/worker.ts (runs in the Worker)
export const rpc = {
  async fetch(input) { /* builds Request, then: */ 
    const response = await Server.Default().app.fetch(request)
    ...
  },
  async server(input) { server = await Server.listen(input); return { url: server.url.toString() } },
  ...
}
GlobalBus.on("event", (event) => { Rpc.emit("global.event", event) }) // events flow TUI-ward over RPC
```

Only when the user passes `--port`/`--hostname`/`--mdns` does the worker start a real listener and the TUI switches to actual HTTP with basic-auth headers (`OPENCODE_SERVER_PASSWORD`, username default `opencode`). `opencode serve` runs the headless server (default port 4096, optional mDNS discovery as `opencode.local`). Multi-project support is per-request: "Server loads instances per-request via `x-opencode-directory` header" (`packages/opencode/src/cli/cmd/serve.ts`).

CONTEXT.md (a 32 KB in-repo domain-language document — worth reading in full) names this pattern: **"Embedded OpenCode: a scoped in-process host that structurally extends the OpenCode Client, supplies an in-memory HTTP transport, and exposes additional same-process capabilities directly."**

### Contract-first API pipeline

- `packages/protocol` — the authoritative API contract, written as Effect `HttpApi` groups (`effect/unstable/httpapi`): agent, command, session, message, model, provider, permission, fs, pty, event, skill, etc. (`packages/protocol/src/api.ts`, `src/groups/*`). Middleware placement lives in protocol; the server injects concrete service keys.
- `packages/server` — handler/middleware glue implementing the contract.
- `packages/opencode/src/server/server.ts` — assembles the web handler (`HttpApiApp.webHandler()`), OpenAPI generation via `OpenApi.fromApi(PublicApi)`, WebSocket tracking, mDNS.
- `packages/sdk` — published `@opencode-ai/sdk`; JS client generated with `@hey-api/openapi-ts` from `packages/sdk/openapi.json`; has `/v2` exports with generated types.
- `packages/client` — newer generated clients with **both** `generated/` (Promise) and `generated-effect/` surfaces, exports `.` and `./effect`.
- `packages/httpapi-codegen` — their own codegen; CONTEXT.md calls the intermediate form the **"SDK Contract IR"**: "the runtime-neutral compiled representation of the authoritative HttpApi... so independent SDK emitters can choose their public value model and runtime interpreter."

Events: SSE endpoint `GET /api/event` (`event.subscribe` in `packages/protocol/src/groups/event.ts`) plus WebSockets; the TUI batches incoming events on a 16 ms window into single Solid render passes (`packages/tui/src/context/sdk.tsx`).

---

## 2. Effect usage — VERIFIED, and far beyond "utilities"

**The user's belief is confirmed, emphatically — with one big caveat: it's Effect v4 (beta), not v3.**

Dependency evidence (root `package.json` workspace catalog — single-source version pinning):

```jsonc
"effect": "4.0.0-beta.83",
"@effect/platform-node": "4.0.0-beta.83",
"@effect/sql-sqlite-bun": "4.0.0-beta.83",
"@effect/opentelemetry": "4.0.0-beta.83",
// and they PATCH effect itself:
"patchedDependencies": { "effect@4.0.0-beta.83": "patches/effect@4.0.0-beta.83.patch", ... }
```

Import breadth (files importing `effect`/`@effect/*`, counted with grep): `packages/opencode` **409 files**, `packages/core` **366**, `llm` 67, `schema` 51, `server` 27, `protocol` 23, `codemode` 18, `cli` 16, plus more — well over 1,000 files monorepo-wide.

### How Effect is used (services + layers, the full pattern)

1. **Composition root with Layers.** `packages/opencode/src/effect/app-runtime.ts` builds `AppLayer` from ~50 service "nodes" (Database, Config, Storage, Plugin, Provider, Agent, Session, SessionProcessor, LSP, MCP, ToolRegistry, Permission, ...) and wraps it in a `ManagedRuntime`. They built their own `LayerNode` abstraction (`packages/core/src/effect/layer-node.ts`, `app-node.ts`) with two scoping tags — `"global"` vs `"location"` (location ≈ per-project-instance) — so services declare their lifetime tier:

   ```ts
   export const tags = LayerNode.tags({ location: ["global"], global: [] })
   export const makeGlobalNode = tags.make("global")
   export const makeLocationNode = tags.make("location")
   ```

2. **Services as `Context.Service` classes** with typed layers, e.g. `class ListenerServerService extends Context.Service<...>()("@opencode/ListenerServer")` in `server.ts`; `Config.Service`, `InstanceStore.Service`, etc.

3. **Effect Schema for domain types and tagged errors** (v4 API), e.g. `packages/core/src/ripgrep.ts`:

   ```ts
   export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
     message: Schema.String, cause: Schema.optional(Schema.Defect()),
   }) {}
   ```
   plus `Stream`, `effect/unstable/process` `ChildProcess` for subprocess control.

4. **Effect HTTP end-to-end**: `effect/unstable/http` (`HttpRouter`, `HttpServer`) + `effect/unstable/httpapi` (`HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `OpenApi`) for the whole server; Hono appears **only** in `packages/enterprise` and `packages/function` (cloud/Workers code), not the local server.

5. **CLI commands are Effect programs** — `effectCmd` wrapper, `Effect.fn("Cli.serve")(function* (args) { ... })` (`packages/opencode/src/cli/cmd/serve.ts`).

6. **Promise-boundary bridging is explicit and marked as debt** (`packages/opencode/src/project/instance-runtime.ts`):

   ```ts
   // Bridge for Promise/ALS callers that cannot yet yield InstanceStore.Service.
   // Delete this module once those callers are migrated to Effect boundaries...
   export const load = (input) => AppRuntime.runPromise(InstanceStore.Service.use((s) => s.load(input)))
   ```

7. **Custom Effect infrastructure packages** they wrote: `effect-drizzle-sqlite`, `effect-sqlite-node`, `http-recorder` ("Record and replay Effect HTTP client traffic with deterministic cassettes"), `codemode` ("Effect-native confined code execution over schema-described tools"), `httpapi-codegen`. Plus observability via `@effect/opentelemetry`.

**Timeline caveat**: this is a 2026-era rewrite. opencode in 2025 was famously plain TypeScript on Bun with no framework. Commit search shows effect-centric refactors from ~March 2026 ("refactor(account): tighten effect-based account flows" 2026-03-11, "feat(schema): scaffold effect-to-zod bridge" 2026-03-13); the migration is still finishing (Promise bridges remain). So: **excellent, current, production-scale Effect v4 reference — but patterns are v4-beta idioms (`ServiceMap`/`Context.Service`, `Schema.TaggedErrorClass`, `effect/unstable/*`), which differ from published Effect v3 docs.**

---

## 3. The TUI: OpenTUI + SolidJS (not React)

- Framework: **`@opentui/core` + `@opentui/solid` + `@opentui/keymap`, all pinned 0.4.3** via catalog *and* forced via root `overrides`; renderer is **SolidJS** (`solid-js` 1.9.10 — patched via `patchedDependencies`). There is a `script/upgrade-opentui.ts` for coordinated upgrades. No `@opentui/react` anywhere in the repo (OpenTUI itself, at `anomalyco/opentui` (MIT, 12,550 stars), ships React/Solid/Vue bindings — opencode chose Solid).
- `packages/tui` exports `run(TuiInput)` from `src/app.tsx`; structure: `routes/` (screens), `context/` (Solid context providers: `sdk`, `sync`, `theme`, `kv`, `args`, `exit`, `editor`, `clipboard`...), `component/`, `ui/` (dialog, toast, spinner), `keymap.tsx`, `theme/`.
- **Backend communication**: entirely through the generated SDK client (`createOpencodeClient` from `@opencode-ai/sdk/v2`) — base URL + optional injected `fetch` + injected event source (see §1). The TUI holds a client-side reactive read model (`sync` context) fed by the event stream.
- **Killer pattern for laziergit — built-in features are plugins**: `packages/tui/src/feature-plugins/` implements the sidebar sections (context, files, LSP, MCP, todo, footer), diff viewer, notifications, which-key overlay, and even the plugin manager as **TUI plugins using the same public plugin API third parties get** (`createBuiltinPlugins()` in `feature-plugins/builtins.ts`, typed as `TuiPluginModule`). The host is thin; features are plugins.

---

## 4. Plugin / extension story (the most relevant section)

opencode has a **two-sided plugin system** — server plugins and TUI plugins — shipped from one package, `@opencode-ai/plugin` (npm, MIT), with OpenTUI as *optional* peer deps so server-only plugins don't pay for it. A single plugin package may export a `server` entry, a `tui` entry, or both (`PluginModule = { id?, server, tui?: never }` / `TuiPluginModule = { id?, tui, server?: never }`).

### 4.1 v1 server plugin API (`packages/plugin/src/index.ts`) — current stable

Shape: an async factory receiving capabilities, returning a record of named hooks:

```ts
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>   // full typed SDK against the local server
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell                                        // Bun's $ shell, handed to plugins
  experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void }
}

export interface Hooks {
  dispose?: () => Promise<void>
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: { [key: string]: ToolDefinition }           // contribute LLM tools
  auth?: AuthHook                                    // contribute auth flows (oauth/api-key, with prompt DSL)
  provider?: ProviderHook                            // contribute/patch model catalogs
  "chat.message"?, "chat.params"?, "chat.headers"?,
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>,
  "tool.execute.before"?, "tool.execute.after"?, "shell.env"?, "tool.definition"?,
  "command.execute.before"?, "experimental.*"...     // all: (input, mutable output) => Promise<void>
}
```

Design signature: **every hook is `(input, output) => Promise<void>` where mutation of `output` is the extension mechanism** (middleware-style, run sequentially in load order; later hooks see earlier mutations).

Custom tools (`packages/plugin/src/tool.ts`): `tool({ description, args: zodShape, execute(args, ctx) })` with `tool.schema = z` re-exported; `ToolContext` gives `sessionID`, `agent`, `directory`, `worktree`, `abort: AbortSignal`, `metadata()`, and `ask()` for permission prompts. Filename becomes tool name; multiple exports become `<filename>_<exportname>`.

### 4.2 v2 plugin API — dual Effect/Promise surface (in development, in-tree)

`packages/plugin/src/v2/` ships two mirrored surfaces: `@opencode-ai/plugin/v2/effect` and `/v2/promise` ("The initial implementation covers the Effect API. A Promise API [is] a wrapper over the same capabilities" — `v2/effect/PLAN.md`). The Effect form:

```ts
export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R>
}
export function define<R = Scope.Scope>(plugin: Plugin<R>) { return plugin }

export interface PluginContext {
  readonly options: PluginOptions
  readonly agent: AgentHooks & Reload
  readonly aisdk: AISDKHooks           // runtime hooks (intercept live ops)
  readonly catalog: CatalogHooks & Reload
  readonly command: CommandHooks & Reload
  readonly integration: IntegrationHooks & Reload
  readonly plugin: PluginDomain        // plugins can add/remove plugins
  readonly reference: ReferenceHooks & Reload
  readonly skill: SkillHooks & Reload
}
```

Key concepts (from `v2/effect/README.md` + `PLAN.md` + `packages/core/src/state.ts`):
- **Transforms**: replayable draft-mutations over a stateful domain ("rebuilds start from fresh domain state and run every active transform in registration order"). Registered imperatively during setup; **owned by the plugin's Scope — closing the scope removes them and triggers a domain rebuild**. This is Effect `Scope`-based resource management used as the plugin lifecycle.
- **Runtime hooks**: sequential interceptors for live operations (e.g. `ctx.aisdk.sdk(...)` to swap in a custom AI SDK instance).
- **Reload**: `ctx.catalog.reload()` re-runs all active transforms when upstream data changes; rebuilds are serialized, coalesced, and batched during boot.
- Transforms have **no typed error channel** — "unexpected failures are defects."
- Goal stated in PLAN.md: "Internal and external plugins use the same public plugin API. Effect plugins import `@opencode-ai/plugin/v2/effect`, not `@opencode-ai/core`." Public values use generated SDK types; core keeps branded IDs/internal schemas private.

### 4.3 TUI plugin API (`packages/plugin/src/tui.ts`)

`TuiPlugin = (api: TuiPluginApi, options, meta) => Promise<void>`. `TuiPluginApi` is a large capability object:
- `keymap` (layered keybindings + command dispatch; the older `command.register` API is kept deprecated for v1 compat), `keys` (formatting), `mode` (modal editing stack)
- `route.register([{ name, render: (input) => JSX.Element }])` + `route.navigate` — plugins add whole screens
- `ui.{Dialog,DialogAlert,DialogConfirm,DialogPrompt,DialogSelect,Prompt,Slot,toast,dialog}` — host-provided Solid components
- **`slots.register`** with a **typed slot map** (`TuiHostSlotMap`: `app`, `home_logo`, `home_footer`, `session_prompt`, `sidebar_title`, `sidebar_content`, `sidebar_footer`, ... each with typed props) — plugins render into named host regions; plugins can even declare *new* slots via the `Slots` generic
- `state` — read-only reactive projection (sessions, messages, parts, diffs, todos, LSP/MCP status), `client` (full SDK), `event.on(type, handler)` (typed by event discriminant)
- `theme` (full RGBA token table incl. diff/markdown/syntax colors, `install(jsonPath)`), `kv` (persisted key-value), `attention` (notifications + soundboard), `renderer` (raw OpenTUI `CliRenderer` escape hatch)
- `plugins` (list/activate/deactivate/add/install — plugin management from within a plugin), `lifecycle` (`AbortSignal` + `onDispose`)

### 4.4 Loading mechanics (`packages/opencode/src/plugin/loader.ts`, `shared.ts`, docs `plugins.mdx`)

- Sources: **local files** in `.opencode/plugins/` (project) and `~/.config/opencode/plugins/` (global), auto-discovered; **npm packages** listed in config `"plugin": ["pkg", ["pkg", {options}]]`, auto-installed with Bun at startup, cached in `~/.cache/opencode/node_modules/`.
- Load order: global config → project config → global plugin dir → project plugin dir; hooks run in sequence.
- Pipeline is staged for good error reporting: `plan` (normalize config) → `resolve` (install → entrypoint detection per `PluginKind` "server"/"tui" → **compatibility gate**: npm plugins can declare supported opencode versions; file plugins skip it) → `load` (dynamic `import()`), each stage reporting `install | entry | compatibility | load | missing` failures distinctly; file plugins get one retry after dependency install because "Bun caches failed dynamic imports."
- Everything runs **in-process**: server plugins inside the server worker (full Bun capabilities, `$` shell), TUI plugins inside the render thread. No sandboxing.
- Deprecated plugins are silently skipped "because they are now built in" — plugins graduate into core.

### 4.5 Declarative customization (no code)

All discovered in `.opencode/` (project) or `~/.config/opencode/` (global) — opencode dogfoods every one of these in its own repo's `.opencode/`:
- `opencode.json(c)` config with published JSON `$schema` (https://opencode.ai/config.json)
- **Commands**: markdown files with frontmatter (`description`, `agent`, `model`) in `commands/`; body is the prompt template → `/name` in the TUI
- **Agents** (markdown), **Skills**, **Tools** (TS files via `tool()`), **Themes** (JSON), keybinds, MCP servers, rules (`AGENTS.md`)

---

## 5. Monorepo map (33 packages, Bun workspaces + Turborepo + catalog versioning)

Core product path (the vendoring-relevant set):
| Package | Role |
|---|---|
| `packages/opencode` | The shipped CLI (`bin/opencode`, yargs commands), server assembly, session engine, tools, LSP, MCP, plugin loading. 99 deps. |
| `packages/core` | Domain core as Effect services: config, database (Drizzle+SQLite), filesystem, git, permission, plugin host, pty, ripgrep, session projector, tool registry, state/transform machinery. |
| `packages/protocol` | Authoritative `HttpApi` contract (Effect httpapi groups + middleware placement). |
| `packages/server` | HTTP handlers/middleware implementing the contract. |
| `packages/schema` | Effect Schema domain schemas; effect→zod bridge. |
| `packages/client` | Generated clients: Promise + **Effect-native** (`./effect`). |
| `packages/sdk` (`sdk/js`) | Published `@opencode-ai/sdk` (hey-api generated from `openapi.json`); `sdk-next` = next gen. |
| `packages/httpapi-codegen` | In-house SDK codegen ("SDK Contract IR"). |
| `packages/plugin` | Public plugin API package (v1 + v2 effect/promise + tui typings). |
| `packages/tui` | OpenTUI/Solid terminal UI. |
| `packages/llm` | Provider adapters (Effect-heavy, ai-sdk v6 underneath). |

Supporting/product-surface: `ui` (shared Solid components), `app` (web client), `desktop` (**Electron 42 + electron-vite + Solid**, not Tauri), `web` (docs, Astro/Starlight), `console` + `enterprise` + `function` + `identity` + `stats` + `slack` (their SaaS/cloud; Hono lives only here), `codemode` (Effect-native confined code execution over schema-described tools), `http-recorder`, `effect-drizzle-sqlite`, `effect-sqlite-node`, `session-ui`, `storybook`, `cli`, `script`, `containers`. Infra: `sst.config.ts` + `infra/` (deployed with SST on AWS).

Tooling choices worth stealing: workspace **catalog** for single-point version pinning; `patchedDependencies` (13 patches incl. `effect` and `solid-js`); `oxlint`; `tsgo` (`@typescript/native-preview`) for typechecking; Turborepo for task orchestration; per-package `AGENTS.md`; a repo-level `CONTEXT.md` ubiquitous-language glossary.

---

## 6. Answers to the specific questions

1. **Client/server split?** Yes — contract-first HTTP (OpenAPI 3.1) with generated SDKs; but the default TUI runs the "server" as an in-process Bun Worker reached through an RPC-tunneled `fetch` (in-memory HTTP), promoting to a real socket only when asked. Runtime is Bun throughout.
2. **Effect?** Confirmed, deeply: Effect **4.0.0-beta.83** (patched), `@effect/platform-node`, `@effect/sql-sqlite-bun`, `@effect/opentelemetry`; ~50-service `Layer` composition root under a `ManagedRuntime`; `Context.Service` classes; Schema tagged errors; Effect HTTP server + HttpApi contract; Effect CLI commands; custom Layer-graph (`LayerNode`) with global/location scoping. It is a *strong* Effect-patterns reference — for **v4 idioms**, mid-migration, with explicit Promise bridges at legacy boundaries.
3. **TUI?** OpenTUI 0.4.3 with the **Solid** renderer (`@opentui/solid`), not React; talks to the backend exclusively through the generated SDK client + SSE/RPC event stream; built-in TUI features are implemented as plugins on the public TUI plugin API.
4. **Plugin story?** Rich, two-sided (server + TUI), in-process, npm- or file-loaded with staged resolution and version-compat gating; v1 = async factory returning mutate-the-output hooks + zod-typed custom tools; v2 = Scope-based Effect API (transforms over domain drafts + runtime hooks + reload) with a Promise wrapper; plus fully declarative markdown/JSON customization (commands, agents, skills, themes).
5. **Monorepo structure**: see §5 table.
6. **License/size**: MIT everywhere; 6,284 files, 135 MB working tree (shallow clone 216 MB); sparse-vendor ~9 packages for ~15–30 MB.

---

## 7. Uncertain / could not verify

- **Exact start date of the Effect migration.** Shallow clone has no history; GitHub commit search only surfaces effect-centric refactors from ~2026-03 onward. The claim "adopted Effect during the v1→v2 rewrite in early 2026" is inference, not verified.
- **Which parts of the v2 plugin PLAN.md are implemented vs aspirational.** PLAN.md says explicitly it is "an implementation plan, not documentation for the current API"; shipped code differs in details (e.g. PLAN says `rebuild()`, code ships `reload()`; PLAN's `ctx.tool.hook("execute.before")` domain is not in the current `PluginContext`).
- **Star count (186,636)** is a single point-in-time API reading; not cross-checked.
- **`opencode serve` / `web` / desktop transport details** beyond what's cited (I traced the TUI path thoroughly; serve path only to `Server.listen`).
- **Whether the `.git`-excluded working tree contains generated artifacts** inflating the 135 MB (e.g. `packages/console` assets); I did not audit binary assets file-by-file.
- **OpenTUI React binding maturity** — I verified opencode does not use it, and that `anomalyco/opentui` exists (MIT, 12.5k stars); I did not inspect OpenTUI's own source in this pass.
- **DeepWiki/Medium architecture write-ups** ([DeepWiki overview](https://deepwiki.com/anomalyco/opencode/1.2-architecture-overview), [Medium guide](https://medium.com/@maclarensg_50191/how-opencode-actually-works-an-architecture-guide-backed-by-source-code-939811f0434f)) were surfaced by search but not relied upon; everything above is from the repo itself unless marked otherwise.

## Sources

- https://github.com/anomalyco/opencode (cloned at `3a1c6df9e24672f0761a6ced18e1315d89334baf`, 2026-07-17)
- GitHub API: `repos/sst/opencode`, `repos/sst/opentui` (2026-07-17)
- In-repo docs: `packages/web/src/content/docs/{server,plugins,custom-tools,commands}.mdx` (published at opencode.ai/docs)
- In-repo design docs: `CONTEXT.md`, `packages/plugin/src/v2/effect/{README.md,PLAN.md}`
- https://github.com/anomalyco/opentui
