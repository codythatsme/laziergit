# Architecture

laziergit is a single Bun process: a small core that knows nothing about git _features_, and a set of extensions — bundled and user-written — that provide all of them through one public API, the `"laziergit"` module ([extension-api.md](./extension-api.md)). Irreversible decisions are recorded in [adr/](./adr/); vocabulary in [CONTEXT.md](../CONTEXT.md).

```
┌────────────────────────────────────────────────────────────────┐
│  laziergit process (Bun, single process)                       │
│                                                                │
│  ┌──────────────────────── Core ────────────────────────────┐  │
│  │ Extension kernel   loader (OpenTUI runtime-plugin-       │  │
│  │                    support), lifecycle, hot reload,      │  │
│  │                    per-extension Scope → auto-disposal   │  │
│  │ UI framework       config-driven Layout, Pane slots,     │  │
│  │                    focus, popups, statusline, hint bar,  │  │
│  │                    palette, cheat sheet                  │  │
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
│  │ Bundled Extensions: files · branches · commits · stash   │  │
│  │ · diff · commit-flow · sync · gh-workflows               │  │
│  │ User Extensions: ~/.config/laziergit/extensions/*,       │  │
│  │ <repo>/.laziergit/extensions/*                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## Core internals

- **Extension loading** builds on OpenTUI's `runtime-plugin-support` (external TS/TSX modules resolving against the host's React instance) with `"laziergit"` registered as a host-provided module, wrapped behind our own loader API so core is not coupled to it.
- **Lifecycle**: activation runs in `needs`-graph order. Every `ctx` registration is tracked in a per-extension Effect `Scope`; deactivation closes the Scope and unwinds everything. On hot reload the old `ctx` is **poisoned** — member access throws a descriptive "stale context" error — so captured references fail loudly instead of corrupting state ([extension-api.md §5.3](./extension-api.md)).
- **Error containment**: pane render errors hit a React error boundary (error card, app survives); Command and transient-chooser errors surface as toasts and log entries; event-handler errors are caught per-handler.
- **Git service** shells out to the system `git` binary via an argv builder (never string-concatenated shell), parses porcelain formats, and retries on `index.lock` contention. Refresh is refresh-after-every-mutation plus a ~2s fingerprint poll of four lock-free reads — no fs-watching ([extension-api.md §5.12](./extension-api.md)). One canonical `GitState` snapshot feeds both the React hooks and the event bus.
- **Keybindings** ride `@opentui/keymap`: focus-scoped layers, sequence disambiguation, a command catalog that the cheat sheet and hint bar derive from. Layers are gated by laziergit's own focus model, not renderer focus.
- **Commands are the action catalog**: one registration drives key dispatch, the palette, cheat sheet, and hint bar. A contextual Command targets the current selection through a Pane's exported `RowSource`, so another Extension contributes an action without a parallel menu registry. `ctx.popups.menu` is reserved for transient choices inside a Command workflow ([ADR-0007](./adr/0007-commands-are-the-action-catalog.md)).
- **Single process**: git exec is already async; if the UI thread ever measurably suffers, the known escape route is a backend in a Bun Worker behind an in-memory RPC server.

## Package layout

```
packages/
  laziergit/        # the public API package — the ONLY thing extensions import
  core/             # the host: bootstrap, kernel, UI framework, git service, config
  runtime-bridge/   # the seam the two halves share: React contexts carrying the
                    # runtime, and the defineExtension validation both ends need
extensions/         # bundled extensions, one package each, public API only
scripts/            # vendor fetcher, e2e suite
```

`packages/laziergit` never depends on `packages/core` — core depends on it, never the reverse. That keeps the public surface honest: if a bundled extension needs something, it must arrive through the public package.

Both depend on `packages/runtime-bridge`, which exists because React contexts have identity: the host that provides a context and the hooks that read it must hold the same module instance, and neither package may import the other to get one. Nothing domain-specific lands there — if core and laziergit both want it, that is a design question, not a reason to widen the package.

## Extension API principles

1. **Learnable from types + one example.** The primary extension authors are coding agents; inference must carry everything with no manual generics at use sites.
2. **Every registration is disposable, automatically.** Hot-reload correctness is not optional.
3. **One way to do things.** Smallest surface that satisfies the contract.
4. **Bundled extensions must be extensible** — row decorations, contextual Commands, exported APIs.
5. **Would ship to strangers.** Personal-first, but no API shortcuts that would be disqualifying in public.

## Roadmap

Everything here becomes an extension or a config surface later — the architecture makes deferral cheap.

- Credential prompting for auth-requiring remotes (v1 fails fast rather than hanging)
- A full interactive-rebase editor (todo reordering, fixup, edit/break, conflict continuation); cherry-pick, bisect, worktrees, submodules, reflog, custom patch editing
- Layout refinements: column weight and cell height for hint-placed panes, configurable startup focus
- Richer row identity (directory rows in the files pane carry no decoration or exported contextual-Command slot)
- Multi-file diff rendering (OpenTUI's `<diff>` renders one file)
- npm-published extension distribution, programmatic theming, `bun build --compile` single-binary releases

## Vendored references (`bun scripts/vendor.ts`)

| Repo                                     | Why it's here                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `vendor/pi` (earendil-works/pi)          | Extension loader/lifecycle/event patterns; stale-ctx poisoning                         |
| `vendor/opencode` (anomalyco/opencode)   | Effect v4 idioms; dual Effect/Promise plugin API; features-as-plugins TUI              |
| `vendor/opentui` (anomalyco/opentui)     | React reconciler, slot registries, runtime plugin loading, `@opentui/keymap`, `<diff>` |
| `vendor/lazygit` (jesseduffield/lazygit) | The functional spec; git argv building, porcelain parsing, refresh strategy            |

Pinned SHAs live in `scripts/vendor-pins.json`; bump deliberately, never track HEAD.
