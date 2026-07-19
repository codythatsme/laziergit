# OpenTUI Research (for laziergit)

Researched 2026-07-17 against primary sources: the OpenTUI monorepo (source + docs MDX that back opentui.com), npm registry metadata, GitHub issues, and the OpenCode repo.

## 0. Repo identity, license, activity

- Canonical repo is now **`anomalyco/opentui`**; `github.com/sst/opentui` redirects there (SST/Anomaly Innovations rebrand — npm maintainer emails are `@anomalyinnovations.com`). Homepage: https://opentui.com
- **License: MIT** (repo-wide; every package.json inspected says `"license": "MIT"`).
- ~12,550 stars, 79 open issues / 236 closed, last push 2026-07-16.
- npm `@opentui/core`: first published **2025-08-13**, **296 published versions** (dated `0.0.0-YYYYMMDD-sha` snapshots nearly daily plus tagged releases). Latest stable **v0.4.4 (2026-07-16)**.
- Release cadence (from GitHub releases): v0.3.0 May 28 → v0.3.4 Jun 7 → v0.4.0 Jun 9 → v0.4.1 Jun 11 → v0.4.2 Jun 24 → v0.4.3 Jul 3 → v0.4.4 Jul 16, 2026. Roughly a tagged release every 1–2 weeks; still **pre-1.0**, so semver gives no stability guarantee, but the README/docs state a focus on "correctness, stability, and high performance."

Self-description (docs/getting-started.mdx, verbatim):

> "OpenTUI is a native terminal UI core written in Zig with TypeScript bindings. The native core exposes a C ABI and can be used from any language. OpenTUI powers OpenCode in production today and will also power terminal.shop."

Sources:
- https://github.com/anomalyco/opentui
- https://github.com/anomalyco/opentui/releases
- https://registry.npmjs.org/@opentui/core

## 1. Renderers / packages

Monorepo `packages/` directory (verified via GitHub API):

| Package | Purpose |
|---|---|
| `@opentui/core` | TS bindings over the Zig core; imperative `Renderable` API + declarative "Constructs" factory API (`Box(...)`, `Text(...)`) |
| `@opentui/react` | React reconciler (`react-reconciler@^0.33.0`, **requires React >= 19.2.0**) |
| `@opentui/solid` | SolidJS reconciler — **this is what OpenCode uses** |
| `@opentui/three` | Three.js WebGPU renderer integration |
| `@opentui/keymap` | Host-agnostic keybinding engine (see §5 — extremely relevant to laziergit) |
| `@opentui/qrcode` | QR code renderable (`registerQRCode()` for React) |
| `@opentui/ssh` | Serve OpenTUI apps over SSH (added v0.4.1, stream-mode renderer) |
| `examples`, `web` | Example apps; the docs/marketing Astro site |

**No Vue renderer in the monorepo today.** `@opentui/vue` exists on npm but is stalled at **0.1.25** (latest snapshot 2025-09-30) — it was dropped from the repo. Docs say: "Other language and framework bindings live in separate repositories."

### React reconciler maturity assessment

- Versioned in lockstep with core (0.4.4), first-class in docs alongside Solid.
- Built on `react-reconciler@^0.33.0`; peer deps: `react >= 19.2.0`, optional `react-devtools-core@^7` (DevTools integration works), optional `ws`.
- Ships `./test-utils`, its own `jsx-runtime`/`jsx-dev-runtime` (`"jsxImportSource": "@opentui/react"`), and `./runtime-plugin-support` for runtime-loaded plugins.
- ~20 examples in `packages/react/examples/` including `flush-sync.tsx`, `keymap.tsx`, `plugin-slots-errors.tsx`, `external-plugin-slots-demo.tsx`, `extend-example.tsx`.
- Legacy `render()` is deprecated in favor of `createRoot(renderer).render(<App />)` (two-step init).
- Open React-titled issues as of 2026-07-17: **#726** "Input value doesn't change (react)" and **#1185** "Windows segfault in opentui.dll on rapid React component mount/unmount (0.4.1, native yoga)". That's the full list of open React-titled issues — small, but #1185 is a native-boundary crash worth watching if you target Windows.
- Caveat: the flagship production app (OpenCode) uses **Solid**, not React, so the Solid path gets the most production exercise. React is well-documented and actively maintained but battle-tested mostly through examples/tests and community apps.

