# List filtering and search

## Goal

Pressing `/` in a list Pane opens a one-line query editor. Filterable lists update while the
query is typed; searchable lists retain every row and move the cursor to matches. The behavior
is available to every Extension through the public `"laziergit"` package and is used by the
Files, Branches, Commits, and Stash Bundled Extensions.

## Lazygit reference behavior

The pinned lazygit source separates two concepts behind the same `/` key:

- `IFilterableContext` projects the model through a list of matching source indices. Files,
  branches, and stash use this path.
- `ISearchableContext` keeps the model intact, records matching row positions, and moves among
  them with `n` and `N`. Local commits use this path so the commits around a match remain
  available for ordinary movement.

Both modes use a bottom-row editor while typing and keep a bottom-row summary after Enter.
Escape cancels the query. Filtering selects the first match as the query changes and maps the
selected filtered index back to its source index when the filter clears. Search starts at the
first match after the current cursor and wraps; after ordinary cursor movement, `n` or `N`
first returns to the current search match when the cursor has crossed it, then advances.

Lazygit's default filter matcher is smart-case, multi-term substring matching: whitespace
separates required terms, lowercase terms ignore case, and a term containing uppercase is
case-sensitive. Its commit search is smart-case contiguous substring matching.

Primary reference files:

- `vendor/lazygit/pkg/gui/context/filtered_list.go`
- `vendor/lazygit/pkg/gui/context/filtered_list_view_model.go`
- `vendor/lazygit/pkg/gui/controllers/helpers/search_helper.go`
- `vendor/lazygit/pkg/gocui/view.go`
- `vendor/lazygit/pkg/utils/search.go`
- `vendor/lazygit/pkg/integration/tests/filter_and_search/filter_files.go`
- `vendor/lazygit/pkg/integration/tests/commit/search.go`

## Architecture

### Public list primitive

`useListCursor` gains an optional query declaration:

```ts
useListCursor({
  items,
  idPrefix: "branches",
  noun: "branch",
  query: {
    mode: "filter",
    fields: (branch) => [branch.name, branch.upstream?.name ?? ""],
  },
});
```

The returned cursor exposes `items`, the projection that the Pane must render. In filter mode
it contains only matches; in search mode it is the original list. Keeping filtering and
cursor movement in one hook is load-bearing:

- filter clearing can translate the selected projected row back to its source index;
- every query edit can select row zero without a one-render stale selection;
- commit search can compare normal cursor movement with the current match before deciding
  whether `n`/`N` should return to it or advance;
- the scroll ref and row ids always describe the same projected list the cursor walks.

The query declaration is read live, like `items`; command identity remains stable through
`idPrefix`. The hook registers ordinary Pane Commands for `/`, clearing, and match movement,
plus capture Commands for Enter and Escape while the editor owns the keyboard.

### Core query surface

Core gains a small `ListQueryHost`, exposed to public hooks only through the private
`laziergit/host` runtime contract. A hook registers the current query state and input callback
for its Pane. The host selects the focused Pane's active registration and publishes it as an
external store.

The Status Line renders that store:

- while editing: `Filter: <input>` or `Search: <input>`;
- after filtering: `matches for '…' (x of y) · escape clear`;
- after searching: `matches for '…' (n of m) · n next · N previous · escape clear`.

The prompt replaces the Hint Bar but not right-aligned status segments. Core owns no list
data, matching, or git-specific behavior; it supplies a consistent shell surface in the same
way it supplies popup and status-line surfaces.

### Matching

Matching is a pure public-package helper exercised independently:

- filter mode joins the declared fields and requires every whitespace-separated term;
- each term uses lazygit smart-case semantics;
- filter results preserve source order;
- search mode tests the query as one smart-case substring and preserves the full source list.

Fields, rather than rendered text, make clipped values searchable and keep the generic
primitive independent of a Pane's JSX.

### Bundled Extensions

- Files: filter on full current and previous paths. A directory row contributes every path
  beneath it to its searchable fields, so a matching file retains each visible ancestor. The
  active filter survives tree/flat toggles.
- Branches: filter on branch name and upstream name.
- Commits: search on full/short object id, subject, and author identity. The list is never
  shortened; Enter, `n`, and `N` move the existing cursor.
- Stash: filter on stash message and branch.

Commands continue to consume `cursor.selected`, so filtering cannot make an action target a
hidden source row.

## Delivery plan

1. Add pure matching functions and unit tests to the public package.
2. Add the query host/runtime contract and Status Line editor/status rendering.
3. Extend `useListCursor`, including capture, filter-selection translation, search wrapping,
   and stable latest-state handling for paste-plus-Enter in one render tick.
4. Document the public API and default Commands.
5. Adopt filter mode in Files, Branches, and Stash; adopt search mode in Commits.
6. Add public-API integration coverage for live filtering, cancel/clear, selection retention,
   commit search, `n`/`N`, ordinary movement around a match, and no-match behavior.
7. Add Bundled Extension coverage for field choices and the Files tree/ancestor projection.
8. Run format, lint, typecheck, focused tests, the full unit suite, and the PTY end-to-end suite.

## Acceptance criteria

- `/` opens an editor only for the focused query-enabled Pane.
- Typing filters Files, Branches, and Stash immediately without firing ordinary Commands.
- Enter retains a filter; Escape while editing or afterward restores the full list and keeps
  the selected source item selected.
- A filter with no matches renders an honest empty state and no selected item.
- Commit search never removes rows. Enter selects a match after the current cursor, wrapping
  when needed; `n` and `N` cycle; `j` and `k` remain ordinary contextual movement.
- Query state reapplies when git publishes a new list and does not retain stale source indices.
- Query Commands are user-rebindable and discoverable from the existing command catalog.
- Third-party Extensions can opt in without importing Core or reimplementing an input mode.
