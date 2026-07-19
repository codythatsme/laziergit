# lazygit feature surface — research for laziergit

Researched 2026-07-17 against the lazygit repo at `master` (shallow-cloned to scratchpad and read directly), official docs in `docs/`, GitHub issues/PRs via `gh`, and the author's blog. Purpose: decide what belongs in laziergit's "light core" vs. its TypeScript extension API.

- Repo: https://github.com/jesseduffield/lazygit
- **License: MIT** (Copyright 2018 Jesse Duffield) — verified from `LICENSE` in the clone.
- Maintainership: **Jesse Duffield stepped back in 2025**; Stefan Haller (@stefanhaller) is the active maintainer. Source: issue #4655 "Stepping back as maintainer" — https://github.com/jesseduffield/lazygit/issues/4655
- Language/stack: Go; UI on a **vendored gocui fork now living in-tree at `pkg/gocui`**, rendering via `tcell/v3` (verified in `go.mod` and imports). No go-git/git2go in direct dependencies.

---

## 1. Pane/panel layout and navigation model

Verified from `pkg/config/user_config.go` (default `Gui.SidePanels`), `pkg/gui/context/setup.go` + per-context files (`WindowName` fields), `pkg/gui/gui.go` (`viewTabMap`), and `docs/dev/Codebase_Guide.md`.

### Default layout

Left column of 5 stacked **side windows**, right side is the **main** window (with an optional **secondary** split):

```go
// pkg/config/user_config.go — default value, and yes, this is user-configurable
SidePanels: []SidePanel{
    {"status"},
    {"files", "worktrees", "submodules"},
    {"branches", "remotes", "tags"},
    {"commits", "reflog"},
    {"stash"},
},
```

Each inner list is one window; entries ≥2 render as **tabs within the window**. So the default is:

| # | Window | Tabs (views) |
|---|--------|--------------|
| 1 | status | status |
| 2 | files | Files, Worktrees, Submodules |
| 3 | branches | Local Branches, Remotes (drill-in: Remote Branches), Tags |
| 4 | commits | Commits, Reflog |
| 5 | stash | Stash |

Additional windows/views (from `WindowName` assignments in `pkg/gui/context/*.go`):

- `main` + `secondary` — diff/preview area; secondary appears when e.g. a file has both staged and unstaged changes (`mainPanelSplitMode: flexible|horizontal|vertical`). Special main-window modes: **staging** (line/hunk staging), **patch building**, **merge conflicts** (each is its own context rendered into the main window).
- `extras` — the **command log** view (shows every git command lazygit runs; toggled with `@`).
- Popups: `menu`, `confirmation`, `prompt` (+ `suggestions`), `commitMessage` + `commitDescription`, `search`.
- Drill-ins reuse windows: pressing enter on a branch shows its commits (`subCommits` context) **in the branches window**; enter on a commit/stash shows `commitFiles` **in the commits window**. Contexts form a stack (`pkg/gui/context.go` "manages the lifecycle of contexts, the context stack, and focus changes").

