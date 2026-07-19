# Plugin / Extension API Prior Art — Research for laziergit

Researched 2026-07-17 against primary sources (official docs, GitHub source, published type
definitions downloaded and grepped locally). Local copies of inspected sources are in
`scratchpad/research/src/` (obsidian.d.ts, vscode.d.ts, @raycast/api npm package, magit lisp files).

Target context: **laziergit** — lazygit-inspired git TUI, deliberately light core,
infinitely-extensible TypeScript plugin API, OpenTUI + React frontend, Effect backend.

---

## 1. VS Code Extension API

**Sources:**
- https://code.visualstudio.com/api/references/activation-events
- https://code.visualstudio.com/api/references/contribution-points
- https://code.visualstudio.com/api/get-started/extension-anatomy
- https://code.visualstudio.com/api/advanced-topics/extension-host
- https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts (MIT header verified)

### Declarative layer: contribution points

Extensions declare static capabilities in `package.json` under `contributes`: `commands`,
`menus`, `keybindings`, `views`, `viewsContainers`, `configuration`, `languages`, `themes`,
`customEditors`, `taskDefinitions`, etc. Per the docs: most contribution points are
"declarative — defined statically in package.json without code execution," but extensions must
register runtime implementations (e.g. `vscode.commands.registerCommand()`) during activation
to fulfill them. The split lets VS Code render menus, keybindings, and settings UI **without
loading any extension code**.

### Activation events (lazy loading)

Extensions load only when an activation event fires: `onLanguage:python`,
`onCommand:extension.sayHello`, `workspaceContains:**/.editorconfig`, `onView:id`,
`onStartupFinished`, wildcard `*` (discouraged), ~25 total. Key evolution, verified from docs:

> As of VS Code 1.74.0+, events like `onLanguage`, `onCommand`, `onView`, `onCustomEditor`,
> and `onAuthenticationRequest` are **auto-generated** from contribution points — explicit
> declarations are no longer required.

Lesson: they eventually derived activation automatically from the declarative manifest,
eliminating a whole class of "declared the command but forgot the activation event" bugs.

### Runtime API: the vscode.d.ts approach

The entire imperative API is **one ambient module** (`declare module 'vscode'`), currently
**21,235 lines**, organized into **15 namespaces** (verified by grep):

```
tasks, env, commands, window, workspace, languages, notebooks, scm,
debug, extensions, authentication, l10n, tests, chat, lm
```

Extension anatomy (verified from docs):

```typescript
export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand('helloworld.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World!');
  });
  context.subscriptions.push(disposable);  // disposal tied to extension lifecycle
}
export function deactivate() {}            // optional cleanup
```

- `main` points at the entry file; `engines.vscode` declares the minimum API version, and the
  `@types/vscode` package version "correlates directly with your `engines.vscode` specification."
- Every registration returns a `Disposable`; pushing into `context.subscriptions` makes cleanup
  automatic on deactivate.

### API stability strategy: proposed APIs

Verified from docs: "once we introduce an API, we cannot easily change it anymore." New APIs
ship as **proposed APIs** — "subject to change, only available in Insiders distribution and
should not be used in published extensions." Extensions opt in via
`"enabledApiProposals": ["<name>"]` + per-proposal `vscode.proposed.<name>.d.ts` files; the
marketplace **refuses** extensions using proposed APIs. Two-tier stability: frozen stable
surface + explicitly-unstable experiments.

### Extension host isolation

Verified from docs: extensions run in a separate Extension Host process so "misbehaving
extensions cannot destabilize the editor." Guarantees: extensions cannot impact startup
performance, cannot slow down UI operations, **cannot modify the UI** (no DOM access). Three
host kinds: local (Node.js), web (WebWorker), remote (Node.js in container/SSH);
`extensionKind: ui | workspace` controls placement.

### Key lessons for laziergit

