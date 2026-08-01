# laziergit

A lazygit-inspired git TUI built as a deliberately light core plus an infinitely-extensible TypeScript extension API. All git features — including the built-in everyday ones — are Extensions.

## Language

**Core**:
The extension-free shell: pane/layout framework, git service (plumbing plus a curated set of porcelain helpers), event bus, keybinding system, and config. Contains zero git UI features. "Host" is acceptable for Core in its module-resolution/loading role.
_Avoid_: engine, framework

**Extension**:
A TypeScript module (a lone `.ts(x)` file or a package directory) that adds functionality through the public extension API. The only way any feature — first-party or third-party — enters the app.
_Avoid_: plugin, addon, mod

**Bundled Extension**:
A first-party Extension shipped with the default distribution (e.g. files, commits, branches). Built on the same public API as third-party Extensions, with no private privileges.
_Avoid_: built-in feature, core feature

**Extension Context (`ctx`)**:
The typed object handed to an Extension's `activate`; the entire public API surface an Extension can touch. Promise-first, with an Effect escape hatch for power users.
_Avoid_: API object, app handle

**Pane**:
A rectangular region of the TUI owned by an Extension, rendered as a React component and placed by the Layout, not by the Extension itself.
_Avoid_: panel, window, view

**Layout**:
The user-config-owned arrangement of Panes into the screen (columns/tabs). Extensions register Panes; the Layout decides where they appear.
_Avoid_: workspace, arrangement

**Command**:
A named operation registered by an Extension, invokable via Keybinding or the palette. The unit all key-driven behavior is built from — one registration also owns its conditional availability, selected-row targeting, Cheat Sheet row and, where it carries a `hint`, Hint Bar entry.
_Avoid_: action, binding (a binding maps a key to a Command)

**Transient Chooser**:
A modal presented during one Command's workflow to choose how that Command continues, such as a merge mode or recovery path. It is not a standing catalog and contributes no Keybinding, palette row, Cheat Sheet row or Hint Bar entry.
_Avoid_: action menu, command menu

**Hint Bar**:
The left of the bottom row, where Core prints the keys the focused Pane can act on right now, drawn from the `hint` on each live Command. Contextual by construction: it changes with focus, and collapses to a Pane's capture keys while that Pane owns the keyboard.
_Avoid_: footer, options bar, status bar (the Status Line is the same row's other half)

**Cheat Sheet**:
The `?` overlay listing the focused Pane's keys, then its capture keys, then the globals. Derived from the Command catalog; scoped to one Pane, unlike the palette, which is global.
_Avoid_: help, keymap popup

**Exported API**:
The typed surface an Extension itself exports for other Extensions to consume (e.g. the branches Extension's Row Source). Distinct from the Core's Extension Context.
_Avoid_: plugin interface

**ScopedId**:
A registration id carrying the owning Extension's name as its prefix (`"gh-workflows.refresh"`), enforced at the type level. The one naming rule for everything an Extension registers.
_Avoid_: namespace, qualified name

**Path Tree**:
The files Pane's projection of `WorkingTreeStatus` into a flat-rooted folder hierarchy — one row per changed path, one row per directory above it, and single-child directory chains compressed into one row. Directory rows are not `FileChange` values, so they carry no Row Decoration and no `FilesApi` selection.
_Avoid_: file tree view, explorer, directory listing

**Row Source**:
An Exported API from a list Extension that names its Pane, exposes the current selected row, accepts Row Decorations, and notifies contextual Commands when selection changes. It is the typed target seam for another Extension's Command.
_Avoid_: target registry, row provider

**Row Decoration**:
Extra visual data (badge, color, suffix) an Extension attaches to rows of another Extension's list Pane, e.g. PR status on branch rows.
_Avoid_: annotation