Entry point (docs/bindings/react.mdx, verbatim):

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return <text>Hello, world!</text>
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

## 2. Component/primitive set (React JSX intrinsics)

From docs/bindings/react.mdx and packages/react/README.md:

- **Layout & display**: `<text>`, `<box>`, `<scrollbox>`, `<ascii-font>`
- **Input**: `<input>`, `<textarea>`, `<select>`, `<tab-select>`
- **Code & diff** (gold for a git TUI): `<code>` (tree-sitter syntax highlighting), `<line-number>` (line numbers + diff/diagnostic support), `<diff>` (unified or split diff viewer), `<markdown>`
- **Text modifiers** (inside `<text>`): `<span>`, `<strong>`/`<b>`, `<em>`/`<i>`, `<u>`, `<br>`, `<a>`
- Core also has: `Slider`, `ScrollBar`, `FrameBuffer`, `TextTable`, `EditBufferRenderable` (editor-grade text buffer), QR code (separate package).

Styling — props directly or a `style` object:

```tsx
<box backgroundColor="blue" padding={2}>
  <text>Hello</text>
</box>
// or
<box style={{ backgroundColor: "blue", padding: 2 }}>
  <text>Hello</text>
</box>
```

### The `<diff>` component (DiffRenderable)

Takes a raw unified diff string, renders unified or split view with tree-sitter syntax highlighting, line numbers, sync-scrolled split panes, and ~20 themable color knobs (docs/components/diff.mdx):

```typescript
const diff = new DiffRenderable(renderer, {
  id: "diff",
  width: "100%",
  height: 16,
  diff: `diff --git a/app.ts b/app.ts\n...`,  // unified diff string
  view: "split",            // "unified" | "split"
  filetype: "typescript",
  syntaxStyle,
  showLineNumbers: true,
  syncScroll: true,
})
```

Props include `addedBg`, `removedBg`, `contextBg`, `addedSignColor` (`#22c55e`), `removedSignColor` (`#ef4444`), `wrapMode: "word" | "char" | "none"`, `treeSitterClient`. Note: "Construct API: Not available yet. Use `DiffRenderable` for now" — in React you'd wrap it via `extend()` if no intrinsic exists (docs list `<diff>` as an intrinsic, so it is registered for React).

### ScrollBox

"supports horizontal and vertical scrolling, sticky scroll behavior, **viewport culling**, and customizable scrollbars" — viewport culling matters for long commit lists.

```typescript
const scrollbox = new ScrollBoxRenderable(renderer, { id: "scrollbox", width: 40, height: 20 })
for (let i = 0; i < 100; i++) scrollbox.add(new BoxRenderable(renderer, { id: `item-${i}`, width: "100%", height: 2 }))
```

### Custom components via `extend()` (React)

```tsx
class ButtonRenderable extends BoxRenderable {
  constructor(ctx: RenderContext, options: BoxOptions & { label?: string }) {
    super(ctx, { border: true, borderStyle: "single", minHeight: 3, ...options })
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    consoleButton: typeof ButtonRenderable
  }
}
extend({ consoleButton: ButtonRenderable })
// then: <consoleButton label="Click me!" />
```

## 3. Layout, styling, theming

- **Layout engine: Yoga (Flexbox), natively implemented in Zig.** docs/core-concepts/layout.mdx: "OpenTUI uses the Yoga layout engine to provide CSS Flexbox-like capabilities". Source confirms: `packages/core/src/zig/yoga.zig`, `packages/core/src/yoga.ts`, `packages/core/src/lib/yoga.options.ts`. The v0.4.1 release notes call it the "native yoga-layout implementation" (it moved from the JS/WASM yoga into the Zig core).
- Full flexbox vocabulary: `flexDirection` (column default), `justifyContent` (incl. `space-evenly`), `alignItems`, `flexGrow`, `gap`, `padding`, percentage widths (`width: "100%"`), fixed cells, `position: absolute` (per Renderable options).
- **Colors**: `RGBA` class (8-bit channels + packed metadata). Accepts hex (`#FF000080` w/ alpha), CSS color names, `"transparent"`, `RGBA` objects; `parseColor()` utility. Colors carry **"color intent"** — RGB snapshot vs indexed ANSI slot vs terminal default — so palette-relative colors stay stable when the terminal palette changes (docs/core-concepts/colors.mdx). There's also a color-matrix reference doc.
- **No built-in theming system.** OpenCode implements its own theme via a Solid context (`packages/tui/src/context/theme.tsx`) and passes `{ theme }` as the plugin-slot host context. laziergit would do the same.