1. Declarative manifest + imperative runtime is the proven hybrid; derive lazy-activation from
   the manifest automatically (don't make plugin authors repeat themselves).
2. A single versioned `.d.ts` ambient module is the entire developer-facing contract; typed
   flat namespaces scale to 21k lines while staying navigable.
3. Disposables tied to a context object = the cleanup story (maps directly onto Effect `Scope`).
4. "Extensions cannot modify the UI" is VS Code's most-complained-about restriction — it bought
   stability at the cost of expressiveness (webviews are the escape hatch). laziergit is
   deliberately choosing the opposite trade.

---

## 2. Neovim Lua Ecosystem + lazy.nvim

**Sources:**
- https://raw.githubusercontent.com/neovim/neovim/master/runtime/doc/lua-guide.txt
- https://lazy.folke.io/spec
- GitHub API: folke/lazy.nvim license = Apache-2.0; NVIM v0.5.0 published 2021-07-02

### The model: in-process, full access, zero sandboxing

Verified from the official Lua guide:

- Lua runs **in-process**. `plugin/` dirs on `runtimepath` execute at startup; `lua/` dirs are
  `require()`-able modules (cached; `package.loaded[mod] = nil` to reload).
- Three API layers exposed to every plugin: `vim.cmd()`/`vim.fn` (legacy Vim), `vim.api`
  (the C-level Nvim API), and `vim.*` Lua utilities. The guide: "Through this, any possible
  interaction can be done through Lua without writing a complete new API from scratch."
- Events are a first-class extension surface: `vim.api.nvim_create_autocmd(event, {callback})`,
  user commands via `nvim_create_user_command`, keymaps via `vim.keymap.set`.
- **No sandboxing is mentioned anywhere in the guide.** Plugins are trusted user code with the
  full power of the editor and of LuaJIT.

Neovim 0.5 (released 2021-07-02, verified via GitHub API) made Lua first-class (`init.lua`,
built-in LSP, Treesitter). The ecosystem shift to Lua plugins followed; the causal
"explosion" narrative is widely believed but not quantified here (see Uncertain section).
The structural reasons it is credited: in-process = zero API friction (no IPC, no
serialization boundary), full API access = plugins are peers of core features, and the
event/autocmd surface means the core is extensible *everywhere*, not at blessed points.

### lazy.nvim spec conventions (the community's manifest, evolved bottom-up)

Plugins are declared as **data** (a Lua table), and the plugin manager derives lazy-loading
from it. Verified spec fields (from lazy.folke.io/spec):

| Field | Meaning |
|---|---|
| `[1]` (string) | short git url `"folke/todo-comments.nvim"` |
| `lazy` | defer loading until needed |
| `event`, `cmd`, `ft`, `keys` | **lazy-load triggers**: on event / ex-command / filetype / keypress |
| `dependencies` | plugins loaded when this one loads |
| `init` | tiny function always run at startup (for globals) — code that must be eager |
| `opts` / `config` / `main` | config table passed to plugin's `setup()`, or custom fn |
| `build` | run on install/update |
| `branch` / `tag` / `commit` / `version` | pinning; "Full Semver ranges are supported" |
| `pin`, `enabled`, `cond`, `optional`, `priority` | update/enable/ordering control |

```lua
{
  "folke/todo-comments.nvim",
  event = "VimEnter",
  opts = { keywords = { FIX = { icon = " ", color = "error" } } },
  dependencies = { "nvim-lua/plenary.nvim" },
}
```

Plus a lockfile (`lazy-lock.json`) tracking exact installed versions.

### Key lessons for laziergit

1. In-process + full API access is the highest-leverage choice for ecosystem velocity —
   Neovim's is arguably the healthiest plugin ecosystem per-user in dev tools, with **no**
   permission system at all.
2. The *manager* (lazy.nvim), not the editor, invented the declarative lazy-loading manifest —
   and it converged on exactly VS Code's activation-event idea (`event`/`cmd`/`ft`/`keys`),
   independently. This convergence is strong evidence the pattern is fundamental.
3. Distribution is just git repos + a lockfile with semver ranges — no store required.
4. Convention: plugins expose `setup(opts)` and the manifest carries `opts` as plain data —
   config-as-data survives reloads and is diffable/serializable.

---

## 3. Magit + transient (Emacs)

**Sources:**
- https://github.com/magit/magit (GPL-3.0, verified) — README
- https://github.com/magit/transient (GPL-3.0, verified) — "the library used to implement the keyboard-driven menus in Magit"
- Source inspected: `lisp/magit-tag.el`, `lisp/magit-stash.el`, `lisp/magit-status.el` from magit/magit@main

### Why it's considered the best git interface

Magit README (verified): aspires to be "a complete Git porcelain"; "although many fine Git
clients exist, only Magit and Git itself deserve to be called porcelains"; and the core
interaction claim: **"almost everything that you see in Magit can be acted on by pressing
some key."** Discoverability without menus: state is a text buffer, every piece of state is
actionable, and command menus teach the underlying git flags.

### The transient model (prefix → infix → suffix)

Transient implements keyboard-driven menus: a **prefix** command opens a menu; **infix**
arguments are toggleable flags/options with visible state (they map 1:1 to git CLI flags);
**suffix** commands execute using the accumulated arguments. Real definition from Magit source
(`lisp/magit-stash.el`, verbatim):

```elisp
(transient-define-prefix magit-stash ()
  "Stash uncommitted changes."
  :man-page "git-stash"
  ["Arguments"
   ("-u" "Also save untracked files" ("-u" "--include-untracked"))
   ("-a" "Also save untracked and ignored files" ("-a" "--all"))]
  [["Stash"
    ("z" "both"          magit-stash-both)
    ("i" "index"         magit-stash-index)
    ("w" "worktree"      magit-stash-worktree)
    ("x" "keeping index" magit-stash-keep-index)
    ("P" "push"          magit-stash-push :level 5)]
   ["Snapshot" ...]
   ["Use"
    ("a" "Apply"         magit-stash-apply)
    ("p" "Pop"           magit-stash-pop)
    ("k" "Drop"          magit-stash-drop)]
   ...])
```

Note the shape: **pure data** (nested vectors of `(key description command-or-flag)`), with
`:level` for progressive disclosure (users can raise/lower verbosity per menu). Because the
menu is data, third-party packages splice new suffixes into *Magit's own* menus
(`transient-append-suffix` etc.) — e.g. Forge adds PR commands into `magit-dispatch`.

### Extensible-by-default core

The status buffer itself is a hook of section-inserting functions (verified from
`magit-status.el`):

```elisp
(defcustom magit-status-sections-hook
  (list #'magit-insert-status-headers
        #'magit-insert-merge-log
        #'magit-insert-rebase-sequence
        ...))
```

Any plugin can insert/remove/reorder status sections by editing a list. Magit is "just
elisp" — plugins are peers of the core, using the same primitives (this is the Emacs
structural advantage, same as Neovim's).

### Key lessons for laziergit

1. Transient-style menus are *the* keyboard-UX pattern to steal for a git TUI: visible
   argument state, flags-as-first-class-UI, self-documenting keys. lazygit's own popularity
   is partly a diluted version of this.
2. Define menus as **data**, so plugins can extend core menus (append/replace suffixes) —
   don't hardcode keybinding dispatch.
3. Make the core's own composition points (status sections, menu definitions) public plugin
   API. Light core = the built-in panes should be built with the plugin API itself.

---

## 4. Raycast Extensions (most relevant: extensions ARE React components)

**Sources:**
- https://developers.raycast.com/information/manifest
- https://developers.raycast.com/information/lifecycle
- https://developers.raycast.com/api-reference/user-interface
- https://developers.raycast.com/api-reference/user-interface/navigation
- https://developers.raycast.com/misc/faq
- `@raycast/api@1.104.23` npm package (license field: MIT), `types/index.d.ts` = 9,100 lines, inspected locally
- https://github.com/raycast/extensions (MIT, verified) — store monorepo

### Rendering model (verified from FAQ, exact quote)

> "we implemented a custom reconciler that converts your React component tree to a render tree
> that Raycast understands. The render tree is used natively to construct a view hierarchy that
> is backed by Apple's AppKit."

Extensions use React but **not react-dom** — "everything is rendered natively in Raycast.
There isn't any HTML or CSS involved." This is exactly the OpenTUI position: React as the
declaration layer, custom renderer as the display layer.

### Manifest = package.json with extra fields

Extension: `name`, `title`, `description`, `icon`, `author`, `platforms`, `categories`,
`commands[]`, optional `preferences[]`, `tools`. Command: `name` (maps to entry file
`src/<name>.tsx`), `title`, `description`, and **`mode`**:

- `"view"` — pushes a main view; **default export must be a React component**
- `"no-view"` — headless; **default export is an async function**
- `"menu-bar"` — returns a Menu Bar Extra component

Preferences are declared in the manifest (types: textfield, password, checkbox, dropdown,
appPicker, file, directory) and read with a typed
`getPreferenceValues<Values>(): Values` (verified in index.d.ts) — declarative settings UI,
typed imperative access. Commands can also declare typed `arguments`.

### Lifecycle (verified quotes)

- "When a command is launched in Raycast, the command code is executed right away. If the
  extension exports a default function, this function will automatically be called." A
  returned React component "will automatically be rendered as the root component."
- On return to root search "Raycast unloads the entire command from memory"; "there are memory
  limits for commands, and if those limits are exceeded, the command gets terminated, and
  users will see an error message." → commands are short-lived processes, error isolation by
  process death + user-visible error UI.

### API shape highlights (from types/index.d.ts, verbatim)

Launch props are a **typed generic** over the manifest's declared arguments:

```typescript
export declare type LaunchProps<T extends {
    arguments?: Arguments;
    draftValues?: Form.Values;
    launchContext?: LaunchContext;
} = {...}> = {
    launchType: LaunchType;            // "userInitiated" | background
    arguments: T["arguments"];
    draftValues?: T["draftValues"];
    launchContext?: T["launchContext"]; // set when launched programmatically via launchCommand
    fallbackText?: string;
};
```

Navigation is a stack of React components:

```typescript
export declare interface Navigation {
    push: (component: ReactNode, onPop?: () => void) => void;
    pop: () => void;
}
function useNavigation(): Navigation;
```

UI is a **small closed set of compound components**: `List` (+ `List.Item`, `List.Section`,
`List.EmptyView`), `Grid`, `Detail`, `Form`, `ActionPanel`, `Action` — implemented as
`FunctionComponent<Props> & Members` (e.g. `export declare const List:
FunctionComponent<ListProps_2> & ListMembers`). Extensions cannot draw arbitrary pixels; they
compose blessed components. All support `isLoading`; docs stress "render something as quickly
as possible."

### Distribution

All public extensions live in the raycast/extensions monorepo (MIT); submission = PR + review
against community/extension guidelines; merged extensions publish to the Store.

### Key lessons for laziergit

1. The view/no-view/menu-bar **mode** split is clean: default export is either a component or
   an async function, decided by one manifest field.
2. Typed generics flowing from manifest declarations (`LaunchProps<{arguments: ...}>`,
   `getPreferenceValues<T>`) give plugin authors end-to-end type safety with zero runtime cost.
3. A constrained component vocabulary keeps every extension feeling native and keeps the
   renderer contract small. (laziergit can be more permissive than Raycast since OpenTUI
   exposes general primitives — but a blessed component kit is still what makes extensions
   feel coherent.)
4. Kill-and-restart per command + memory limits is a viable error-isolation model even without
   sandboxing ambitions.

---

## 5. Zed (WASM) and Obsidian (unsandboxed TS) — two opposite trust models

### Zed

**Source:** https://raw.githubusercontent.com/zed-industries/zed/main/docs/src/extensions/developing-extensions.md (Zed repo; docs verified). Extensions themselves must carry one of nine accepted licenses, enforced by CI.

- Extension = git repo with `extension.toml`: `id`, `name`, `version`, **`schema_version`**,
  `authors`, `description`, `repository`. `id` is immutable post-publication.
- Can provide: languages, themes, debuggers, snippets, MCP ("context") servers. Most
  extensions are pure config/data; procedural parts are **Rust compiled to WebAssembly**
  (`crate-type = ["cdylib"]`, target `wasm32-wasip2`), implementing a `zed::Extension` trait +
  `zed::register_extension!(MyExtension)`.
- Sandboxing is real: `std::env::var` "will not yield the expected results"; extensions must
  use `zed_extension_api::current_platform()` and a `Worktree` handle for fs/PATH access;
  publish rules require extensions "not attempt to read nor modify the environment outside of
  the environment designated to them by Zed."
- API versioning: extensions depend on a versioned `zed_extension_api` crate;
  `schema_version` versions the manifest itself.
- Distribution: PR adding a git **submodule** + entry in `extensions.toml` to
  zed-industries/extensions; CI enforces license; auto-published on merge. Dev extensions
  install locally and override the published copy ("Overridden by dev extension").

Lesson: WASM buys a genuinely enforced capability model and language-agnosticism, at the cost
of a narrow, slowly-growing API surface (no UI extensions in Zed to date) and much higher
authoring friction. This is the **opposite** of the laziergit thesis; useful as the
counterexample.

### Obsidian

**Sources:** https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts
(repo license MIT, verified; 8,498 lines); https://obsidian.md/help/plugin-security;
obsidianmd/obsidian-sample-plugin manifest (0BSD).

Trust model — verified quotes: community plugins are **not sandboxed**; "Due to technical
limitations, Obsidian cannot reliably restrict plugins to specific permissions or access
levels." Plugins "can access files on your computer," "connect to internet," "install
additional programs." Mitigations: **Restricted Mode is the default** ("By default, Obsidian
runs in Restricted Mode to prevent third-party code execution"); automated scanning of every
plugin version + "safety scorecard" on the directory page; manual review "for popular,
featured, and flagged plugins."

API shape (from obsidian.d.ts, verbatim excerpts):

```typescript
export abstract class Plugin extends Component {
    app: App;
    manifest: PluginManifest;
    onload(): Promise<void> | void;
    addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => any): HTMLElement;
    addStatusBarItem(): HTMLElement;
    addCommand(command: Command): Command;
    addSettingTab(settingTab: PluginSettingTab): void;
    registerView(type: string, viewCreator: ViewCreator): void;
    registerExtensions(extensions: string[], viewType: string): void;
    registerEditorExtension(extension: Extension): void;
    registerObsidianProtocolHandler(action: string, handler: ObsidianProtocolHandler): void;
    loadData(): Promise<any>;
    saveData(data: any): Promise<void>;
}
```

The `Component` base class is the cleanup pattern: `registerEvent(eventRef)`,
`registerDomEvent(el, type, cb)`, `registerInterval(id)`, `register(cb)`, `addChild()` — every
registration is auto-disposed on `unload()`, and components form a tree so unloading cascades.
Manifest (`manifest.json`): `id`, `name`, `version`, **`minAppVersion`**, `description`,
`author`, `isDesktopOnly` — versioning is a simple min-app-version floor, and the entire API
ships as one generated `obsidian.d.ts` ("automatically generated… do not send pull requests").

Lesson: Obsidian proves an unsandboxed TS plugin system with ~million-user reach is socially
manageable via default-off (Restricted Mode) + scanning + scorecards + review — governance
substitutes for sandboxing. Its `Component`/`register*` pattern is the best-in-class
in-process cleanup story, and `Plugin extends Component` means a plugin *is* just the root of
a disposal tree.

---

## 6. Synthesis: design decisions that matter for an in-process TS+React TUI plugin API

Convergent evidence across five ecosystems points at these decisions, roughly in order of
importance for laziergit:

### 6.1 Hybrid declarative manifest + imperative runtime — and derive activation from the manifest
Every successful system has both layers: static data the host can read without executing
plugin code (VS Code `contributes`, Raycast `package.json` commands/preferences/arguments,
lazy.nvim spec tables, Zed `extension.toml`, Obsidian `manifest.json`), plus a runtime entry
point. The manifest powers: lazy loading, settings UI, command palettes, keybinding conflict
resolution, store listings — all before any JS runs. VS Code's 1.74 change (auto-generating
activation events from contributions) and lazy.nvim's `event`/`cmd`/`ft`/`keys` both say:
**activation should be inferred from declarations, not double-declared.** For laziergit: a
`laziergit` field in package.json declaring commands/panes/menus/keybindings/settings, with
activation derived ("this plugin contributes a `stash` menu suffix → load it when the stash
menu opens").

### 6.2 View plugins are React components; headless plugins are async functions
Raycast's `mode: view | no-view` split, with "default export = component or async function,"
is the cleanest known packaging of this and maps 1:1 onto OpenTUI+React. Add typed generics
flowing from the manifest (Raycast's `LaunchProps<T>`, `getPreferenceValues<T>()`), a
navigation/pane stack (`push(component, onPop?)` / `pop()`), and a blessed compound-component
kit (List/Detail/Form/ActionPanel analogues) so extensions feel native. Effect analogue:
headless commands are `Effect<A, E, GitServices>` instead of bare async functions.

### 6.3 Choose in-process full trust, and get isolation from lifecycle design instead of sandboxes
Neovim (no sandboxing at all) and Obsidian ("cannot reliably restrict plugins") demonstrate
that for developer/power-user tools, full API access is what makes ecosystems explode; Zed's
WASM sandbox shows the cost of the alternative (safe but narrow — still no UI extensions).
Obsidian's governance stack (default-restricted mode, automated scanning, scorecard, review of
popular plugins) is the mitigation template that doesn't tax plugin authors. Error isolation
without process isolation: React error boundaries per plugin pane, Raycast-style
kill-and-show-error on faulting commands, Effect fiber supervision + typed errors around every
plugin-provided effect. VS Code's process isolation buys guarantees laziergit shouldn't pay
for (its "extensions cannot modify the UI" rule is precisely what laziergit exists to negate).

### 6.4 One versioned .d.ts is the product
VS Code (`vscode.d.ts`, 21k lines, 15 namespaces, `engines.vscode` ↔ `@types/vscode`),
Obsidian (single generated `obsidian.d.ts`, `minAppVersion`), Raycast (`@raycast/api` types,
9k lines) all ship the API as one typed module with a min-host-version field in the manifest.
Adopt: a single `laziergit` ambient module / `@laziergit/api` package; manifest
`engines.laziergit` floor; and VS Code's **proposed-API gating** (unstable APIs behind an
explicit opt-in flag, banned from the store) as the mechanism for evolving the API without
freezing v1 mistakes forever.

