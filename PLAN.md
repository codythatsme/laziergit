# laziergit — Project Plan

lazygit's workflow, pi's philosophy: a git TUI where the core is deliberately light and **every feature is an Extension** written in TypeScript against a polished public API. The API — not any individual feature — is the product. The test of success: you ask a coding agent for a new pane ("show GitHub Actions runs for my current branch") and it writes a `.ts(x)` file into `~/.config/laziergit/extensions/`, laziergit hot-reloads, and the feature exists.

Vocabulary lives in [CONTEXT.md](./CONTEXT.md). Irreversible decisions live in [docs/adr/](./docs/adr/). The extension API specification lives in [docs/extension-api.md](./docs/extension-api.md); the user-facing config file is documented in [docs/config.md](./docs/config.md). Research that grounds all of this lives in [docs/research/](./docs/research/).

## Decisions at a glance

| Decision | Choice | Where recorded |
|---|---|---|
| Audience | Personal-first, public-shaped API | this doc |
| Core boundary | Everything is an extension; core has zero git features | [ADR-0001](./docs/adr/0001-everything-is-an-extension.md) |
| Trust model | In-process, full trust; error boundaries, no sandbox | ADR-0001 |
| Runtime | Bun only | [ADR-0003](./docs/adr/0003-bun-only-react-on-opentui.md) |
| TUI | `@opentui/react` (React 19), staying React despite opencode using Solid | ADR-0003 |
| Effect | v4 beta, core-internal only; public API is Promise-first with `ctx.effect` escape hatch | [ADR-0002](./docs/adr/0002-promise-first-public-api-effect-internal.md) |
| Extension anatomy | `defineExtension({...})` default export; lone `.ts(x)` file or package dir | [extension-api.md](./docs/extension-api.md) |
| Extension locations | `~/.config/laziergit/extensions/` + `<repo>/.laziergit/extensions/`, hot reload | extension-api.md |
| Layout | Config-owned (`config.jsonc` places pane ids); extensions ship overridable hints | this doc |
| Ext-to-ext | Extensions export typed APIs; bundled extensions must expose extension points | extension-api.md |
| Git state | Core-owned reactive store + hooks; `ctx.git.raw` escape hatch; shell out to system git | this doc |
| Git refresh | Refresh-after-write plus a ~2s status+refs fingerprint poll; no fs-watching | [extension-api.md §5.12](./docs/extension-api.md) |
| Config | JSONC + published JSON Schema, global → repo merge | [config.md](./docs/config.md) |
| v1 scope | Daily-driver loop bundled; gh-workflows as the acceptance test | this doc |

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  laziergit process (Bun, single process)                       │
│                                                                │
│  ┌──────────────────────── Core ────────────────────────────┐  │
│  │ Extension kernel   loader (OpenTUI runtime-plugin-       │  │
│  │                    support), lifecycle, hot reload,      │  │
│  │                    per-extension Scope → auto-disposal   │  │
│  │ UI framework       config-driven Layout, Pane slots,     │  │
│  │                    focus, popups, statusline, palette    │  │
│  │ Input              @opentui/keymap → Command dispatch    │  │
│  │ Git service        argv builder → system git, porcelain  │  │
│  │                    parsing, reactive GitState store,     │  │
│  │                    derived events                        │  │
│  │ Config             JSONC load/merge/validate (schemas    │  │
│  │                    contributed by extensions)            │  │
│  └───────────────────── (Effect v4 inside) ─────────────────┘  │
│                              │ Extension Context (ctx)         │
│                              │ Promise-first public API        │
│  ┌───────────────────────────┴──────────────────────────────┐  │
│  │ Bundled Extensions: status · files · branches · commits  │  │
│  │ · stash · diff · commit-flow · sync                      │  │
│  │ User Extensions: ~/.config/laziergit/extensions/*,       │  │
│  │ <repo>/.laziergit/extensions/*                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### Core internals (implementation defaults)

- **Extension loading** builds on OpenTUI's `runtime-plugin-support` (external TS/TSX modules resolving against the host's React instance — proven inside bun-compiled binaries) with `"laziergit"` registered as a host-provided module. We wrap it behind our own loader API so core is not coupled to it.
- **Lifecycle**: activation runs in `needs`-graph order. Every `ctx` registration is tracked in a per-extension Effect `Scope`; deactivation closes the Scope and unwinds everything (Obsidian Component / opencode v2 precedent). On hot reload, the old `ctx` is **poisoned** — every member access throws a descriptive "stale context" error (pi's trick; exemptions and the async-tail rule in [extension-api.md §5.3](./docs/extension-api.md)) — so captured references fail loudly instead of corrupting state.
- **Error containment**: pane render errors hit a React error boundary (pane shows an error card, app survives); command and menu-item errors surface as toasts + log entries; event-handler errors are caught per-handler and logged.
- **Git service** shells out to the system `git` binary via an argv builder (never string-concatenated shell), parses porcelain formats, and retries on `index.lock` contention — all lazygit-proven patterns (see `vendor/lazygit`). Refresh strategy is lazygit's, not naive fs-watching: refresh-after-every-mutation plus a cheap ~2s fingerprint poll (`git for-each-ref` + `.git/HEAD` read). One canonical `GitState` snapshot feeds both the React hooks and the event bus, so panes never disagree mid-render.
- **Keybindings** ride `@opentui/keymap` (focus-scoped layers, `g`/`gg` sequence disambiguation, leader keys, command catalog). Extensions register Commands; keybindings — user-remappable in config — map keys to Commands per pane context. The cheat-sheet/help overlay falls out of the command catalog. Layers are gated by a reactive matcher over laziergit's own focus model rather than by renderer focus, so which Pane owns the keyboard never depends on which Renderable happens to hold the cursor; `mod+` resolves to cmd only where the keyboard protocol can report it, and to ctrl everywhere else.
- **Menus are data** (Magit transient precedent): action menus are declarative structures owned by whichever extension defines them, and other extensions splice entries in. This is what makes bundled extensions extensible rather than walled gardens.
- **Single process** for v1. Git exec is already async; if the UI thread ever measurably suffers, the opencode pattern (backend in a Bun Worker with an RPC-tunneled in-memory server) is the known escape route.

## Repository layout

```
packages/
  laziergit/        # the public API package — the ONLY thing extensions import:
                    # defineExtension, all public types, React hooks
  core/             # the host: bootstrap, extension kernel, UI framework,
                    # git service, config; bin entry (`laziergit`)
extensions/         # Bundled Extensions, one package each, public API only:
  status/  files/  branches/  commits/  stash/  diff/  commit-flow/  sync/
docs/
  extension-api.md  # the API specification (crown jewel)
  config.md         # the user-facing config.jsonc reference
  adr/              # decision records
  research/         # verified research the plan is grounded in
scripts/
  vendor.ts         # fetches vendor/ at pinned SHAs (vendor-pins.json)
vendor/             # gitignored reference repos: pi, opencode, opentui, lazygit
CONTEXT.md          # glossary / ubiquitous language
```

Bun workspaces; `packages/laziergit` has no dependency on `packages/core` (types + factories only) — core depends on it, never the reverse. That keeps the public surface honest: if a bundled extension needs something, it must arrive through the public package.

## The extension API

Specified in [docs/extension-api.md](./docs/extension-api.md) — produced by a multi-agent design pass (three competing drafts, judged, synthesized, then adversarially verified by agents writing real extensions against it before repair). Non-negotiable properties:

1. **Learnable from types + one example.** The primary extension authors are coding agents; inference must carry everything (config schema → typed values, event name → payload type, exported API → consumer type) with no manual generics at use sites.
2. **Every registration is disposable, automatically.** Hot reload correctness is not optional.
3. **One way to do things.** Smallest surface that satisfies the contract; conveniences must earn their place.
4. **Bundled extensions must be extensible** — row decorations, menu splicing, exported APIs. The Magit property.
5. **Would ship to strangers.** Personal-first, but no API shortcuts that would be disqualifying in public.

## v1 scope

**Bundled**: status, files (**file-level** staging), branches, commits (log), stash, diff, commit-flow, sync (push/pull/fetch) — the everyday loop identified from lazygit's operation inventory.

**Explicitly post-v1** (they become extensions later, which is the point of the architecture): **hunk/line staging** (`ctx.git.raw(["apply", "--cached"], { stdin })` is the sanctioned escape hatch until a helper earns its place), **credential prompting** for auth-requiring remotes (v1 fails fast rather than hanging — see [extension-api.md §5.11](./docs/extension-api.md)), interactive rebase (requires the self-as-`GIT_SEQUENCE_EDITOR` daemon trick — documented in `docs/research/lazygit-surface.md`), cherry-pick, bisect, worktrees, submodules, reflog, custom patch editing; npm-published extension distribution; programmatic theming; `bun build --compile` single-binary releases.

**Acceptance test**: with laziergit running, write the gh-workflows pane (GitHub Actions runs for the current branch, refresh on branch change, keybinding to open in browser) as a normal user in `~/.config/laziergit/extensions/` — no core or bundled-code changes, hot-reloaded live, in under an hour. v1 is done when that passes and laziergit replaces lazygit as the daily driver.

## Build order

Each milestone ends with something runnable; "done when" is the gate.

- **M0 — Scaffold (complete).** Bun workspace, `packages/core` + `packages/laziergit`, OpenTUI React hello-world booting in the terminal, typecheck/format scripts. *Done when: `bun run dev` renders a screen.*
- **M1 — Extension kernel (complete).** `defineExtension`, loader over runtime-plugin-support, per-activation Scope disposal/supervision, stale-ctx poisoning, lease-backed hot reload, candidate and observer containment, awaited shutdown, and a temporary debug Layout that renders registered Panes side-by-side. *Gate passed: normal ctx async work settles, reload failures heal without stuck Panes, repeated generations clean up exactly once, saving a toy `.tsx` Extension updates the screen, and a thrown render error shows an error card instead of crashing.*
- **M2 — UI framework (complete).** Config-driven Layout (JSONC reader, published JSON Schema, global→repo merge — see [docs/config.md](./docs/config.md)), Layout-owned focus with tab groups, `@opentui/keymap` Commands/keybindings with user rebinding, the popup toolkit (confirm/prompt/select/menu/notify), data-driven menus with splicing, the status line, the palette, and the cheat sheet. *Gate passed: two toy Panes are placed and rearranged by config with no reactivation, tab walks focus, both Panes bind the same key and only the focused one fires, a config keybinding overrides the default, and the filtered palette focus-then-runs the Command it chose.*
- **M3 — Git service (complete).** Argv exec layer over the system `git` with lazygit's lock-retry, porcelain parsing, the reactive `GitState` store (unchanged slices and rows keep identity), events derived from the store shape, the curated porcelain write set, a `git` config section, and the `ctx.effect` service graph — the Effect faces hand out core's own effects rather than wrapping the Promise ones. Outside a repository laziergit degrades instead of failing. *Gate passed: a toy Pane renders live branch, divergence, and working-tree status, and tracks an external commit, a bare file edit, and a branch switch made in another terminal within one poll interval.*
- **M4 — Bundled extensions.** The eight, roughly status → files → branches → commits → stash → diff → commit-flow → sync, each stress-feeding the API (selection model, decorations, menus, multi-pane focus). Staging is file-level; `commit-flow` renders its own message editor rather than growing the popup toolkit. API changes surface here — make them, don't work around them; the two already known are the unborn-HEAD and gone-upstream encodings in [extension-api.md §5.12](./docs/extension-api.md), and the shared list/cursor component the four list Panes will want ([§5.11](./docs/extension-api.md)). *Done when: the everyday loop works end-to-end on this repo.*
- **M5 — Acceptance & polish.** Run the acceptance test cold, fix every friction it finds, sweep the visual design pass (opencode-grade aesthetics: theme tokens, spacing, borders, empty states). *Done when: the acceptance test passes and lazygit is uninstalled.*

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Effect v4 is beta and churns | Contained: ordinary APIs are Promise-first; only the narrow, opt-in `ctx.effect` types are version-coupled (ADR-0002); pin + patch like opencode does |
| `@opentui/react` less production-exercised than Solid renderer | Stick to documented components; use its test-utils; vendored source for debugging; upstream issues watched |
| No PTY/terminal-embedding pane in OpenTUI (opentui#440 open) | Data-panes cover the known wishlist (gh-workflows, devbox); interactive flows use full-screen suspend/resume; revisit when upstream lands |
| Vendored repos move fast (opencode especially) | Pinned SHAs in `scripts/vendor-pins.json`; deliberate, reviewed bumps |
| Hot-reload state corruption (the classic in-process plugin failure) | Scope-owned registrations + stale-ctx poisoning from day one (M1 gate, not a retrofit) |
| lazygit-parity scope creep | v1 scope is fixed above; everything else is post-v1 *extensions* — the architecture makes deferral cheap |

## Vendored references (`bun scripts/vendor.ts`)

| Repo | Why it's here |
|---|---|
| `vendor/pi` (earendil-works/pi) | Extension loader/lifecycle/event patterns; stale-ctx poisoning; 79 example extensions |
| `vendor/opencode` (anomalyco/opencode, sparse) | Effect v4 idioms; dual Effect/Promise plugin API; features-as-plugins TUI |
| `vendor/opentui` (anomalyco/opentui) | React reconciler, slot registries + runtime plugin loading, `@opentui/keymap`, `<diff>` component |
| `vendor/lazygit` (jesseduffield/lazygit) | The functional spec; git argv building, porcelain parsing, refresh strategy |