## 4. Input, keyboard, focus, mouse

### Keyboard (docs/core-concepts/keyboard.mdx)

- `renderer.keyInput` is an EventEmitter emitting `keypress` (and `keyrelease`, `paste`).
- `KeyEvent` is rich: `name` (canonical: `"a"`, `"space"`, `"return"`, `"escape"`, `"f1"`), `sequence`, `raw`, `source: "raw" | "kitty"`, `ctrl/shift/meta/option/super/hyper`, `eventType: "press" | "repeat" | "release"`, `repeated`, `baseCode` (Kitty base-layout codepoint for **layout-stable shortcuts**), `capsLock`/`numLock`.
- **Kitty keyboard protocol on by default** (`useKittyKeyboard: {}`), enabling key-release events and disambiguated modifiers where supported.
- Bracketed paste supported (`usePaste` hook in React; `decodePasteBytes()` in core).
- Built-in keybinding alias layer (enter→return, numpad aliases) and `keyAliasMap` option on editable renderables.
- React hooks: `useKeyboard(handler, { release?: true })`, `usePaste`, `useFocus`/`useBlur` (terminal window focus), `useSelectionHandler` (mouse-drag text selection with `getSelectedText()`), `useOnResize`, `useTerminalDimensions()`, `useTimeline` (animation), `useRenderer()`.

### Focus system (packages/core/src/Renderable.ts, verified in source)

There is a real focus system in core: every `Renderable` has `focusable`, `focused`, `focus()`, `blur()`, `hasFocusedDescendant`, and focus registration through the render context (`this._ctx.focusRenderable(this)`), with focus-change propagation up the ancestor chain. The renderer option `autoFocus: true` (default) focuses the nearest focusable renderable on left click. React components take a `focused` boolean prop.

### Mouse (verified in Renderable.ts + renderer config)

Enabled by default (`useMouse: true`, `enableMouseMovement: true`). Per-renderable handlers with bubbling: `onMouse`, `onMouseDown/Up/Move/Drag/DragEnd/Drop/Over/Out/Scroll`. Hit-testing lives in the native side ("hit target rendering" fixes in v0.4.1; `scrollbox-overlay-hit-test` example).

## 5. `@opentui/keymap` — a full keybinding engine (major find for laziergit)

A separate, host-agnostic package that is almost a lazygit-keybinding-system-in-a-box (packages/keymap/README.md, verbatim highlights):

- "models keybindings as priority-ordered, focus-scoped layers attached to targets"
- "Branch-aware multi-key sequences ... with a public pending-sequence API" and "Programmable exact-vs-prefix disambiguation (e.g. `g` vs `gg`) ... Ships a Neovim-style timeout resolver."
- Leader keys (`registerLeader`, `registerTimedLeader`), Emacs chords, `:write`-style ex-commands (`registerExCommands`), platform-aware `mod+` aliases.
- **Command catalog and dispatch**: named commands, command chains, namespaces, search, visibility tiers (`registered`/`reachable`/`active`), binding queries, `runCommand`, focus-aware `dispatchCommand`.
- `@opentui/keymap/extras`: helpers for **cheat-sheet UIs** (`createBindingLookup`, `commandBindings`, `formatCommandBindings`) — i.e. the lazygit "?" help pane.
- React entry: `@opentui/keymap/react` — `KeymapProvider`, `useKeymap`, `useBindings`, `useActiveKeys`, `usePendingSequence`.
- Graph snapshots/diagnostics: dead-binding warnings, shadowing detection, lint-style analyzers.

```tsx
import { registerDefaultKeys } from "@opentui/keymap/addons"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"

const keymap = createOpenTuiKeymap(renderer)
registerDefaultKeys(keymap)
createRoot(renderer).render(
  <KeymapProvider keymap={keymap}>
    <App />
  </KeymapProvider>,
)
```