### 6.5 Every registration returns a scoped disposable
VS Code's `context.subscriptions.push(disposable)` and Obsidian's `Component.register*` tree
are the same idea; Obsidian's cascading component tree is the stronger version. With Effect,
this is free: plugin activation runs in a `Scope`; `addCommand`/`registerPane`/`onEvent` are
scoped acquisitions; unloading a plugin closes its scope and everything unwinds. Hot-reload of
plugins (table stakes in the Neovim world, `package.loaded[mod] = nil`) falls out of the same
mechanism.

### 6.6 Menus as data; core surfaces as hooks (the Magit lessons)
Transient's prefix/infix/suffix model — menus defined as nested data of
`(key, description, flag-or-command)` with argument state visible and `:level`-based
progressive disclosure — is the best keyboard UX ever built for git, and it's extensible
*because it's data*: plugins append suffixes to core menus. Similarly
`magit-status-sections-hook` makes the status view a plugin-editable list. For laziergit:
menu definitions and pane compositions should be first-class, inspectable, plugin-patchable
data structures, and the built-in git panes should be implemented with the public plugin API
(light core = core features are just pre-installed plugins).

### 6.7 Distribution: git-native with a lockfile, store optional
Two working models: curated monorepo store (Raycast extensions repo, zed-industries/extensions
— PR review, CI license enforcement, auto-publish on merge) vs. decentralized git + manager
(Neovim: any repo; lazy.nvim adds semver ranges, `tag`/`commit`/`branch` pinning, and
`lazy-lock.json`). lazy.nvim shows a lockfile + semver-range spec gives reproducibility
without any central registry; a curated store can come later. Zed's immutable extension `id`
and license-check CI are cheap rules worth copying from day one.

