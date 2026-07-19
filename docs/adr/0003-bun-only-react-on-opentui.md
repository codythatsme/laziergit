---
status: accepted
---

# Bun-only runtime; React on OpenTUI for the TUI

laziergit targets Bun exclusively and renders with `@opentui/react`. Bun runs TypeScript natively, so an extension is literally a `.ts` file dropped in a directory — the zero-build-step authoring loop the whole project exists for — and OpenTUI's native (Zig/FFI) core plus its runtime plugin loading are Bun-first (Node needs 26.4+ with experimental FFI and documented gaps). We stay on React even though opencode — the flagship production OpenTUI app — uses the Solid renderer: the React reconciler is mature (lockstep-versioned, react-reconciler 0.33 on React 19, DevTools, test-utils), agents and humans write far better React than Solid, and Raycast proves extensions-as-React-components works against a native reconciler at store scale.

## Consequences

- We are a comparatively early production user of `@opentui/react`; opencode's TUI code is a patterns reference, not a copy source.
- Extension loading builds on OpenTUI's `runtime-plugin-support` (external TS/TSX resolving against the host's React instance, proven inside bun-compiled binaries) rather than inventing module-dedup machinery.
- Known upstream limitation accepted: no embedded PTY/terminal pane yet (opentui#440); interactive handoff is full-screen `suspend()/resume()`.
