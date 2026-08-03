# laziergit

A lazygit-inspired git TUI where **every feature is a TypeScript extension** — including the built-in ones. The core is deliberately small: panes, layout, keybindings, a git service, and an extension kernel with hot reload. Everything you actually see — files, branches, commits, stash, diff, commit flow, sync, a GitHub Actions pane — is an extension written against the same public API you get.

That API is the point. Ask a coding agent for a new pane ("show GitHub Actions runs for my current branch"); it writes one `.tsx` file into `~/.config/laziergit/extensions/`; laziergit hot-reloads; the feature exists. No build step, no fork, no core changes.

Stack: [Bun](https://bun.sh) · [OpenTUI](https://github.com/anomalyco/opentui) + React · system git.

## Install & run

Requires Bun and git.

```sh
bun install
bun run dev        # run against this repository; Ctrl+C exits

# Or put `laziergit` on PATH and use it anywhere:
cd packages/core && bun link && cd -
laziergit          # from inside any git repository
```

## What's in the box

- **files** — working-tree status as a path tree, file-level stage/unstage/discard
- **branches** — checkout, create, delete, divergence at a glance
- **commits** — log, plus targeted squash/reword/drop on the current branch
- **stash** — save, apply, pop, drop
- **diff** — patch view that follows your cursor across panes
- **commit-flow** — summary/description commit popup with amend
- **sync** — push/pull/fetch, force-with-lease, live activity indicator
- **gh-workflows** — GitHub Actions runs for the current or all branches: drill into jobs and logs, rerun, cancel (needs the `gh` CLI)

Lists filter with `/`, the palette runs any command, `?` shows the focused pane's keys, and everything is rebindable.

## Writing an extension

An extension is one `.ts(x)` file (or a package directory) whose default export is `defineExtension({...})`, dropped into `~/.config/laziergit/extensions/` or `<repo>/.laziergit/extensions/`. It gets a typed `ctx` — panes, commands, git state hooks, popups, config, events — and every registration is disposed automatically on reload.

```ts
// ~/.config/laziergit/extensions/hello.ts
import { defineExtension } from "laziergit";

export default defineExtension({
  name: "hello",
  activate(ctx) {
    ctx.commands.register({
      id: "hello.wave",
      title: "Wave",
      run: () => ctx.popups.notify("👋", "info"),
    });
  },
});
```

The full specification — with worked examples an agent (or you) can learn the whole surface from — is [docs/extension-api.md](./docs/extension-api.md).

## Configuration

`config.jsonc` (global `~/.config/laziergit/`, merged with `<repo>/.laziergit/`) owns the layout, keybindings, theme, and per-extension settings, with a published JSON Schema. See [docs/config.md](./docs/config.md).

## Documentation

- [docs/extension-api.md](./docs/extension-api.md) — the extension API specification
- [docs/config.md](./docs/config.md) — the `config.jsonc` reference
- [docs/architecture.md](./docs/architecture.md) — how the core is put together, and the roadmap
- [docs/adr/](./docs/adr/) — decisions that are hard to reverse, and why
- [CONTRIBUTING.md](./CONTRIBUTING.md) — developing laziergit itself
