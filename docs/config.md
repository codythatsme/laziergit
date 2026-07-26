# laziergit configuration

laziergit reads two files, both optional, both JSONC (JSON plus `//` and `/* */` comments
and trailing commas):

| File | Scope |
|---|---|
| `~/.config/laziergit/config.jsonc` (or `$XDG_CONFIG_HOME/laziergit/config.jsonc`) | every repository |
| `<repo>/.laziergit/config.jsonc` | this repository only |

The repo file is merged over the global one **key by key**: objects merge, so a repo file
can override one Extension option and leave the rest; arrays replace wholesale, so a repo
Layout is never a confusing concatenation of two Layouts.

Every value is validated. A value laziergit cannot use falls back to its default with a
diagnostic naming the exact path (`extensions.gh-workflows.limit: Must be at most 100`) —
bad config degrades one setting, it never blocks startup. A file that fails to parse is
skipped entirely, with its line and column reported; the other file still applies.

laziergit writes `config.schema.json` next to the global config on every load, covering the
core sections plus one section per installed Extension. Point your editor at it:

```jsonc
{
  "$schema": "./config.schema.json",
}
```

## What a change costs

Editing `layout`, `keybindings`, `theme`, `statusline`, `leader`, or `git` rearranges the
running screen — no Extension is reloaded and no Pane loses its cursor. Editing anything under
`extensions` reloads every Extension, because `ctx.config` is a constant snapshot for the
lifetime of an activation (see [extension-api.md §5.6](./extension-api.md)) and reload is
how a new snapshot is delivered. Reformatting the file — reordering keys, changing comments
or whitespace — costs nothing: only the values are compared.

## `layout` — where Panes go

```jsonc
{
  "layout": {
    "columns": [
      ["files", ["branches", "commits"], "stash"],
      { "weight": 2, "cells": ["diff"] },
    ],
    "focus": "files",
  },
}
```

- A **column** is either an array of cells, or `{ "weight": <number>, "cells": [...] }`.
  `weight` is that column's share of the screen width relative to the others (default `1`).
- A **cell** is a Pane id (`"files"`), or an array of Pane ids that share the cell as tabs
  (`["branches", "commits"]` — one visible at a time, `[`/`]` cycles them).
- Cells stack top to bottom and share their column's height, in equal shares.
- `focus` is the Pane the keyboard starts in. Omit it and laziergit opens on the first cell
  of the first column — which is the right place to *read* first and often the wrong place
  to *work* first, since a summary Pane has no rows to walk.

Ids nothing has registered are skipped, `focus` included. A Pane the Layout never mentions
still appears — it lands wherever its Extension's `placement` hint asks (`column`, `order`,
`tabWith`), which is the whole point of hints: config wins where it speaks, hints decide the
rest. Omit `columns` and every Pane is placed by its hint, which is why `{ "focus": "files" }`
alone is a valid Layout. Omit `layout` entirely and both apply.

## `keybindings` — rebinding Commands

```jsonc
{
  "keybindings": {
    "gh-workflows.open-run": "return",      // replace the Command's default keys
    "files.toggle-stage": ["s", "space"],   // several keys for one Command
    "app.quit": null,                        // unbind it
  },
}
```

The key is a Command id, the value a [key spec](./extension-api.md) (`"c"`, `"ctrl+r"`,
`"gg"`, `"ctrl+p"`, `"<leader>p"`), an array of them, or `null` to unbind. A config binding
replaces the Command's declared defaults rather than adding to them. When two Commands in
the same scope claim one key, the later registration wins and the earlier one keeps its
palette entry without the key; the swap is reported as a diagnostic.

The files Pane's tree Commands, for reference — all rebindable the same way:

