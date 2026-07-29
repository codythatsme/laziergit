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
| Default keys | `mod+` stays in the grammar, but no core or bundled default depends on it | [ADR-0004](./docs/adr/0004-terminal-safe-default-keys.md) |
| Extension anatomy | `defineExtension({...})` default export; lone `.ts(x)` file or package dir | [extension-api.md](./docs/extension-api.md) |
| Extension locations | bundled `extensions/` + `~/.config/laziergit/extensions/` + `<repo>/.laziergit/extensions/` (that precedence), hot reload | extension-api.md |
| Layout | Config-owned (`config.jsonc` places pane ids); extensions ship overridable hints | this doc |
| Ext-to-ext | Extensions export typed APIs; bundled extensions must expose extension points | extension-api.md |
| Git state | Core-owned reactive store + hooks; `ctx.git.raw` escape hatch; shell out to system git | this doc |
| Git refresh | Refresh-after-write plus a ~2s fingerprint poll (status, refs, stash, config); no fs-watching | [extension-api.md §5.12](./docs/extension-api.md) |
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
│  │ · diff · commit-flow · sync                              │  │
│  │ User Extensions: ~/.config/laziergit/extensions/*,       │  │
│  │ <repo>/.laziergit/extensions/*                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### Core internals (implementation defaults)

- **Extension loading** builds on OpenTUI's `runtime-plugin-support` (external TS/TSX modules resolving against the host's React instance — proven inside bun-compiled binaries) with `"laziergit"` registered as a host-provided module. We wrap it behind our own loader API so core is not coupled to it.
- **Lifecycle**: activation runs in `needs`-graph order. Every `ctx` registration is tracked in a per-extension Effect `Scope`; deactivation closes the Scope and unwinds everything (Obsidian Component / opencode v2 precedent). On hot reload, the old `ctx` is **poisoned** — every member access throws a descriptive "stale context" error (pi's trick; exemptions and the async-tail rule in [extension-api.md §5.3](./docs/extension-api.md)) — so captured references fail loudly instead of corrupting state.
- **Error containment**: pane render errors hit a React error boundary (pane shows an error card, app survives); command and menu-item errors surface as toasts + log entries; event-handler errors are caught per-handler and logged.
- **Git service** shells out to the system `git` binary via an argv builder (never string-concatenated shell), parses porcelain formats, and retries on `index.lock` contention — all lazygit-proven patterns (see `vendor/lazygit`). Refresh strategy is lazygit's, not naive fs-watching: refresh-after-every-mutation plus a cheap ~2s fingerprint poll (four lock-free reads: working-tree status, refs, stash list, and remote/branch config — see [extension-api.md §5.12](./docs/extension-api.md)). One canonical `GitState` snapshot feeds both the React hooks and the event bus, so panes never disagree mid-render.
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
  runtime-bridge/   # the seam the two halves share so neither imports the other:
                    # the React contexts carrying the runtime, and the spec
                    # validation both ends need. Nothing domain-specific lands
                    # here — if core and laziergit both want it, that is a design
                    # question, not a reason to widen this package.
extensions/         # Bundled Extensions, one package each, public API only:
  files/  branches/  commits/  stash/  diff/  commit-flow/  sync/  gh-workflows/
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

Both depend on `packages/runtime-bridge`, which is the one thing they are allowed to share. React contexts are why it exists: a context object has identity, so the host that provides it and the hooks that read it must hold the *same* module instance, and neither package may import the other to get one. It carries the contexts (typed `unknown`, parsed at the boundary in `react.ts` rather than asserted), the host↔hooks runtime contract, and the `defineExtension` validation both ends need. It is deliberately not a shortcut around the boundary: anything domain-specific arriving here would mean core and the public package have grown a dependency the architecture says they must not have.

## The extension API

Specified in [docs/extension-api.md](./docs/extension-api.md) — produced by a multi-agent design pass (three competing drafts, judged, synthesized, then adversarially verified by agents writing real extensions against it before repair). Non-negotiable properties:

1. **Learnable from types + one example.** The primary extension authors are coding agents; inference must carry everything (config schema → typed values, event name → payload type, exported API → consumer type) with no manual generics at use sites.
2. **Every registration is disposable, automatically.** Hot reload correctness is not optional.
3. **One way to do things.** Smallest surface that satisfies the contract; conveniences must earn their place.
4. **Bundled extensions must be extensible** — row decorations, menu splicing, exported APIs. The Magit property.
5. **Would ship to strangers.** Personal-first, but no API shortcuts that would be disqualifying in public.

## v1 scope

**Bundled**: files (**file-level** staging; conflicts shown and delegated to the user's editor or `git mergetool`), branches, commits (log), stash, diff, commit-flow, sync (push/pull/fetch) — the everyday loop identified from lazygit's operation inventory.

**Explicitly post-v1** (they become extensions later, which is the point of the architecture): **hunk/line staging** (`ctx.git.raw(["apply", "--cached"], { stdin })` is the sanctioned escape hatch until a helper earns its place), **lazygit-grade conflict resolution** (pick-ours / pick-theirs / pick-both; the conflict-side pair landed with [ADR-0005](./docs/adr/0005-one-file-change-per-path.md), so this now wants only the patch surface described in [extension-api.md §5.12](./docs/extension-api.md)), **credential prompting** for auth-requiring remotes (v1 fails fast rather than hanging — see [extension-api.md §5.11](./docs/extension-api.md)), interactive rebase (requires the self-as-`GIT_SEQUENCE_EDITOR` daemon trick — documented in `docs/research/lazygit-surface.md`), cherry-pick, bisect, worktrees, submodules, reflog, custom patch editing; **layout refinements** (a Pane's `placement` hint sets column and order but not column weight or cell height, so hint-placed columns split evenly and cell heights are equal; default startup focus lands on the first cell rather than the first Pane with rows — all config-overridable, [extension-api.md §5.11](./docs/extension-api.md)); **richer row identity** (the FilesApi directory-row gap in [extension-api.md §5.12](./docs/extension-api.md) — a folder row is not a `FileChange`, so it has no decoration slot and its menu cannot be spliced); **multi-file diff rendering** (OpenTUI's `<diff>` renders one file, so the diff pane splits per file — [extension-api.md §5.11](./docs/extension-api.md)); npm-published extension distribution; programmatic theming; `bun build --compile` single-binary releases.

**Acceptance test**: with laziergit running, write the gh-workflows pane (GitHub Actions runs for the current branch, refresh on branch change, keybinding to open in browser) as a normal user in `~/.config/laziergit/extensions/` — no core or bundled-code changes, hot-reloaded live, in under an hour. v1 is done when that passes and laziergit replaces lazygit as the daily driver.

## Build order

Each milestone ends with something runnable; "done when" is the gate.

- **M0 — Scaffold (complete).** Bun workspace, `packages/core` + `packages/laziergit`, OpenTUI React hello-world booting in the terminal, typecheck/format scripts. *Done when: `bun run dev` renders a screen.*
- **M1 — Extension kernel (complete).** `defineExtension`, loader over runtime-plugin-support, per-activation Scope disposal/supervision, stale-ctx poisoning, lease-backed hot reload, candidate and observer containment, awaited shutdown, and a temporary debug Layout that renders registered Panes side-by-side. *Gate passed: normal ctx async work settles, reload failures heal without stuck Panes, repeated generations clean up exactly once, saving a toy `.tsx` Extension updates the screen, and a thrown render error shows an error card instead of crashing.*
- **M2 — UI framework (complete).** Config-driven Layout (JSONC reader, published JSON Schema, global→repo merge — see [docs/config.md](./docs/config.md)), Layout-owned focus with tab groups, `@opentui/keymap` Commands/keybindings with user rebinding, the popup toolkit (confirm/prompt/select/menu/notify), data-driven menus with splicing, the status line, the palette, and the cheat sheet. *Gate passed: two toy Panes are placed and rearranged by config with no reactivation, tab walks focus, both Panes bind the same key and only the focused one fires, a config keybinding overrides the default, and the filtered palette focus-then-runs the Command it chose.*
- **M3 — Git service (complete).** Argv exec layer over the system `git` with lazygit's lock-retry, porcelain parsing, the reactive `GitState` store (unchanged slices and rows keep identity), events derived from the store shape, the curated porcelain write set, a `git` config section, and the `ctx.effect` service graph — the Effect faces hand out core's own effects rather than wrapping the Promise ones. Outside a repository laziergit degrades instead of failing. *Gate passed: a toy Pane renders live branch, divergence, and working-tree status, and tracks an external commit, a bare file edit, and a branch switch made in another terminal within one poll interval.*
- **M4 — Bundled extensions (complete).** The bundled set — files, branches, commits, stash, diff, commit-flow, sync — as Panes, status line segments, Commands and spliceable menus, every one of them written against `"laziergit"` and nothing else. (M5's UX pass retired an eighth, `status`, and the counts below are as M4 left them.) Staging is file-level; conflicts are shown and delegated; `commit-flow` renders its own `<textarea>` rather than growing the popup toolkit. The known API changes landed before the eight did — the unborn-HEAD and gone-upstream encodings [§5.12](./docs/extension-api.md) named, plus `useListCursor`, `createRowSource` + `toneColor`, and `useKeyCapture` + `CommandSpec.capture` — and writing the eight surfaced more, all made rather than worked around: `ctx.copy` (three extensions wanted the clipboard and the alternative was per-platform shelling in each), `DiffTarget` as a discriminated union with `DiffApi.show(null)`, `CommitFlowApi.begin` gaining `signoff` and a result, `GitError`'s C-locale guarantee documented so classifying a rejected push is supported rather than a hack, and `PaneHandle.focus` so the Layout's reading order need not be its working order. A five-lens adversarial review then hardened the eight and closed the three API gaps it turned up: `PaneHandle.reveal`, which makes `DiffApi.show` honest — the diff Pane is tab-grouped with `commit-flow`, and `focus()` was the wrong verb for a Pane that follows another's cursor without stealing the keyboard; the scroll seam (`useScrollView` + `ListCursor.scrollRef`), because nothing public could move a Pane's viewport and every list walked its cursor off the bottom of its own `<scrollbox>`; and `literalPathspec`, the smallest fix for the largest bug — git globs the paths in a `raw` argv and `--` does not stop it, so an unwrapped path acted on the user's other files. *Gate passed: booted against this repository, all seven Panes render live content — branch and divergence, the dirty working tree, the branches, the log, the stashes, and the selected file's patch — with an empty diagnostics list and not one Command losing a key to another. The write half of the loop is covered end-to-end through the real kernel against real repositories in `packages/core/src/bundled/`: stage, discard, commit, amend behind a rejecting `pre-commit` hook, stash save/apply/drop, branch create/checkout/delete, and push with and without an upstream, including the force-with-lease that a second clone's commit correctly refuses. The seams the review promoted carry documented post-v1 limits — the FilesApi staged/unstaged row-identity gap, hint-only column weight and cell height, default startup focus, and OpenTUI's single-patch `<diff>` — recorded in the post-v1 list below and [§5.11](./docs/extension-api.md)/[§5.12](./docs/extension-api.md), not left in a review report.*
- **M5 — Acceptance & polish.** Run the acceptance test cold, fix every friction it finds, sweep the visual design pass (opencode-grade aesthetics: theme tokens, spacing, borders, empty states). *Done when: the acceptance test passes and lazygit is uninstalled.*

  **The acceptance test passed, and it is now a test.** `gh-workflows` went into `~/.config/laziergit/extensions/` and the pane existed — live GitHub Actions runs for the current branch, the cursor walking them, `o` opening one, the palette command focusing the pane first — with no core change, no bundled change, and nothing rebuilt; a rewrite of the file on disk was on screen 1.2s later. What it measured, though, was not the API but the *specification*: the extension used was §2's worked example, lifted verbatim, and it ran. So it stopped being a ceremony — `scripts/e2e` now extracts §2's code block out of `docs/extension-api.md`, installs it into a sandboxed config directory with a stubbed `gh`, and drives it through a real PTY. The crown-jewel example is executed rather than published, which is the defect it had already grown: §1.8 says a row clips to one line and §2 — the only row-rendering example in the document — wrapped, taught a cursor marked by background alone (invisible the moment another Pane takes focus), and predated `CommandSpec.hint` so every agent-written pane shipped with an empty hint bar. §4.4 was worse and older: it hand-rolled the cursor `useListCursor` exists to replace, put its `<diff>` outside any scroll container, and fed a multi-file stash patch to a `<diff>` that §5.11 says renders only the first file.

  **The acceptance extension now also ships.** `gh-workflows` is a Bundled Extension — the daily driver wants the Actions pane out of the box, not re-authored into every config directory. The bundled copy diverges from §2 in the two ways bundling demands: a machine without `gh` renders the spawn failure instead of leaking an unhandled rejection, and its placement hint sits below stash rather than tying with it. §2 itself is unchanged, and its e2e now also proves scope precedence — the sandboxed global install shadows the bundled copy, so the acceptance test still measures a user file against a distribution that already contains the same name. Because every session boots the pane, every e2e sandbox carries a `gh` stub answering an empty run list; the screen must never depend on the machine's own gh, its auth state, or the network.

  **Then six more extensions were written against the spec alone, to find what one example could not.** A status line segment, a decorate-and-splice extension with no Pane, a multi-step popup flow, a second Pane driving raw git, a config-and-events-and-`ctx.effect` extension, and a blame Pane with its own text input — each authored with no access to `packages/core` or `extensions/`, in a copy of the authoring environment laziergit publishes, and each required to typecheck there. All six did, on the first run, with no casts and no manual generics: the compile-time guarantees the spec advertises are real. Every friction they hit was then handed to an agent told to refute it; 48 survived, 17 did not, and the study is in [docs/research/m5-api-frictions.md](./docs/research/m5-api-frictions.md). The one blocker fixed in code was the escape hatch nobody could reach: `ctx.effect` is declared in terms of `Effect.Effect` and `Stream.Stream`, the published authoring environment linked five packages and `effect` was not among them, and `skipLibCheck` hid the unresolved import inside laziergit's own declarations — so §1.12, the one surface the spec calls version-coupled, was the one surface with no types at all. It resolves now, and `type-environment.test.ts` names every package an Extension may import so the next omission fails loudly instead of silently degrading to `any`.

  **The visual pass changed the default palette and made the floors testable.** Three independent palettes were designed against opencode's theme system and scored; `nocturne` won and ships as the default, with `midnight` (the original), `ember`, `daybreak` and `beacon` as presets selected by `theme.preset` and overridable token by token. The point is less which colours won than that "opencode-grade" stopped being a matter of taste: `theme.test.ts` holds every shipped preset to body text at 7:1 against both the background *and* the selected row, `textMuted` at 4.5:1 against both, a focused border at least twice the strength of an unfocused one, and staged-green separated from unstaged-red in luminance as well as hue — because the files Pane draws those two columns side by side and hue alone is not readable to everyone. The old default failed two of those outright (`textMuted` at 3.11:1, carrying every empty state in the app; `border` at 1.57:1, barely framing anything). The chrome went with it: the shell stopped padding Panes that draw their own borders and cells stopped leaving a blank row between them (three rows and two columns back at 24×80, a third of a short Pane's content), a hint-derived column now falls back to the 1:2 sidebar-to-detail proportion laziergit's own config uses instead of making the diff as narrow as a list of branch names, the files Pane pins its `XY` status pair to a fixed column so only the *name* indents with depth, the status line lands on the Pane content column and can no longer collide with the branch name, popups have a row between title and body, menu keys share one column, and the three Panes that spelled "no repository" three different ways — one of which claimed a healthy repository where there was none — now agree.

  **The daily-driver UX pass (done).** Using the app surfaced six frictions, all fixed before the acceptance test so it measures the API rather than a known-bad default set. **Rows are one line**: `<text>` wraps by default, so one long branch name reflowed into three lines and a list stopped being a list; every bundled row now clips with `wrapMode="none"`, which is what lazygit's list views do, and §1.8 makes it a documented convention with the most-important-first ordering it implies. **What a clipped row cannot say moved to the detail view**: the diff Pane stopped stripping git's commit header, so a commit shows its full message, and `DiffTarget` gained a `branch` kind — the patch is identical to its tip's, but only that kind lets the header print the branch name the row cut off. **Rows say less**: three hand-duplicated relative-age ladders are gone, along with `no upstream` and the in-sync `✓`; a branch reports `↑n ↓n` when there is something to report and nothing when there is not, and a `gone` upstream — indistinguishable from in-sync in git's own data (§5.12) — colours the branch name instead. **The bottom row became contextual**: `CommandSpec.hint` turns one registration into a hint-bar entry as well, and core resolves which are live from the same three pieces of state the keymap's layer matchers read, so the bar cannot name a key that would do something else. **`?` became the focused Pane's** rather than every Pane's, globals trailing. **The status Pane is gone** — four rows for what a status line segment says in one; `sync` took over the branch and divergence, and the repository actions it owned. Separately, [ADR-0004](./docs/adr/0004-terminal-safe-default-keys.md): `mod+p` resolved correctly to cmd+P and Warp ate it before the pty, so no core or bundled default is spelled `mod+` alone any more.

  **A seventh: nothing showed that git was working.** A push replaced the whole sync segment with a static `⟳ pushing`, so the one place the branch is unconditionally written went blank at the moment you most want to be sure which branch is moving — and a commit held open by a pre-commit hook, or the push buried in the branches menu, showed nothing at all anywhere. The fix reversed a design decision rather than working around it: [§5.11](./docs/extension-api.md) had ruled out progress APIs on the grounds that "a pane that owns long work renders its own state", which assumes the pane that *starts* the work has somewhere to draw it — across the bundled set it mostly does not, and predictably `sync` was the only extension that ever opted in. Core runs every write, so core is the only thing that can know about all of them: the git service now announces each one at the choke point they already pass through, and `useGitActivity()` exposes it. What §5.11 was really defending survives intact — core owns no progress *surface*, so there is no `ctx.progress` handle and no spinning toast, and the loader beside the branch is the sync extension's own component and its own frame table (an animated three-cell braille wave, fixed-width by construction so nothing to its right ever shifts a column). Writes only, and only past ~120ms, so the diff Pane's per-cursor-move reads and a one-file `stage` stay silent.

  **An eighth: long lists became directly queryable.** The public `useListCursor` primitive now owns lazygit's two `/` behaviors as an opt-in query declaration. Files, branches, and stash filter live with lazygit's smart-case, multi-term substring semantics; commits keep the complete history and search through it, with Enter landing on the first match after the cursor and `n`/`N` cycling from there. Core owns only the focused Pane's one-line Status Line editor and match summary. Extensions still own their rows, searchable fields, and the choice between filtering and searching. Because query and cursor state share the primitive, clearing a filter maps the selected projected row back to its source row, and ordinary `j`/`k` movement around a commit match remains meaningful.

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
