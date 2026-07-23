# laziergit

A lazygit-inspired git TUI: light core, everything is a TypeScript Extension. The extension API is the product. M3 is complete; M4 (the eight Bundled Extensions) is next — build order and milestone gates are in PLAN.md.

## Read before working

- `PLAN.md` — architecture, package layout, current milestone (each has a "done when" gate)
- `docs/extension-api.md` — THE spec for the public `"laziergit"` module; implementation follows it, and deliberate divergences must update it in the same change
- `CONTEXT.md` — glossary; use its terms exactly (Extension, Bundled Extension, ctx, Pane, Layout, Command, Exported API, ScopedId, Row Decoration, Splice)
- `docs/adr/` — decisions already made; do not relitigate them

## Hard rules

- **Everything is an extension** (ADR-0001): `extensions/*` may import only `"laziergit"` — never `packages/core` internals. `packages/laziergit` must never depend on `packages/core`.
- **Effect stays internal** (ADR-0002): Effect v4 beta in `packages/core` only; the public API is plain async TS. Never let an Effect type leak into `packages/laziergit`.
- **Bun only** (ADR-0003): `@opentui/react` on React 19; no build step for extensions.
- Menus are data; every ctx registration is auto-disposed on deactivate; hot-reload correctness (scope disposal + stale-ctx poisoning) is an M1 gate, not a retrofit.
- Git: shell out to system git via argv arrays (never string shell); no fs-watching of `.git` — refresh-after-mutation + ~2s fingerprint poll.

## Reference code (`vendor/`, gitignored — run `bun scripts/vendor.ts` if missing)

- `vendor/opentui` — React reconciler, slot registries + runtime-plugin-support (our loader substrate), `@opentui/keymap`, `<diff>`
- `vendor/opencode` — Effect v4 idioms, dual-surface plugin API, features-as-plugins TUI
- `vendor/pi` — extension loader/lifecycle/event patterns, stale-ctx poisoning
- `vendor/lazygit` — functional spec; git argv building + porcelain parsing

Pinned SHAs in `scripts/vendor-pins.json`; bump deliberately, never track HEAD.