### 6.8 Config-as-data in the manifest, typed access at runtime
Raycast preferences (declared types → auto settings UI → `getPreferenceValues<T>()`), VS Code
`configuration` contributions (JSON-schema settings), and lazy.nvim `opts` all converge:
plugin settings are declared declaratively so the host renders the settings UI, and read
through a typed API. Do not let plugins invent their own config files.

---

## Licenses of inspected repos/packages

| Repo / package | License | Verification |
|---|---|---|
| microsoft/vscode (`vscode.d.ts`) | MIT | file header, verified |
| neovim/neovim | Apache-2.0 + Vim license for legacy parts (GitHub API reports "Other"/NOASSERTION) | GitHub API; dual nature is well-known but not re-verified from LICENSE file |
| folke/lazy.nvim | Apache-2.0 | GitHub API, verified |
| magit/magit | GPL-3.0 | GitHub API, verified |
| magit/transient | GPL-3.0 | GitHub API, verified |
| raycast/extensions (store monorepo) | MIT | repo page, verified |
| `@raycast/api` npm package | MIT (per npm `license` field) | `npm view`, verified — note: package contains bundled/compiled code; the Raycast app itself is proprietary |
| obsidianmd/obsidian-api (`obsidian.d.ts`) | MIT | GitHub API, verified |
| obsidianmd/obsidian-sample-plugin | 0BSD | GitHub API, verified |
| zed-industries/zed (docs inspected) | (Zed is GPL/AGPL-family per repo; not re-verified here) | — |

