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
A named action registered by an Extension, invokable via Keybinding or the palette. The unit all key-driven behavior is built from.
_Avoid_: action, binding (a binding maps a key to a Command)

**Exported API**:
The typed surface an Extension itself exports for other Extensions to consume (e.g. the branches Extension's row decorations and menu items). Distinct from the Core's Extension Context.
_Avoid_: plugin interface

**ScopedId**:
A registration id carrying the owning Extension's name as its prefix (`"gh-workflows.refresh"`), enforced at the type level. The one naming rule for everything an Extension registers.
_Avoid_: namespace, qualified name

**Row Decoration**:
Extra visual data (badge, color, suffix) an Extension attaches to rows of another Extension's list Pane, e.g. PR status on branch rows.
_Avoid_: annotation

**Splice**:
A standing, data-keyed insertion of menu items into another Extension's menu, keyed by menu id and applied whenever the owner (re)registers. The named surface a Splice targets is its seam.
_Avoid_: injection, hook