Vocabulary from `docs/dev/Codebase_Guide.md` (useful for laziergit's domain model): **View** (gocui buffer) → **Context** (state + logic tied to a view; receives keypresses) → **Controller** (keybindings + handlers; many-to-many with contexts) → **Helper** (shared logic) → **Window** (screen region that hosts whichever view is on top). "Panel" is explicitly deprecated terminology in their codebase.

### Navigation (defaults verified in `pkg/config/user_config.go`)

- `1`–`5` jump to side windows (`jumpToBlock`), `0` focuses main view (`focusMainView`)
- `←`/`→` (and `h`/`l`) previous/next side window; `[` / `]` previous/next **tab** within a window
- `enter` drills into the selected item (pushes a context); `esc` pops back
- `+` / `_` cycle **screen modes**: `SCREEN_NORMAL` → `SCREEN_HALF` → `SCREEN_FULL` (`pkg/gui/types/common.go`)
- `expandFocusedSidePanel` config gives an accordion effect; `enlargedSideViewLocation` controls full-screen placement
- Mouse: clicks focus views, tab strips are clickable (`SetTabClickBinding` in `pkg/gui/keybindings.go`)
- `x`/`?` opens the per-context options menu (every binding is discoverable from a menu — a core UX invariant)

---

## 2. Categorized inventory of git operations

Source: `docs/keybindings/Keybindings_en.md` (generated cheatsheet, read in full) — https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md — plus `pkg/commands/git_commands/` file listing (one file per operation family: `bisect.go`, `blame.go`, `branch.go`, `cherry_pick (in rebase/patch)`, `custom.go`, `diff.go`, `flow.go`, `patch.go`, `rebase.go`, `reflog_commit_loader.go`, `remote.go`, `stash.go`, `submodule.go`, `sync.go`, `tag.go`, `working_tree.go`, `worktree.go`).

### Everyday (candidate "light core")

- **Status/files**: stage/unstage file (`space`), stage/unstage all (`a`), line/hunk staging in main window (`space`, range select `v`, hunk mode `a`), discard file changes (`d`), discard whole working tree ("nuke"), edit/open file, ignore/exclude file, refresh (`R`)
- **Commit**: commit (`c`), commit w/o pre-commit hooks (`w`), commit via git editor (`C`), amend last commit (`A`), commit message history reuse
- **Sync**: push (`P`), pull (`p`), fetch (`f`), force-push handling with confirmation
- **Branches**: checkout (`space`), checkout by name (`c`), previous branch (`-`), new branch (`n`), rename (`R`), delete (`d`), fast-forward (`f`), merge (`M`), rebase onto (`r`), set/unset upstream (`u`), force checkout (`F`)
- **Stash**: stash all (`s`) + stash menu (`S`: staged/unstaged/keep-index variants), apply/pop/drop, branch from stash, rename stash
- **Log browsing**: commits list w/ graph, view commit files, search/filter (`/`, `<ctrl+s>` filter view), copy commit attributes to clipboard (`y` menu: SHA, URL, message, author, diff)

### Intermediate

- **Interactive-rebase-as-UI** (the flagship): squash (`s`), fixup (`f`), reword (`r`/`R`), drop (`d`), edit/break (`e`), move commits up/down (`ctrl+j/k` style), explicit interactive rebase (`i`), mid-rebase todo editing (pick/drop/etc.), `B` mark a base commit for rebase, swallow conflicts flow with `M` merge-conflicts view (pick hunk, pick both, undo resolution)
- **Fixup workflow**: create fixup commit (`F`), `<ctrl+f>` find base commit for fixup (has its own design doc `docs/dev/Find_Base_Commit_For_Fixup_Design.md`), apply/squash all fixups (`S` autosquash)
- **Cherry-pick**: copy (`C`) / paste (`V`) commits across contexts, reset selection (`ctrl+r`)
- **Undo/redo via reflog**: `z` / `Z` (documented in `docs/Undoing.md`) — reconstructs inverse actions by walking the reflog
- **Tags**: create annotated/lightweight (`n`), delete local/remote (`d`), push tag (`P`), checkout detached
- **Remotes**: add/edit/remove remotes, fetch single remote, remote branches view (checkout, delete, set upstream)
- **Diffing**: diff two arbitrary refs (`W`/`ctrl+e` "diffing mode"), external difftool (`ctrl+t`), toggle whitespace, increase/decrease context, side-by-side via external pagers
- **Resets**: soft/mixed/hard reset menus (`g`) from commits/branches/tags contexts

### Advanced (candidate "extensions" in laziergit)

- **Custom patch editing** ("rebase magic"): toggle individual lines/hunks of an old commit into a patch (`space` in commit-files / patch-building view), then remove from commit, move to another commit, move to index, apply/reverse — `pkg/commands/patch/`
- **Bisect**: `b` in commits view (mark good/bad, skip, view options) — `git_commands/bisect.go`
- **Worktrees**: list/create/switch/remove — dedicated tab
- **Submodules**: list/init/update/sync-URL/remove — dedicated tab
- **Reflog**: full reflog tab, checkout/copy/reset from reflog entries
- **Filtering modes**: filter commits by path or author; "filtering mode" launched by CLI flag `-f` or in-app
- **Forge integration** (`pkg/commands/hosting_service/`): create/view pull request URLs (`o`), copy PR URL, works for GitHub/GitLab/Bitbucket/Azure DevOps URL schemes; GitHub CLI dependency `cli/go-gh` for PR status on branches
- **Git flow**: `flow.go` — only if `git-flow` binary installed
- **Commit signing**: delegated to git config (GPG/SSH); interactive password prompts handled via pty
- **Stacked branches**: `docs/Stacked_Branches.md` — rebases update dependent branches via `rebase.updateRefs`; maintainer explicitly prefers deepening this over integrating external stacking tools (see §6)
- **Bare repo / dotfiles support**: `--git-dir`/`--work-tree` flags (pain point issue #1294)

This inventory is a strong argument for the light-core thesis: the `git_commands` package has ~30 operation families, but the keybinding cheatsheet shows the everyday set (stage/commit/push/pull/branch/stash/log) is a small fraction of total surface. Everything in "Advanced" ships in-core in lazygit only because there is no extension mechanism.

---

## 3. Existing extensibility

### 3a. Custom commands (the whole story, config-based)

Docs: https://github.com/jesseduffield/lazygit/blob/master/docs/Custom_Command_Keybindings.md. Implementation: `pkg/gui/services/custom_commands/`. Config struct verified in `pkg/config/user_config.go`:

```go
type CustomCommand struct {
    Key         Keybinding            `yaml:"key"`
    CommandMenu []CustomCommand      `yaml:"commandMenu"` // nest commands under one key
    Context     string                `yaml:"context"`     // status|files|worktrees|localBranches|remotes|remoteBranches|tags|commits|reflogCommits|subCommits|commitFiles|stash|global (comma-separated allowed)
    Command     string                `yaml:"command"`     // Go template syntax
    Prompts     []CustomCommandPrompt `yaml:"prompts"`
    LoadingText string                `yaml:"loadingText"`
    Description string                `yaml:"description"`
    Output      string                `yaml:"output"`      // none|terminal|log|logWithPty|popup
    OutputTitle string                `yaml:"outputTitle"`
    After       *CustomCommandAfterHook `yaml:"after"`     // only: checkForConflicts bool
}
```

**Prompt types** (`type CustomCommandPrompt`): `input` (with `initialValue`, `suggestions` — preset: `authors|branches|files|refs|remotes|remoteBranches|tags` or a shell `command`), `confirm` (title/body), `menu` (static options with name/description/value/key), `menuFromCommand` (options parsed from command output via named-group regex `filter` + `valueFormat`/`labelFormat` templates). All prompts support a `condition` Go-template expression referencing earlier form values (`{{ eq .Form.Method "prefix" }}`).

**Template session state** — lazygit deliberately maintains *shim* structs decoupled from internal models, i.e. an embryonic stable plugin API. From `pkg/gui/services/custom_commands/models.go`:

```go
// We create shims for all the model classes in order to get a more stable API
// for custom commands. ... this allows us to add "private" fields to the model
// classes that we don't want to expose to custom commands, or rename a model
// field to a better name without breaking people's custom commands.
```

From `session_state_loader.go`:

```go
type SessionState struct {
    SelectedCommit        *Commit
    SelectedCommitRange   *CommitRange // only .From/.To — full range contents NOT exposed
    SelectedFile          *File
    SelectedSubmodule     *Submodule
    SelectedPath          string
    SelectedLocalBranch   *Branch
    SelectedRemoteBranch  *RemoteBranch
    SelectedRemote        *Remote
    SelectedTag           *Tag
    SelectedStashEntry    *StashEntry
    SelectedCommitFile    *CommitFile
    SelectedCommitFilePath string
    SelectedWorktree      *Worktree
    CheckedOutBranch      *Branch
    // + deprecated SelectedLocalCommit / SelectedReflogCommit / SelectedSubCommit
}
```

Exposed model shapes (excerpt): `Commit{Hash, Sha(dep.), Name, Status, Action, Tags, ExtraInfo, AuthorName, AuthorEmail, UnixTimestamp, Divergence, Parents}`, `File{Name, PreviousName, HasStagedChanges, HasUnstagedChanges, Tracked, Added, Deleted, HasMergeConflicts, HasInlineMergeConflicts, DisplayString, ShortStatus, IsWorktree}`, `Branch{Name, DisplayName, AheadForPull/BehindForPull, AheadForPush/BehindForPush, UpstreamGone, Head, DetachedHead, UpstreamRemote, UpstreamBranch, Subject, CommitHash, ...}`.

Template helpers: `quote` (platform-safe shell quoting), `runCommand` (inline command substitution in prompt fields). `os.shellFunctionsFile` config sources a user shell file before custom commands and the `:` shell prompt.

**Output modes**: `none`, `terminal` (suspends the whole TUI and hands the terminal to the command — the only path to interactivity), `log`, `logWithPty` (preserves color), `popup`.

**What custom commands can NOT do** (by construction — verified against the model/service code):

- Cannot add panels, tabs, views, or list items; cannot render anything except a text popup / log stream
- Cannot subscribe to events (no hooks on commit/push/refresh/selection-change; only `after.checkForConflicts`)
- Cannot read command output back into lazygit state (except via `menuFromCommand` at prompt time)
- Cannot access all items of a multi-select range (docs say: "We don't support accessing all elements of a range selection yet") or line-level selection info (open issue #4677)
- No long-running/background processes, no async progress UI beyond `loadingText`
- No logic beyond Go template conditionals; no packages/distribution story — users copy YAML from a wiki page ("Custom Commands Compendium": https://github.com/jesseduffield/lazygit/wiki/Custom-Commands-Compendium)

The Compendium shows what the community actually builds: branch pruning, conventional commits/gitmoji prompts, PR checkout by ID, opening PRs in browser, tig/mergetool/commitizen integration, "disentangle branch", diff archaeology helpers. All of it is "prompt → shell out → refresh".

### 3b. Custom pagers

`docs/Custom_Pagers.md` — `git.pagers` array, cycle at runtime with `|`. Each entry is one of: `pager:` (post-processes git diff output — delta, diff-so-fancy, ydiff), `externalDiffCommand:` (replaces git diff entirely — difftastic), `useExternalDiffGitConfig: true`, or `{}` (builtin). `colorArg: always|never`. Noted limitation: "delta's `--navigate` option doesn't work in lazygit, for technical reasons."

### 3c. Keybindings

Fully remappable YAML per context (`keybinding.universal`, `.files`, `.commits`, ...); `<disabled>` sentinel; multiple keys per action; platform default modifier via `LAZYGIT_KEYBINDING_PLATFORM`. Custom-command keys **override built-ins in the same context**, but built-in context keys beat *global* custom commands. Cheatsheets are generated from code (`pkg/cheatsheet`).

### 3d. Community pain points about limited extensibility (primary sources)

- **Issue #4681 "External plugin support" (OPEN)** — https://github.com/jesseduffield/lazygit/issues/4681 — AWS engineer wants new windows/integration with internal tooling; discussion drifts to "Outlook add-in"-style mini apps with "access to some internal API to trigger actions" and "can react to things happening (events)". No maintainer commitment.
- **PR #5219 (git-spice Stacks pane, OPEN)** — https://github.com/jesseduffield/lazygit/pull/5219 — author writes verbatim: *"I looked for a plugin system to contribute this without touching the main codebase, but couldn't find one: so here I am with a PR instead."* Maintainer (stefanhaller) response: not excited, prefers improving native `rebase.updateRefs` stacked-branch support; PR parked.
- A long tail of enhancement issues that exist only because custom commands hit walls: #1844 "Better context variables for custom commands", #4677 "Expose line number information to custom command templates", #3476 "multiline prompt support", #4047 "Run custom commands in interactive shell", #1391 "git completion via Tab in custom command", #2240 "Track renamed files in custom commands", #5808 "Enable templating in runCommand", #2579 "[Proposal] Automate Commit Messages with OpenAI", #1307 "Support for gitmoji", #4414 conventional-commit prompts, #5214 "extend lazygit to support other SCMs like mercurial".
- Ecosystem formed *around* the binary instead: `awesome-lazygit` list (https://github.com/codevogel/awesome-lazygit, seeded by maintainer request in issue #5001), lazygit.nvim, IDE wrappers, Catppuccin themes — all integration happens by embedding or shelling into lazygit, never inside it.

---

## 4. How lazygit talks to git

**It shells out to the `git` binary for essentially everything.** Verified:

- `docs/dev/Codebase_Guide.md`: "`pkg/commands/git_commands`: All communication to the git binary happens here. So for example there's a `Checkout` method which calls `git checkout`."
- `pkg/commands/oscommands/cmd_obj_builder.go` builds `exec.Command(args[0], args[1:]...)`; `pkg/commands/git_commands/git_command_builder.go` provides a fluent `NewGitCmd("for-each-ref").Arg(...).ToArgv()` argv builder (no shell-string concatenation for internal commands).
- No go-git/git2go in the direct dependency list (`go.mod`). A handful of hot paths read `.git` files directly (e.g. `.git/HEAD` in `status.go`, with an explicit fallback for the reftable backend which writes a stub `ref: refs/heads/.invalid`).
- **Lock-retry layer**: `pkg/commands/git_cmd_obj_runner.go` wraps every git command with retries on transient `index.lock` / `cannot lock ref` errors — 20ms initial delay, doubling, max 7 retries (~1s total). Any rewrite driving concurrent git processes needs an equivalent.
- **Interactive rebase trick**: lazygit re-invokes *itself* as a short-lived process passed to git as `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` (`pkg/app/daemon`; misleadingly named, per their own docs). The "daemon" receives instructions (ChangeTodoActions, MoveTodosUp/Down, InsertBreak — see `rebase.go`) and rewrites the rebase todo file; todo parsing via `stefanhaller/git-todo-parser`. Plain `pull --rebase` sets `GIT_SEQUENCE_EDITOR=:` to skip the editor.
- **Credential prompts**: commands that may ask for credentials run through a pty with prompt detection (`PromptOnCredentialRequest` in `sync.go`), surfacing username/password/passphrase dialogs in the TUI.

**Status updates are pure polling — there is no fsnotify/file-watching.** Verified: `fsnotify` appears in `go.mod` only as an *indirect* dependency and is imported nowhere under `pkg/`. From `pkg/gui/background.go` (BackgroundRoutineMgr) and `pkg/config/user_config.go` defaults:

- `git.autoRefresh` → refresh FILES scope every `refresher.refreshInterval` (default **10s**)
- `git.autoFetch` → background fetch every `refresher.fetchInterval` (default **60s**), immediate fetch on startup/repo switch via a buffered trigger channel
- `git.autoDetectExternalChanges` → every `refresher.externalChangeCheckInterval` (default **2s**) compare a **refs snapshot**: `git for-each-ref --format='%(objectname) %(refname)' refs/heads` output + a direct read of `.git/HEAD` (`StatusCommands.RefsSnapshot` in `status.go`); refresh only if the fingerprint changed
- Plus the dominant mechanism: **refresh-after-action** — every handler ends by asking `refresh_helper.go` to reload the affected model scopes; background routines are paused (counted pause scopes) while a subprocess owns the terminal or lazygit itself runs git

---

## 5. Config file format and theming

- **YAML**, single `config.yml` (XDG paths; `~/Library/Application Support/lazygit/config.yml` on macOS), plus **repo-local** `.git/lazygit.yml` and `.lazygit.yml` discovered in parent directories. A **JSON schema is generated from the Go structs** (`pkg/jsonschema`, using `karimkhaleel/jsonschema`) — config docs are also generated from struct comments. Config **hot-reloads** while running (`Gui.onUserConfigLoaded`; options that can't hot-apply are listed in `checkForChangedConfigsThatDontAutoReload` and prompt a restart).
- **Theming** (`gui.theme` + friends): ANSI names or hex for active/inactive/searching borders, selected-line bg, option text, unstaged-changes color, etc.; `authorColors` (name → color, `*` wildcard), `branchColorPatterns` (regex → color), `customIcons.filenames/extensions` (icon + color), `nerdFontsVersion: "2"|"3"`. Community themes (Catppuccin et al.) are just YAML fragments — there is no theme *package* concept.
- Editor integration: `os.editPreset` (vim/nvim/nvim-remote/emacs/nano/vscode/sublime/helix/zed/...) or raw templates `edit`, `editAtLine`, `editAtLineAndWait`, `openDirInEditor`, `editInTerminal`.
- Docs: https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md

---

## 6. On the author's stance toward plugins

**No explicit documented refusal was found** (see §7). What is documented:

- README positions custom commands as the answer: *"If lazygit is missing a feature, there's a good chance you can implement it yourself with a custom command!"*
- Jesse's 5-year retrospective (https://jesseduffield.com/Lazygit-5-Years-On/) discusses custom commands approvingly ("a pretty cool custom commands system that lets you invoke that bespoke git command from the UI; making use of the selection state") and describes an ethos shift: *"over time, lazygit's ethos has changed to be less about compensating for git's shortcomings via magic and more making it easier to do the things that you can naturally do in git, which means there are fewer surprises."* Plugins are not mentioned at all. Future priorities listed: bulk actions, repo actions, forge integration, better diffs — all in-core.
- The models.go shim comment (§3a) shows the team *thinks* about API stability for external consumers, but only at the granularity of template variables.
- Current maintainer behavior (PR #5219, issue #4681) suggests scope-conservatism rather than a philosophical manifesto: integrations for specific external tools are declined/parked, and nobody has committed to a plugin architecture. Notably #5214 (mercurial support) and #4681 remain open without a "no", suggesting "not planned by anyone with time" rather than "rejected on principle" — consistent with a project whose founder left and whose maintainer optimizes for polish of the git-native core.

---

## 7. Uncertain / could not verify

- **Why no plugin system**: I found no issue, discussion, blog post, or doc where Jesse Duffield or Stefan Haller states a reasoned position against plugins. The claim "the author resisted a plugin system" is *unverified*; the observable record is absence-of-investment plus custom commands as the sanctioned escape hatch. (Searched: GitHub issues/discussions via `gh search` and GraphQL for plugin/extension/scripting/lua, web search for author comments on Reddit/HN, the 5-years blog post.)
- Whether the `main`/`secondary` window internals (tasks-based incremental rendering in `pkg/tasks`) impose constraints relevant to plugin-rendered content — did not read `pkg/tasks` in depth.
- Exact behavior of `git.fetchAll` vs per-remote fetch defaults and how the GitHub PR-status polling (`cli/go-gh`) is scheduled — saw the dependency and issue #5516 complaining it can't be disabled, but did not trace the code path.
- The full popup/keybinding-precedence rules beyond what `Custom_Command_Keybindings.md` states.
- Whether the WebFetch-summarized keybinding inventory in §2 is byte-complete; it was generated by summarizing the (very long) `Keybindings_en.md`. Spot-checked bisect (`b`, commits panel), difftool (`ctrl+t`), undo/redo (`z`/`Z`) against the local clone — all confirmed — but treat per-key details as ~95% rather than 100%.
- Star/adoption numbers, and whether PR #5219 or issue #4681 have moved since 2026-07-17.

## Source list

- https://github.com/jesseduffield/lazygit (MIT; source read from local shallow clone of `master`)
- `LICENSE`, `go.mod`, `docs/dev/Codebase_Guide.md`, `docs/Config.md`, `docs/Custom_Command_Keybindings.md`, `docs/Custom_Pagers.md`, `docs/keybindings/Keybindings_en.md`, `docs/Undoing.md`, `docs/Stacked_Branches.md`
- `pkg/config/user_config.go`, `pkg/gui/background.go`, `pkg/gui/gui.go`, `pkg/gui/context/*.go`, `pkg/gui/services/custom_commands/{models,session_state_loader}.go`, `pkg/commands/git_cmd_obj_runner.go`, `pkg/commands/oscommands/cmd_obj_builder.go`, `pkg/commands/git_commands/{status,rebase,sync}.go`, `pkg/app/daemon`
- https://github.com/jesseduffield/lazygit/issues/4681 · https://github.com/jesseduffield/lazygit/pull/5219 · https://github.com/jesseduffield/lazygit/issues/4655 · https://github.com/jesseduffield/lazygit/issues/5001
- https://github.com/jesseduffield/lazygit/wiki/Custom-Commands-Compendium · https://github.com/codevogel/awesome-lazygit
- https://jesseduffield.com/Lazygit-5-Years-On/
