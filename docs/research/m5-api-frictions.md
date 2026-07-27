# The M5 API friction study

Six Extensions, written against nothing but `docs/extension-api.md`, `docs/config.md`,
`CONTEXT.md` and the published `laziergit` types — no access to `packages/core`, no access to
`extensions/`, which is exactly what a third-party author has. Each was authored in a copy of
the authoring environment laziergit publishes into a user's config directory, and each had to
typecheck there.

| Extension | Seams it exercised |
|---|---|
| `ci-status` | status line segment, `ctx.exec`, an interval the Extension owns, `ctx.onDispose` |
| `github-prs` | `needs` → typed `extensions.get`, Row Decorations, menu Splice, an exported API |
| `conventional-commit` | popup select/prompt flow, cancellation, hand-off to `commit-flow` |
| `stash-preview` | a second Pane, `tabWith`, `git.raw` in a component, `useListCursor`, empty states |
| `branch-janitor` | every `option.*` kind, `EventMap` augmentation, `ctx.effect`, porcelain writes |
| `blame` | consuming `FilesApi`'s selection, `useKeyCapture`, `ctx.copy`, an input inside a Pane |

**All six typechecked on the first `tsc` run**, with no casts and no manual generics at any use
site. Every probe independently confirmed the compile-time guarantees the spec advertises —
a mis-prefixed `ScopedId`, emitting a core event, `extensions.get` on an undeclared `needs`,
an unknown config key, an enum default outside its `values` — are all real errors. The spine
of the API is sound; what follows is everything that was not.

Each finding below was then handed to a separate agent instructed to **refute** it, with full
access to the source and permitted to reject anything already documented as deliberately
absent (§5.11) or as a known post-v1 limit (§5.12, PLAN.md). 48 survived; 17 did not.