Importable in Node without FFI ("portable entry point").

## 6. Plugin system — OpenTUI ships first-party plugin slots + runtime plugin loading

This is directly on-point for laziergit's crown-jewel extension API. Docs: /docs/plugins/slots (shared model), /docs/plugins/core, /docs/plugins/react.

### Shared slot registry model

- Host defines typed slot names + per-slot props + a shared context object; plugins contribute renderer callbacks per slot.
- `createSlotRegistry<TNode, TSlots, TContext>(renderer, key, context)` — renderer-scoped and keyed (same `(renderer, key)` returns same registry; context must be same object reference or it throws). Registries auto-dispose with the renderer.
- Plugin interface: `{ id: string (unique, dup throws), order?: number, setup?(ctx, renderer), dispose?(), slots: { [name]: (ctx, props) => TNode } }`. `register()` returns an unregister function.
- Deterministic ordering: `order` asc → registration order → id lexicographic.
- **Slot modes**: `"append"` (default), `"replace"`, `"single_winner"` — control how plugin output combines with host fallback UI.
- **Failure isolation**: `pluginFailurePlaceholder(failure, ctx)` per slot; React re-render throws are caught by an internal error boundary that resets on registry changes; `registry.onPluginError(event)` observability with `pluginId/phase/source/error`; `maxPluginErrors` buffer.
- Core flavor adds `SlotRenderable` (a Renderable that mounts a slot, with `mode`, `data`, `refresh()`, fallback factories, managed-slot lifecycle hooks `onDeactivate`/`onDispose` distinguishing host-owned vs plugin-owned nodes).

React flavor (docs/plugins/react.mdx, verbatim):

```tsx
type Slots = { statusbar: { user: string } }
const registry = createReactSlotRegistry<Slots, typeof context>(renderer, context)

registry.register({
  id: "clock-plugin",
  slots: {
    statusbar(ctx, props) {
      return <text>{`${ctx.appName}:${props.user}`}</text>
    },
  },
})

function App() {
  return (
    <AppSlot registry={registry} name="statusbar" user="sam" mode="replace">
      <text>fallback-statusbar</text>
    </AppSlot>
  )
}
```

### Runtime-loaded external plugins (from disk)

```ts
import "@opentui/react/runtime-plugin-support"  // once, in app entry

const mod = await import(pathToFileURL(pluginPath).href)
registry.register(mod.loadExternalPlugin())
```

