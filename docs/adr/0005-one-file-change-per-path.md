# ADR-0005 — One `FileChange` per path, carrying both sides of the index

**Status**: accepted (M5)

## Context

`git status --porcelain=v2` describes a path with two independent letters. `X` is HEAD→index
and `Y` is index→working tree, and they answer different questions: a file can be `MM`,
modified in the index and modified again since.

The model split them. `parseStatus` emitted up to two `FileChange` values for one path — one
into `status.staged`, one into `status.unstaged` — each carrying a single `kind`, and the
`XY` pair itself was discarded. The unmerged pair was discarded outright, with a comment
saying so: "the model has one conflicted kind, so the detail is deliberately dropped here".

That worked only because the files Pane drew four group headings. The heading a row sat under
was the *only* surviving record of which side of the index the row described, and the Pane
read it as data:

- `space` staged or unstaged by testing `row.group === "staged"`.
- The diff push chose `staged` versus `workingTree` the same way.
- `sectionsOf` kept a `Map` interning change objects, because the two rows an `MM` path
  produced had to hand `useDecoration` one identical object or its cache would thrash.
- `discardPlan` took the whole `WorkingTreeStatus` as a second argument and searched
  `status.staged` for a path it might also be in — because the row it was handed could not
  say.

Every one of those is the same missing fact, worked around four times. And the workaround was
load-bearing on a presentation choice: the moment the Pane became a folder tree, there were no
headings left to read.

The counts were wrong too, quietly. `status.staged.length + status.unstaged.length` counted an
`MM` file twice, so the reset-loss warning in `extensions/commits` and the stash preflight in
`extensions/stash` both overstated what was at stake.

## Decision

**One entry per path, carrying both of git's columns.**

`FileChange` becomes a two-arm union. The `"changed"` arm holds `index: ChangeKind | null`
and `worktree: WorktreeChange | null`; the `"conflicted"` arm holds `ours` and `theirs` as
`ConflictSide`. `WorkingTreeStatus` becomes one `files` list, ordered by path.

A union rather than four optional fields, because the fields are not independent: an unmerged
path has no index-versus-working-tree pair at all, and `{ index: "modified", ours: "added" }`
was representable in a flat shape while meaning nothing.

The four questions the four arrays answered become four exported predicates — `isStaged`,
`isUnstaged`, `isUntracked`, `isConflicted`.

The conflict-side pair lands here rather than waiting for the conflicts UI, which is what
§5.12 previously assumed. The two-column render *is* the consumer: without the pair a
conflicted row can only print an invented glyph, discarding which side did what on precisely
the rows where that is the entire question.

## Consequences

- The files Pane draws two status columns per row and needs no headings, which is what makes
  the folder tree possible at all.
- `discardPlan` loses its `status` argument and its search, and shrinks to six lines.
- `changeKey` collapses to `change.path`. A decoration slot follows the path, so staging a
  file no longer evicts a decoration its provider would recompute to the same answer.
- Store identity improves. Staging used to move a fresh object between two arrays, changing
  both lengths and shifting every row after it; now the entry keeps its slot in path order
  with one field rewritten and its neighbours stay `Object.is`-identical.
- Rows are in **path order**, not group order. An untracked file no longer sorts last simply
  for being untracked.
- `useGit((state) => state.status.staged)` becomes a filter, and a filter in a selector builds
  a fresh array on every snapshot. The rule — select the slice, derive in a `useMemo` — is on
  `status.ts`, in §1.5, and demonstrated at `extensions/commit-flow/index.tsx`.
- A directory row is not a `FileChange`. `FilesApi.selected()` answers `undefined` on one, a
  `decorateRows` provider is never handed a folder, and the folder menu is ad-hoc rather than
  spliceable. That gap is recorded in §5.12; the fix, when something needs it, is a row-type
  union in the public API, and it belongs with its first consumer.

## Alternatives rejected

**Accessor properties on `WorkingTreeStatus`** — keep `status.staged` as a getter over
`files`. Rejected: they are own enumerable properties, so the structural comparison in
`state.ts` would traverse four derived arrays on every poll, and each read would return a
fresh array — destroying the `Object.is` stability the store exists to provide and evicting
every decoration slot on every tick.

**Merge inside the extension** — leave the public model alone and reconcile the duplicate rows
in `extensions/files`. Rejected: it leaves the gap open for every third party while the tree
is exactly the consumer that was supposed to close it, and the wrong counts in `commits` and
`stash` would have stayed wrong.

**Defer the conflict pair** — ship `!!` on conflicted rows and revisit with the conflicts UI.
Rejected: the model was being rewritten in the same change either way, and adding a field to a
shipped public union later is the expensive version of this decision, not the cheap one.