## Uncertain / could not verify

- **"Neovim's ecosystem exploded post-Lua"** — the mechanism (in-process, full API, 0.5's
  first-class Lua on 2021-07-02) is verified, but I found no quantitative plugin-count data in
  primary sources; treat the "explosion" as consensus narrative, not measured fact.
- **Raycast extension process model** — the custom React reconciler → native AppKit rendering,
  command unloading, and memory-limit termination are verified from docs; whether each command
  runs in a dedicated Node.js child process (widely reported) was **not** confirmed by any
  primary source I fetched. The FAQ is silent on it.
- **Raycast app closed-source** — commonly known, not verified from a primary source here.
- **Zed sandbox specifics** — docs confirm WASM (`wasm32-wasip2`), no ambient env access, and
  the "environment designated to them by Zed" rule, but the exact WASI capability grants
  (which dirs, network access) were not verified.
- **Neovim license detail** — GitHub API reports NOASSERTION; the Apache-2.0 + Vim-license
  split is from prior knowledge, not re-read from the LICENSE file.
- **transient manual examples** — gnu.org rate-limited (429) and magit.vc manual 404'd; I used
  verbatim `transient-define-prefix` definitions from Magit's own source instead (stronger
  evidence anyway).
- **Obsidian `Plugin` class excerpt** — grepped from the real `obsidian.d.ts`, but the awk
  extraction may omit a few members (e.g. trailing methods after `onExternalSettingsChange`).
- **VS Code activation-event list** — the docs page summarized by the fetch model may not be
  exhaustive or perfectly current; the 1.74 auto-generation claim is directly from the page.