Fixed in M5: the `ctx.effect` authoring gap, §4.4's multi-file `<diff>` and its uncancelled
`setState`, §2's wrapping rows and missing cursor marker, `remoteWebUrl`'s absence from both
documents (and §0's example teaching the anti-pattern it replaces), and config.md's refresh
poll contradicting §5.12. The rest are recorded here rather than in a report nobody reads —
several are genuine API additions that want a real consumer before they get a signature, which
is the same bar §5.11 sets for everything else it defers.

| Severity | Kind | Where | Finding |
|---|---|---|---|
| blocker | missing-capability | §1.11 `RowSource` / `FilesApi` / `RowSourceHost.setSelected` | RowSource publishes a selection but no way to hear it change |
| blocker | undocumented | §1.8 `useKeyCapture`, §5.8 "A pane that owns the keyboard",  | Nothing says how keys reach a Pane's own `<input>` during a key capture |
| blocker | missing-capability | §1.12 EffectEscape / GitService.changes / EventsService.stre | ctx.effect is unusable beyond "hand a host-made Effect straight back" — the authoring environment resolves no `effect` package |
| blocker | spec-wrong | §4.4 (stash-preview example) vs §5.11 bullet "A multi-file d | §4.4's stash-preview renders a multi-file patch into one <diff>, which §5.11 says shows only the first file |
| friction | spec-wrong | §4.4 stash-preview, §2 gh-workflows `refresh`, §5.3 "The asy | Both worked examples teach uncancelled async setState in a Pane |
| friction | unsafe-type | §1.7 `CommandSpec.capture` / `CommandSpec.pane` (types.ts `C | `capture: true` typechecks on a Command with no `pane` |
| friction | spec-wrong | §0 ("Pure helpers" table and the open-remote example) vs. `p | `remoteWebUrl` is exported but undocumented, and §0's flagship example hand-rolls a buggier version of it |
| friction | spec-wrong | docs/config.md "`git` — how the repository is watched" vs ex | config.md's account of the refresh poll contradicts extension-api.md §5.12 (two reads vs four) |
| friction | undocumented | packages/laziergit/src/index.ts export vs §0 "the entire sur | `remoteWebUrl` is public API but appears in neither doc, and §0's flagship example teaches the anti-pattern it exists to replace |
| friction | missing-capability | §1.10 PopupToolkit.select / confirm | No multi-select popup — "pick which of these 9 branches to delete" is not expressible |
| friction | inference-failure | §1.10 `select<T>(opts: { items: readonly SelectItem<T>[] })` | `popups.select` inference collapses on a mixed `items` array and forces a manual type argument |
| friction | unsafe-type | §1.1 `export type KeySpec = string` | `KeySpec = string` admits spellings the spec itself documents as silently dead |
| friction | unsafe-type | §1.5 `Git.raw` (the mutating-argv classification rules) | `git.raw()`'s read/write classification is invisible to the types, and the natural spelling of my query is the misclassified one |
| friction | missing-capability | §1.5 GitState / Branch / Remote | Nothing in `GitState` names the default branch, and there are no remote-tracking refs at all |
| friction | undocumented | §1.12 `EffectEscape.runPromise: <A, E>(effect: Effect.Effect | `runPromise`'s rejection channel is undocumented — whether a `GitError` survives it is a guess |
| friction | missing-capability | §1.11 RowDecoration / RowSource.decorateRows | Two extensions decorating the same rows silently clobber each other's badge |
| friction | missing-capability | §1.9 MenuRegistry.extend / MenuGroup.id | A menu splice cannot inspect the menu it is splicing into, and wins key conflicts against the owner |
| friction | unsafe-type | §1.9 MenuItem<Target> — `when?(target): boolean` and `run(ta | `MenuItem.when` cannot narrow the target for `run`, so every guarded item repeats its own lookup |
| friction | unsafe-type | §1.1 KeySpec | `KeySpec` is an unchecked `string`, and the set of named keys is never enumerated |
| friction | spec-wrong | packages/laziergit/src/index.ts (exported) vs docs/extension | `remoteWebUrl` is published in the types but appears nowhere in the spec — and §0's example hand-rolls it, bug included |
| friction | undocumented | §5.4 ("third-party extensions add one `declare module` augme | An exported API's type is invisible to consumers in a different extensions directory |
| friction | missing-capability | §1.11 RowSource (decorateRows + selected only) | No way to follow another pane's selection — `RowSource.selected()` is pull-only |
| friction | inference-failure | §1.10 `PopupToolkit.select` / `SelectItem<T>` | `popups.select<T>` cannot infer a discriminated union from its item list |
| friction | unsafe-type | §1.7 `CommandSpec.pane` | `CommandSpec.pane` is an unvalidated `string`, so a wrong pane id makes the whole Command unreachable, silently |
| friction | missing-capability | §1.10 `PopupToolkit.confirm` — "Yes/no. Resolves false on es | `popups.confirm` cannot report cancellation, so it is unusable as a step in a cancellable flow |
| friction | missing-capability | §1.10 `PopupToolkit.select` vs `PopupToolkit.prompt` (`initi | `popups.select` has no way to preselect a row, so "remember the last choice" and "go back a step" are both unbuildable |
| friction | spec-wrong | §4.4 (stash-preview example) | §4.4 puts its <diff> outside any <scrollbox>, so the patch cannot scroll and overflows the Pane |
| friction | unsafe-type | §1.8 `useCommand`, `ListCursorOptions.idPrefix` | `useCommand` and `useListCursor` accept any string id, including reserved core namespaces — and the spec never says what the runtime check does when it fails |
| friction | undocumented | §1.8 `PlacementHint.tabWith`, `PaneSpec.component`, `PanePro | Whether a non-visible tab in a `tabWith` group is mounted is unspecified — and it decides how the Pane must be written |
| friction | ceremony | §1.8 `ScrollView.ref`, `ListCursor.scrollRef`, the intrinsic | Ceremony: `focusable={false} flexGrow={1} flexBasis={0}` is copy-pasted onto every scrollbox, and both omissions fail silently |
| friction | unsafe-type | §1.5 `Git.stash` | `ctx.git.stash.apply/pop/drop` are keyed by positional index only, so a stale index acts on the wrong stash |
| friction | undocumented | §1.3 `ExtensionContext.onDispose`, §5.3 (deactivation order) | `ctx.onDispose` finalizers run against an already-poisoned ctx, and nothing says so |
| friction | spec-wrong | §5.3 ("the async tail"), §1.1 `StaleContextError`, §1.3 `Ext | §5.3 claims `setInterval` + `onDispose(clearInterval)` is "safe exactly as written", but the same section's ordering opens a window where it is not |
| friction | missing-capability | §1.3 `ExtensionContext.exec` / `ExecOptions` / `ExecOutput` | `ctx.exec` rejections are untyped: "program not installed" and "timed out" are indistinguishable |
| friction | undocumented | §1.5 `Git.subscribe` | `Git.subscribe` does not say whether it replays on subscription, and guessing wrong is silent |
| friction | undocumented | `packages/laziergit/src/index.ts` (export) / `remote.ts` | `remoteWebUrl` is exported public API that the specification never mentions |
| polish | inference-failure | §1.6 `EventBus.emit`, §5.1 ("a wrong prefix is a compile err | Emitting an event you don't own fails with an arity error, not a naming error |
| polish | unsafe-type | §1.7 `CommandSpec.pane`, `CommandRegistry.execute` | Ids that cross extension boundaries are all bare `string` |
| polish | undocumented | §1.8 `PaneHandle.reveal` / "no live instance", §5.3 | Whether a tab-hidden Pane stays mounted is never stated |
| polish | ceremony | §1.2 `ExtensionApiOf` / §5.4 | Publishing an exported API is six lines of identical boilerplate whose only variable is the name already in the spec |
| polish | unsafe-type | §1.1 Disposable | laziergit's `Disposable` collides with the ESNext lib global of the same name |
| polish | unsafe-type | §1.10 `PopupToolkit.select` — `Promise<T \| undefined>` | `select<T>` admits `undefined` in `T`, making a chosen item indistinguishable from cancellation |
| polish | ceremony | §1.11 `ExtensionHub.get` | Forgetting `needs` produces two errors, neither of which mentions `needs` |
| polish | unsafe-type | §1.1 `KeySpec` | `KeySpec = string` accepts `"enter"`, the one spelling the spec says binds cleanly and never fires |
| polish | undocumented | §1.8 `PlacementHint` | `PlacementHint` gives no precedence rule between `tabWith` and `column`/`order`, nor a fallback when `tabWith` names a Pane that is not placed |
| polish | missing-capability | §1.3 `ExtensionContext.config` / §1.4 `ConfigValues` | An extension cannot read another extension's config, so a Pane tab-grouped with `diff` cannot match the user's `diff.view` |
| polish | undocumented | §1.8 `useScrollView` / `ScrollView` | `useScrollView` says nothing about what happens when the scrollbox's content is replaced |
| polish | inference-failure | §1.6 `EventBus.emit` / `EventPayload`, §5.1 | Emitting a core event reports an arity error pointing at the payload, not the event name |