# laziergit

lazygit's workflow, pi's philosophy: a git TUI with a deliberately light core where **every feature is a TypeScript extension** — including the built-in ones. Ask a coding agent for a new pane; it writes a `.ts(x)` file; laziergit hot-reloads; the feature exists.

Status: **M1 extension kernel complete; M2 UI framework is next**. Start here:

- [PLAN.md](./PLAN.md) — architecture, repository layout, v1 scope, build order
- [docs/extension-api.md](./docs/extension-api.md) — the extension API specification (the crown jewel)
- [CONTEXT.md](./CONTEXT.md) — project glossary
- [docs/adr/](./docs/adr/) — the decisions that are hard to reverse, and why
- [docs/research/](./docs/research/) — verified research on pi, OpenTUI, opencode, lazygit, and plugin-API prior art

Stack: Bun · OpenTUI + React · Effect (core-internal) · system git.

```sh
bun install
bun run dev             # Ctrl+C exits
bun run test
bun run typecheck
bun run lint

bun scripts/vendor.ts   # fetch pinned reference repos into vendor/ (gitignored)
```
