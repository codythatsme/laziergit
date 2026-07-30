# laziergit

A lazygit-inspired git TUI: light core, everything is a TypeScript Extension. The extension API is the product. Feature-complete for daily use; currently in soak as the daily driver.

## Read before working

- `docs/architecture.md` — architecture, package layout, roadmap
- `docs/extension-api.md` — THE spec for the public `"laziergit"` module; implementation follows it, and deliberate divergences must update it in the same change; its §2 example is executed by the e2e suite
- `CONTEXT.md` — glossary; use its terms exactly (Extension, Bundled Extension, ctx, Pane, Layout, Command, Exported API, ScopedId, Row Decoration, Splice)
- `docs/adr/` — decisions already made; do not relitigate them

## Hard rules

- **Everything is an extension** (ADR-0001): `extensions/*` may import only `"laziergit"` — never `packages/core` internals. `packages/laziergit` must never depend on `packages/core`.
- **Effect stays internal** (ADR-0002): Effect v4 beta runs in `packages/core` only; the public API is plain async TS. The single exception is `ctx.effect`, whose three signatures in `packages/laziergit` are types-only imports against an `effect` peer dependency — no Effect *value* may cross, and nothing else in the public surface may name an Effect type.
- **Bun only** (ADR-0003): `@opentui/react` on React 19; no build step for extensions.
- Menus are data; every ctx registration is auto-disposed on deactivate; hot-reload correctness (scope disposal + stale-ctx poisoning) is a core invariant, not a retrofit.
- Git: shell out to system git via argv arrays (never string shell); no fs-watching of `.git` — refresh-after-mutation + ~2s fingerprint poll.
- **Comments describe the code as it is, never the change that produced it.** Write one only where the code cannot be made clear on its own — a git or OpenTUI behaviour that would surprise a reader, a footgun a reader would otherwise reintroduce. Keep it to a line or two. Never justify a decision to a reviewer, restate what the line below does, or mention what the code used to be ("no longer", "used to", "the old version", "this replaced"); that is what git history is for. A comment that needs a paragraph is a sign the code needs a better name.

## Reference code (`vendor/`, gitignored — run `bun scripts/vendor.ts` if missing)

- `vendor/opentui` — React reconciler, slot registries + runtime-plugin-support (our loader substrate), `@opentui/keymap`, `<diff>`
- `vendor/opencode` — Effect v4 idioms, dual-surface plugin API, features-as-plugins TUI
- `vendor/pi` — extension loader/lifecycle/event patterns, stale-ctx poisoning
- `vendor/lazygit` — functional spec; git argv building + porcelain parsing

Pinned SHAs in `scripts/vendor-pins.json`; bump deliberately, never track HEAD.