- "This installs **Bun runtime support** so external TS/TSX plugin modules resolve against the host runtime instances (`@opentui/react`, React JSX runtime modules, and core runtime modules)." I.e., plugins loaded from disk share the host's React/OpenTUI instances instead of double-loading — the classic plugin-dedup problem, solved first-party.
- Works "in both normal Bun runs and **standalone compiled executables**" (`bun build --compile`; there's a dedicated docs page `reference/standalone-executables.mdx`).
- Extensible: `ensureRuntimePluginSupport({ additional: { "my-runtime-module": ... } })` lets the host expose extra host-resolved modules to plugins (e.g. laziergit could expose its own `laziergit/api` module this way). Late additions throw rather than being ignored.
- Note the phrasing is Bun-specific ("installs Bun runtime support") — runtime TS/TSX plugin loading appears to lean on Bun's module loader.

### Prior art: how OpenCode exposes plugins

`opencode/packages/tui/src/plugin/slots.tsx` (verified source): OpenCode wraps `createSolidSlotRegistry` + `createSlot` behind its own `TuiPluginApi`/`TuiSlotMap` types from `@opencode-ai/plugin/tui`, passes `{ theme }` as host context, logs plugin errors via `onPluginError`, and exposes a narrow `{ register(plugin), dispose() }` host surface. OpenCode's TUI package deps: `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, and **`effect`** — OpenCode's TUI itself uses Effect, so the OpenTUI + Effect combination laziergit plans is already proven in production.

## 7. Runtime requirements (Bun vs Node, native core)

- **Zig native core confirmed**: `packages/core/src/zig/` (build.zig, lib.zig, terminal.zig, yoga.zig, text-buffer-view.zig, native-renderable.zig, ...). Exposes a C ABI. Building from source requires Zig, but consumers get **prebuilt optional-dependency binaries**: `@opentui/core-{darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64, win32-arm64, linux-x64-musl, linux-arm64-musl}` (from core package.json). `OPENTUI_LIBC=musl|glibc` override on Linux.
- **Bun is the primary runtime** (FFI via `bun:ffi`; core deps include `bun-ffi-structs`).
- **Node.js works but is experimental** (docs/getting-started.mdx, verbatim): "To create a native renderer in Node.js, you need **Node.js 26.4.0 with experimental FFI enabled**" (`--experimental-ffi`, plus `--allow-ffi` if using Node permissions). Importing portable entry points (`@opentui/keymap`, `@opentui/core` types/utils) works in any Node without FFI; only `createCliRenderer()` needs it.
- Verified in `packages/core/src/platform/ffi.ts`: a backend abstraction dispatches to `bun:ffi` on Bun and `node:ffi` on Node, else throws `"OpenTUI native FFI is not available for this runtime yet"`. The Node backend has explicit gaps: "Node FFI callbacks are same-thread only", no `usize`, no Bun N-API types, no string-return normalization, no pointer overrides.
- Platforms: macOS, Linux (glibc + musl), Windows (x64 + arm64). Windows actively supported (Windows Terminal fixes, but see segfault issue #1185).
- Multiplexer/remote awareness: v0.3.0 added "remote shell detection, Zellij support"; v0.4.2 added OSC 52 clipboard.

## 8. How real apps use it

- **OpenCode** (anomalyco/opencode, ~186.6k stars): its TUI (`packages/tui`, v1.18.x) is built on `@opentui/solid` + `@opentui/core` + `@opentui/keymap` + `effect`. It was rewritten from the original Go/Bubble Tea TUI. It builds its plugin system directly on OpenTUI's slot registry (§6) and ships feature-plugins/builtins of its own. This is the "powers OpenCode in production" claim, verified at the dependency level.
- **terminal.shop**: stated in official docs as upcoming ("will also power terminal.shop").
- `@opentui/ssh` exists specifically to serve OpenTUI apps over SSH (the terminal.shop model).
- `bun create tui` / create-tui (github.com/msmps/create-tui) scaffolds React/Solid/core templates.

## 9. Performance model and limitations

Performance model (from docs + source):

- Render loop with `targetFps` (default 30) and `maxFps` cap (60) for immediate re-renders; **on-demand rendering** — renderer idles until state changes; `requestLive()`/`dropLive()` reference counting for animations; `await renderer.idle()` for quiescence (great for tests).
- Native Zig side owns the frame: layout (yoga.zig), text buffers, hit-testing, split-footer scrollback bookkeeping, and emits frames atomically; v0.4.2 added output backpressure handling. Third-party writeups describe shadow-buffer cell diffing in the Zig core (plausible; not verified line-by-line in source).
- ScrollBox does **viewport culling**; benchmarks in-tree (layout, box-draw, render-traversal, text-table).
- Screen modes: `"alternate-screen"` (default), `"main-screen"`, `"split-footer"` (persistent footer + scrollback capture — how OpenCode renders its prompt); `externalOutputMode: "capture-stdout" | "passthrough"` for stray stdout writes.
- **`renderer.suspend()` / `renderer.resume()`** — fully release the terminal (raw mode, mouse, input) and reclaim it. This is the primitive laziergit needs to shell out to `$EDITOR`/`git rebase -i`/pagers. `pause()` stops rendering only. `clearOnShutdown: false` keeps output visible after exit.
- Built-in debug console overlay (`renderer.console.show()`, `openConsoleOnError` in dev), stats/gathering hooks, tree-sitter runs via `web-tree-sitter` with a `TreeSitterClient`.

Known limitations relevant to laziergit:

- **No PTY / embedded terminal emulator renderable yet.** Open item #440 ("Add StatelessTerminal renderable. Render ANSI as opentui styled text") plans ghostty-vt/VTerm FFI bindings and a `StatelessTerminalRenderable` "for opencode bash previews" — still open as of 2026-07-17, stacked on a Zig 0.15 upgrade (#439). Today you cannot embed a live interactive terminal app in a pane; you can only `suspend()` and hand over the whole terminal, or render captured ANSI yourself (issue #328 asked for ANSI-to-styled-text highlighting).
- Node support is new (v0.4.0, June 2026) and gated on Node 26.4 experimental FFI with documented backend gaps.
- React >= 19.2 hard requirement.
- Pre-1.0: deprecations happen (e.g. `render()` → `createRoot()`); `main-screen` mode "is not a true scrollback-native inline renderer".
- Windows: open native crash under rapid React mount/unmount (#1185).

## 10. API stability summary

- Version 0.4.4, all packages versioned in lockstep; daily `0.0.0-<date>-<sha>` snapshot releases for living-at-head consumers (OpenCode pins via Bun catalogs).
- Breaking-ish changes have landed inside 0.x (native yoga swap in 0.4.1, Node support in 0.4.0, `render()` deprecation) but release notes are detailed and migration has been incremental.
- Docs are extensive and versioned in-repo (`packages/web/src/content/docs`) with an AI-skill layer (`npx skills` / SKILL.md) — docs include per-component MDX pages, core-concepts (renderer, layout, keyboard, colors, lifecycle, testing, constructs-vs-renderables), plugins, keymap, and reference (env-vars, standalone executables, tree-sitter, color-matrix).

## Uncertain / could not verify

- **Dirty-region/cell-diff rendering details**: the "shadow buffer diffing" description comes from a third-party article (starlog.is), not verified in Zig source. The atomic-frame/split-footer behavior *is* documented first-party.
- **Whether runtime plugin loading (external TS/TSX from disk) works under Node**: docs consistently say it "installs Bun runtime support"; I found no Node-path statement. Assume Bun-only until tested.
- **React renderer production usage**: no verified large production app on `@opentui/react` (OpenCode uses Solid). The React package is maintained in lockstep with many examples/tests, but I could not verify a flagship React consumer.
- **Vue renderer history**: `@opentui/vue` on npm (0.1.25, snapshots ending 2025-09-30) clearly predates removal from the monorepo; exact removal rationale/date not traced.
- **terminal.shop** usage is a forward-looking statement in the docs, not shipped proof.
- **Issue #440 timeline** for terminal embedding: open, no merge date; do not plan on embedded PTY panes near-term.
- Exact `KeyEvent`/focus-traversal APIs beyond what's quoted (e.g. whether there's built-in Tab-order focus traversal — I saw click-based `autoFocus` and manual `focus()`, but no documented automatic tab-cycling; likely host responsibility or via keymap).
- npm publish size/install weight of the 8 native binary optional deps (not measured).

## Source URLs

- Repo: https://github.com/anomalyco/opentui (redirect from https://github.com/sst/opentui)
- Releases: https://github.com/anomalyco/opentui/releases
- Getting started (Node/Bun requirements): https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/getting-started.mdx (rendered: https://opentui.com/docs/getting-started)
- React bindings: https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/bindings/react.mdx
- React package: https://github.com/anomalyco/opentui/blob/main/packages/react/package.json, README.md
- Plugin slots: https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/plugins/slots.mdx, plugins/core.mdx, plugins/react.mdx
- Keyboard: https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/keyboard.mdx
- Layout (Yoga): https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/layout.mdx; native impl at packages/core/src/zig/yoga.zig
- Renderer (screen modes, suspend, fps): https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/renderer.mdx
- Colors: .../core-concepts/colors.mdx; Diff: .../components/diff.mdx; ScrollBox: .../components/scrollbox.mdx
- FFI backends: https://github.com/anomalyco/opentui/blob/main/packages/core/src/platform/ffi.ts; loader: packages/core/src/zig.ts
- Focus/mouse source: https://github.com/anomalyco/opentui/blob/main/packages/core/src/Renderable.ts
- Keymap: https://github.com/anomalyco/opentui/blob/main/packages/keymap/README.md
- OpenCode TUI deps: https://github.com/anomalyco/opencode/blob/main/packages/tui/package.json; slots: packages/tui/src/plugin/slots.tsx
- Terminal embedding issue: https://github.com/anomalyco/opentui/issues/440
- npm: https://registry.npmjs.org/@opentui/core, https://registry.npmjs.org/@opentui/vue
