# ADR-0006 — Themes are global declarative resources

**Status**: accepted

## Context

The first theme implementation put complete palettes in `extension/theme.ts`, accepted one
hard-coded preset name in config, and let the user override individual semantic tokens. It
already had the important runtime property: `useTheme()` reads a per-kernel external store, so
replacing a theme re-renders live components without reactivating Extensions or remounting
Panes.

What it did not have was an authoring or distribution seam. Adding a palette required changing
core, the config schema could only enumerate bundled names, and there was no picker. The diff
view also used OpenTUI's dark defaults, which meant the shipped light preset only themed the
frame around the diff.

The vendor implementations split into three useful models:

- OpenCode loads many declarative JSON themes, resolves palette references and dark/light
  variants, lets project and user resources shadow built-ins, and previews choices live.
- Pi validates a strict theme document, discovers global/project/package resources, reports
  collisions and parse failures, hot reloads them, and supports automatic dark/light pairs.
- lazygit keeps theme values directly in layered application config. This is simple, but it
  has no reusable theme resource or package boundary.

Executable theme registration through `ExtensionContext` would couple a color edit to the
Extension activation lifecycle. A malformed palette could then deactivate unrelated code, and
sharing a theme would require shipping code that needs no capability beyond reading data.

## Decision

Themes are JSON resources discovered independently from Extensions:

| Scope | Directory |
|---|---|
| built-in | palettes compiled with laziergit |
| global | `~/.config/laziergit/themes/*.json` |

Global names shadow built-ins. An invalid global document does not hide a valid built-in theme.
Files are validated before publication and every problem names the source file and field. Once
a custom theme has resolved successfully, an invalid edit retains that last good value until
the source is repaired or deleted.

A document has this shape:

```json
{
  "$schema": "../theme.schema.json",
  "name": "rose-pine",
  "description": "Muted dark rose palette",
  "appearance": "dark",
  "extends": "nocturne",
  "palette": {
    "base": "#191724",
    "rose": "#ebbcba"
  },
  "tokens": {
    "background": "base",
    "accent": "rose",
    "borderFocused": "rose"
  }
}
```

`extends` makes partial themes useful without making missing tokens implicit. Palette entries
are six-digit hex colors, token values are either the same form or a key in `palette`, and
unknown fields or semantic tokens are errors. The `background` token alone also accepts
`"transparent"` to preserve the terminal canvas. A global theme may inherit from a built-in or
another global theme; cycles and missing parents reject the affected theme.

Global config owns selection:

```jsonc
{ "theme": { "preset": "rose-pine" } }
```

For terminal-following selection, `preset` is a pair:

```jsonc
{
  "theme": {
    "preset": {
      "dark": "catppuccin-mocha",
      "light": "catppuccin-latte"
    }
  }
}
```

The active side follows OpenTUI's terminal appearance event. It uses dark while appearance is
not yet known, changes without an Extension reload, and updates the renderer's own background
as well as the React tree. The generated `system` choice derives its colors from the terminal's
reported palette and refreshes when that palette changes.

`app.theme` opens a filterable, name-only picker. Cursor movement previews through the existing
`ThemeStore`; Escape restores the prior snapshot. Confirmation makes the smallest JSONC edit to
`theme.preset` in global config, preserving comments and unrelated formatting. The write is an
atomic same-directory rename. Repository config cannot select or override a theme.

Themes remain data rather than an `ctx.themes.register()` API. Extensions consume semantic
tokens through `useTheme()` and cannot depend on a theme by name.

## Consequences

- A theme edit is watched and applied without deactivating an Extension or losing Pane state.
- The config schema's preset list is generated from the live catalog, while
  `theme.schema.json` gives theme authors completion for the stable document format.
- Built-in and global themes share one resolver, so inheritance and diagnostics stay consistent.
- Every exposed token must drive a real rendering seam. `diffAdded` and `diffRemoved` now feed
  OpenTUI's diff signs and adaptive line tints; the old `diffHunkHeader` token is removed
  because OpenTUI strips hunk headers and exposes no way to render it.
- Bundled presets are held to contrast floors. User resources are validated structurally, not
  rejected for aesthetic or accessibility choices; the preview makes the result inspectable.

## Alternatives rejected

- **Theme registration in executable Extensions.** It gives static JSON a lifecycle,
  permissions, and failure radius it does not need.
- **Only inline config tokens.** It cannot name, inherit, preview, shadow, or distribute a
  palette as one resource.
- **CSS variables or terminal ANSI names.** OpenTUI components consume color values directly,
  and semantic application tokens are the stable contract an Extension needs.
- **Silently accepting arbitrary color strings.** It postpones a typo until rendering and
  makes diagnostics depend on which component happens to use the token first.
