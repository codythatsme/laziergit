# Commands are the only persistent operation catalog

laziergit represents every persistent operation as one Command, including operations contributed to another Extension's Pane. A contextual Command targets the current selection through that Pane's Row Source; `ctx.popups.menu` remains only for a Transient Chooser inside a Command workflow. This removes the parallel menu registry whose separate definitions could hide behavior behind `x` and drift from direct Keybindings.

## Considered options

- Keep ordinary Commands and let contributors close over `RowSource.selected()`. This is small, but Core cannot react to selection availability or guarantee that `when` and `run` sample the same row.
- Add a general `CommandTarget` provider registry. This supports non-list targets, but adds target ids, provider handles and invalidation to solve use cases the bundled Extensions do not have.
- Let a Row Source back a contextual Command. This reuses the existing cross-Extension selection seam, keeps one Command definition, and lets Core own targeting, availability, discovery, collision handling and execution.

Key ownership is resolved independently of conditional availability: changing selection must not silently change what a stroke means. User overrides still outrank defaults, and a losing Command remains palette-accessible whenever it is available.

## Inventory

| Former persistent catalog | Target | Conditional operations | Replacement |
|---|---|---|---|
| `branches.actions` | `Branch` | checkout/delete/force-delete/merge off HEAD; push without upstream; legal fast-forward; browsable PR URL | contextual branch Commands plus pane-scoped create |
| `remote-branches.actions` | `RemoteBranch` | none | contextual remote-branch Commands; delete stays on `d` and detached checkout moves to `h` |
| `files.actions` and the fixed folder chooser | `FileChange` / internal folder row | stage/discard outside conflicts; unstage staged files and folders; conflict open/stage-resolved | selected-path stage toggle plus direct selected-path unstage, unstage-all, and discard-all Commands |
| `commits.actions` | `Commit` | non-merge revert; browsable remote; legal first-parent rewrites | contextual commit Commands |
| `stash.actions` | `StashEntry` | none | contextual stash Commands |
| `commit-flow.actions` | `WorkingTreeStatus` | staged submit/signoff; conflict-free unstaged stage-all; existing HEAD amend; kept draft discard | conditional commit-flow Commands |
| `sync.actions` | `GitState` | tracking/untracked/on-branch state; browsable remote | global conditional sync Commands |
| `diff.actions` | `DiffTarget` | selected path; working-tree stage; staged unstage | Pane Commands reading the current diff target |

No production Extension contributed a `menus.extend` splice; the only splice consumer was framework coverage. Cross-Extension composition is preserved by registering a contextual Command against a needed Extension's exported Row Source. Merge mode, merge recovery, and conflict continuation remain Transient Choosers because they decide how an already-invoked Command proceeds.

## Bundled key migration

- Branches: menu `c/n/m/d/shift+d/u/p/f/o` becomes `space/n/shift+m/d/shift+d/u/shift+p/f/o`.
- Remote branches: `c/n/d/h/u/f` becomes direct `space/n/d/h/u/f` Commands.
- Files and folders: `s/u/m/d/o/a/r/shift+d` becomes `space/u/space/d/o/a/r/shift+d`.
- Commits: `return/c/v/o/y/q/r/d/s/m/h` keeps the same direct keys.
- Stash: `a/p/d/b` becomes `space/p/d/b`.
- Commit flow: `c/shift+a` stay contextual to Files; submit/signoff/stage-all/amend/discard
  stay available through the palette without requiring a persistent Commit pane.
- Sync: `p/u/o/l/r/f/n/b/y` becomes `shift+p/u/o/p/r/f/n/b/y`.
- Diff: `v/y/s/u/r` keeps the same direct keys.

The remote-deletion feature remains owned by its narrow merged PR; this migration only promotes its existing `d` action into the Command catalog.

This is a deliberate breaking public-API migration: `MenuMap`, `MenuRegistry`, and the retired `*.menu` / `sync.menu` Command ids have no compatibility aliases. Existing keybinding overrides for those entry-point ids become inert; users bind the promoted Command ids instead. Keeping an alias would preserve the `x` prerequisite this decision removes.
