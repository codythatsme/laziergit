# Handoff: planning → build

You are picking up **laziergit** at the end of its planning phase. Everything decided is written down; your job is to build it, starting at **M0**. This file is the bridge — delete it once the milestones in PLAN.md are underway.

## State

Planning is complete and committed. No application code exists yet. The documents are authoritative in this order:

1. `docs/extension-api.md` — the public `"laziergit"` module spec. It was designed via competing drafts, adversarial verification (agents wrote real extensions against it), and a vendor-source-verified consistency pass. Build **to** it. If implementation proves a signature wrong, change the API *and the spec in the same commit* — never work around it.
2. `PLAN.md` — architecture, package layout, milestones M0–M5 with "done when" gates.
3. `CLAUDE.md` — hard rules (import boundaries, Effect containment, no fs-watching of `.git`). Auto-loaded every session.
4. `CONTEXT.md` / `docs/adr/` — glossary and settled decisions. Do not relitigate ADRs.

`vendor/` is gitignored — if missing, run `bun scripts/vendor.ts` before anything else. You will need it: the spec's §5.10 maps every public API to a vendored mechanism.

## Your mission, in order

- **M0 — Scaffold** (this session): Bun workspace (`packages/laziergit`, `packages/core`, `extensions/*` empty for now), `@opentui/react` hello-world booting in the terminal, typecheck script. Gate: `bun run dev` renders a screen.
- **M1 — Extension kernel** (next session, the make-or-break one): `defineExtension`, loader on OpenTUI `runtime-plugin-support`, `ctx` skeleton, Effect-Scope disposal, stale-ctx poisoning, hot reload, error containment, debug layout. Gate: saving a toy `.tsx` extension while running updates the screen; a thrown render error shows an error card, not a crash.
- Then M2 (UI framework) → M3 (git service) → M4 (bundled extensions) → M5 (acceptance) per PLAN.md. One milestone per session; commit at each gate.

## Version pins (verified during planning, 2026-07)

- Bun 1.3.5 installed locally; OpenTUI 0.4.4 (`@opentui/react` needs React ≥ 19.2); Effect `4.0.0-beta.83` (match opencode's pin — its idioms are what `vendor/opencode` demonstrates). Pin exact OpenTUI versions like opencode does (workspace catalog + overrides) — it releases weekly with occasional deprecations.

## Where to crib (exact files)

- Runtime plugin loading: `vendor/opentui/packages/react/` — `runtime-plugin-support` + `/configure` exports; `ensureRuntimePluginSupport({ additional })` is how `"laziergit"` becomes a host-provided module (spec §5.10 documents first-install semantics).
- Slot registries (pane/statusline substrate): `vendor/opentui/packages/core/` (`createSlotRegistry`), keybindings: `vendor/opentui/packages/keymap/`.
- Effect v4 runtime wiring: `vendor/opencode/packages/opencode/src/effect/app-runtime.ts` (ManagedRuntime + Layer graph). Note: barrel imports (`import { ManagedRuntime, Context } from "effect"`); v4 renamed `Context.Tag` → `Context.Key`.
- Extension lifecycle/poisoning patterns: `vendor/pi/packages/coding-agent/src/core/extensions/` (`types.ts`, `loader.ts`, `runner.ts`).
- Git argv building + porcelain parsing + index.lock retry: `vendor/lazygit` (Go, but the logic is the reference).

## Known open items (tracked in the spec, don't resolve prematurely)

- `DiffApi` / `CommitFlowApi` (spec §1.11) are provisional seams — confirm their shapes when building those Bundled Extensions in M4.
- Spec §1.12 (`ctx.effect`) is typed against the Effect v4 **beta**; expect drift, contained by ADR-0002.
- OpenTUI has no embedded-PTY pane yet (upstream #440) — interactive handoff is `suspend()/resume()` only.

## Acceptance test (M5, memorize it now — it shapes everything)

With laziergit running, a user (or agent) writes the gh-workflows pane (spec §2, verbatim) into `~/.config/laziergit/extensions/` — no core or bundled-code changes, hot-reloaded live, working in under an hour. v1 is done when that passes and laziergit replaces lazygit as the daily driver.