| Command | Default | |
|---|---|---|
| `files.toggle-collapse` | `return` | Expand or collapse the folder under the cursor. Spell it `return`, never `enter` — the latter is a different, unreachable stroke name that binds cleanly and never fires |
| `files.collapse-all` / `files.expand-all` | `-` / `=` | Fold or unfold every folder |
| `files.toggle-view` | `` ` `` | Switch between the tree and a flat list of full paths |

Core's own Commands, all rebindable:

| Command | Default | |
|---|---|---|
| `app.palette` | `ctrl+p`, `:` | Command palette. Not `mod+p`: a macOS terminal that can report cmd is also free to keep it, and several do ([ADR-0004](./adr/0004-terminal-safe-default-keys.md)) |
| `app.cheatsheet` | `?` | Every key live in the focused Pane, then the globals |
| `app.focus.next` / `app.focus.previous` | `tab` / `shift+tab` | Move between Panes |
| `app.tab.next` / `app.tab.previous` | `]` / `[` | Cycle tabs inside the focused cell |
| `app.reload` | — | Reload every Extension |
| `app.quit` | `q` | Quit |

## `leader` — the `<leader>` token

```jsonc
{ "leader": "space" }
```

The key that `<leader>` expands to in any key spec. Defaults to `space`.

## `theme` — semantic color tokens

```jsonc
{
  "theme": {
    "accent": "#7aa2f7",
    "selection": "#283457",
  },
}
```

Any subset of the tokens on `Theme` ([§1.8](./extension-api.md)); unlisted tokens keep
their default. Extensions consume tokens through `useTheme()` and never pick raw colors,
so one override retints every Pane at once.

## `git` — how the repository is watched

```jsonc
{
  "git": {
    "refreshIntervalMs": 2000,
    "commitLimit": 200,
  },
}
```

| Setting | Default | |
|---|---|---|
| `refreshIntervalMs` | `2000` | How often laziergit looks for changes made outside it. 250–60000. |
| `commitLimit` | `200` | How much of HEAD's history the git store holds. 1–5000. |

laziergit does not watch `.git` for file events. Every `refreshIntervalMs` it reads the
working-tree status and the list of every ref, and re-reads the repository only when one of
them differs — so a `git commit`, `git checkout`, or a file edited in another terminal all
show up within one interval. Both reads take no locks, so the poll never contends with
your own `git` and never triggers itself. Raising the interval on a very large repository
trades promptness for fewer reads; the screen still refreshes immediately after anything
laziergit itself does.

`commitLimit` bounds only what the store holds. Extensions page deeper on demand with
`ctx.git.raw(["log", ...])`. Changing it re-reads history; changing the interval only
reschedules the next check.

## `statusline` — segment order

```jsonc
{
  "statusline": {
    "left": ["ci-status"],
    "right": ["github-prs"],
    "hidden": ["noisy-extension"],
  },
}
```

Ids listed in `left`/`right` come first, in the order written, overriding the segment's own
`align`. Every other segment falls back to its declared `align` and `priority`. `hidden`
removes a segment entirely. Ids nothing registered are ignored.

The status line shares the bottom row with the **hint bar** — the keys the focused Pane can
act on right now, which core writes along the left and which changes as you tab. Segments
follow it, so `"right"` is where one has room; pinning a segment `left` puts it beside the
hints and both clip when the terminal is narrow. Nothing in config turns the hint bar off:
what appears there is whichever live Commands carry a `hint`, so an Extension decides for its
own Pane, and `keybindings` above decides what each one is labelled with.

## `extensions` — per-Extension options

```jsonc
{
  "extensions": {
    "files": { "view": "tree", "collapseThreshold": 200 },
    "diff": { "view": "unified", "context": 3 },
    "gh-workflows": { "limit": 30 },
  },
}
```

One section per Extension name, holding the options that Extension declared with
`option.*`. Values arrive on `ctx.config` fully typed and defaulted. An unknown option, or
one of the wrong type or outside its declared range, is reported and replaced by its
default.

Options the Bundled Extensions declare:

| Option | Default | |
|---|---|---|
| `files.view` | `"tree"` | `"tree"` draws a folder hierarchy; `"flat"` draws one list of full paths. A session toggle (`` ` ``) layers over this rather than editing it |
| `files.collapseThreshold` | `200` | Fold a folder on first draw once it holds this many changed files, so a fresh un-ignored `node_modules/` cannot bury the rest of the tree. Expanding one explicitly outranks the threshold and survives the refresh poll. `0` disables it |
| `diff.view` | `"unified"` | Initial diff layout |
| `diff.context` | `3` | Lines of context around each hunk |
