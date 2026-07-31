# Contributing

## Setup

laziergit is Bun-only ([ADR-0003](./docs/adr/0003-bun-only-react-on-opentui.md)) and shells out to your system `git`.

```sh
bun install        # also points git at .githooks (pre-commit runs format/lint/typecheck)
bun run dev        # run the TUI against the current repository
```

Reference repos (pi, opencode, OpenTUI, lazygit) are vendored at pinned SHAs for reading and debugging — `bun scripts/vendor.ts` fetches them into `vendor/` (gitignored).

## Checks

```sh
bun run test           # unit + integration tests (packages/ and extensions/)
bun run test:e2e       # bundled flows and the spec's worked example, through a real PTY
bun run test:runtime   # focused hot-reload lifecycle fixture
bun run typecheck
bun run lint
bun run format
bun run verify         # format:check + lint + typecheck + test — run before pushing
```

## How the codebase is shaped

Read [docs/architecture.md](./docs/architecture.md) first. The short version: `packages/core` is the host, `packages/laziergit` is the public API package, and everything user-visible lives in `extensions/`. Vocabulary is in [CONTEXT.md](./CONTEXT.md) — use its terms exactly.

Rules that are load-bearing, not stylistic:

- **Everything is an extension** ([ADR-0001](./docs/adr/0001-everything-is-an-extension.md)): `extensions/*` import only `"laziergit"`, never `packages/core` internals. `packages/laziergit` must never depend on `packages/core`.
- **Effect stays internal** ([ADR-0002](./docs/adr/0002-promise-first-public-api-effect-internal.md)): Effect v4 runs in `packages/core` only; the public API is plain async TypeScript. The single exception is `ctx.effect`, whose signatures are types-only imports.
- **Git via argv arrays**, never string shell; no fs-watching of `.git` — refresh-after-mutation plus a ~2s fingerprint poll.
- **Every `ctx` registration is auto-disposed** on deactivate; hot-reload correctness (scope disposal, stale-ctx poisoning) is a core invariant, not a feature.
- **Menus are data**, so other extensions can splice into them.
- **Renderer tests wait on conditions, never on time.** Key-dispatched commands are fire-and-forget, so a fixed sleep is a race. Use the harness in `packages/core/src/test-harness.tsx` — `press`, `pressEscape`, `waitFor`, `waitForFrame`, `runCommand`, `refreshGit` — and wait for an action's *last* observable effect (its toast, or the store/frame after the refresh), not its first side effect. Do not define local copies of those helpers, poll raw `git status` while a write may be running (its index lock can fail the write), or let a pane's own async work land after the test's last wait — the harness fails any test whose React updates escape `act`. Enforced at commit time: oxlint rejects `Bun.sleep`/`setTimeout` in `*.test.tsx` (a disable comment there carries its reason and is a review decision), and `scripts/check-tests.ts` rejects helper copies.

## Docs and decisions

- [docs/extension-api.md](./docs/extension-api.md) is **the spec** for the public `"laziergit"` module. Implementation follows it; a deliberate divergence must update the spec in the same change. Its §2 example is executed by the e2e suite — it is code, not prose.
- [docs/adr/](./docs/adr/) records decisions that are hard to reverse. Don't relitigate them in review; write a new ADR if one genuinely needs revisiting.
- No default keybinding may be spelled `mod+` alone ([ADR-0004](./docs/adr/0004-terminal-safe-default-keys.md)).

## Comments

Comments describe the code as it is, never the change that produced it. Write one only where the code cannot be made clear on its own — a git or OpenTUI behaviour that would surprise a reader, a footgun a reader would otherwise reintroduce — and keep it to a line or two. Never justify a decision to a reviewer, restate what the line below does, or mention what the code used to be; that is what git history is for.
