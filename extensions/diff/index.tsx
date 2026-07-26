/** @jsxImportSource @opentui/react */
import {
  createCell,
  defineExtension,
  literalPathspec,
  option,
  useCommand,
  useEvent,
  useGit,
  useScrollView,
  useTheme,
  type DiffApi,
  type DiffTarget,
  type GitState,
} from "laziergit"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"

/** The `<diff>` layouts, as one list so the config enum and the `v` toggle cannot drift apart. */
const views = ["unified", "split"] as const
type DiffView = (typeof views)[number]

/** One file's self-contained section of a patch — see {@link splitPatch}. */
interface FilePatch {
  /** The file the section is about, or `null` when git wrote a shape with no `+++`/`---` pair. */
  readonly path: string | null
  readonly patch: string
  /** False where git emitted a section with no hunk at all: a binary file, a pure mode or rename change. */
  readonly hasHunks: boolean
}

/** A patch as this Pane reads it: git's own preamble, if it printed one, and the files. */
interface ParsedPatch {
  /**
   * Everything git wrote before the first file section — the `commit`/`Author`/`Date` block
   * and the whole message, indented. `null` where we asked for a bare patch.
   */
  readonly header: string | null
  readonly files: readonly FilePatch[]
}

/**
 * What the Pane is showing, as the four states it can actually be in.
 *
 * `ready` carries the split patch and `failed` carries git's own words, so there is no way to
 * render a stale patch beside a fresh error, or an error with nothing to say. `ready` with an
 * empty `files` is the "nothing in this target" case, so there is no second encoding of it.
 */
type DiffState =
  /** No target at all — the Extensions that call `show` have not selected anything yet. */
  | { readonly kind: "empty" }
  | { readonly kind: "loading" }
  | ({ readonly kind: "ready" } & ParsedPatch)
  | { readonly kind: "failed"; readonly message: string }

/**
 * Identity of a target, independent of the object carrying it.
 *
 * Every list Pane builds a fresh `DiffTarget` object each time its cursor moves or the
 * store refreshes, so keying the fetch effect on object identity would re-run git on every
 * refresh of an unchanged selection. Joined on NUL, which no git ref or path can contain —
 * a space separator would let `ref: "a b"` and `path: null` collide with `ref: "a"` and
 * `path: "b"`.
 */
function targetKey(target: DiffTarget | null): string {
  return target === null ? "" : [target.kind, "ref" in target ? target.ref : "", target.path ?? ""].join("\0")
}

/**
 * A git invocation, and how to read the exit status it comes back with.
 *
 * The flag is only ever true for `git diff --no-index`, which exits 1 to mean "the two files
 * differ" — the ordinary answer for the case it is used for below — and, unhelpfully, also
 * exits 1 when it cannot read one of them. The exit code alone cannot tell those apart, so
 * the presence of a patch has to.
 */
interface DiffFetch {
  readonly argv: readonly string[]
  readonly nonZeroExitMayCarryPatch: boolean
  /** Whether git was asked to print its own commit header before the patch. */
  readonly headed: boolean
}

/**
 * The git invocation for a target.
 *
 * Every shape here is read-only as far as `ctx.git.raw` is concerned — `diff` and `show` are
 * on the service's read-only subcommand list outright, and `stash show` is on its read-only
 * *pair* list. That is load-bearing rather than incidental: a fetch that counted as a
 * mutation would refresh the store, the refresh would re-run this fetch, and the Pane would
 * spin forever.
 *
 * `untracked` is the store's untracked set, which the `workingTree` case has to consult:
 * callers name a file, not how git happens to know about it, and the Panes that call `show`
 * must not have to encode git's rules to get a diff back.
 */
function fetchFor(target: DiffTarget, context: number, untracked: ReadonlySet<string>): DiffFetch {
  // `-U`, plus the one patch-shaping pin the core cannot make on every invocation for us:
  // `GIT_EXTERNAL_DIFF` in the environment beats `-c diff.external=`, so only `--no-ext-diff`
  // disarms a user's own differ — and it is a diff option that `status`, `add` and `commit`
  // reject, so it cannot join the flags every git invocation carries. Without it a custom
  // differ's output has no `@@` in it, and every changed file reads as "no textual diff".
  const patchFlags = ["--no-ext-diff", `-U${context}`]
  // No pathspec means the whole of that side, which is what a Pane whose selection is not
  // one file should show — not an empty diff. `literalPathspec` because every path git takes
  // is a *pattern*: unwrapped, a file called `foo[1].txt` diffs `foo1.txt` as well (§1.5).
  const pathspec = target.path === null ? [] : ["--", literalPathspec(target.path)]
  /**
   * The same pathspec for an argv that must write its own `--`.
   *
   * Anything naming a *revision* has to end its revision list explicitly, because git
   * resolves a bare name as either — `git show docs` in a repository with both a `docs`
   * branch and a `docs/` directory exits 128 with "ambiguous argument". That was
   * unreachable while every ref here was a 40-hex oid and became reachable the moment the
   * branches Pane started naming its selection, which is the whole point of the `branch`
   * kind. So the terminator goes in unconditionally rather than riding on `path`.
   */
  const pathTail = target.path === null ? [] : [literalPathspec(target.path)]
  switch (target.kind) {
    case "workingTree":
      // An untracked file has nothing in the index to diff against, so plain `git diff`
      // prints *nothing* for it — on this repository's own boot that was 36 rows of blank
      // Pane. `--no-index` diffs two paths on disk instead, and `/dev/null` on the left
      // turns "show me this file" into "the whole file, added", which is what lazygit shows
      // and what the row promises. Reserved for the untracked set: a *tracked* path put
      // through `--no-index` would show the entire file as added rather than its change
      // against the index. The path goes in raw — `--no-index` operates outside the index and
      // takes filesystem paths, not pathspecs, so `:(literal)` would be read as a filename git
      // could not access — and a nonzero exit may still carry the patch, because `--no-index`
      // exits 1 to mean the two files differ, which is the ordinary case here.
      if (target.path !== null && untracked.has(target.path)) {
        return {
          argv: ["diff", "--no-index", ...patchFlags, "--", "/dev/null", target.path],
          nonZeroExitMayCarryPatch: true,
          headed: false,
        }
      }
      return { argv: ["diff", ...patchFlags, ...pathspec], nonZeroExitMayCarryPatch: false, headed: false }
    case "staged":
      return { argv: ["diff", "--cached", ...patchFlags, ...pathspec], nonZeroExitMayCarryPatch: false, headed: false }
    case "commit":
    case "branch":
      // A branch is a ref like any other, so both kinds fetch the same way; they differ only
      // in the line the Pane writes above the result.
      //
      // `--pretty=medium` instead of the `--format=` that used to strip the header: the
      // header is the *point* of this Pane now that a list row is clipped to one line, so
      // the full subject and body have to be somewhere. `splitPatch` lifts it off the front
      // rather than handing it to `<diff>`, whose parser still wants a bare patch.
      //
      // Pinned rather than defaulted, for two reasons that are really one: `format.pretty`
      // in the user's config decides what `show` prints, and core pins diff settings but not
      // that one. Under `oneline` the body — the thing this header exists to show — is gone,
      // and under a `%n`-heavy custom format the four-space message indent that keeps a
      // message line from parsing as a `diff --git` section boundary is gone with it.
      //
      // `--first-parent` is what makes a merge commit render at all: git suppresses a
      // merge's diff unless told which parent to diff against, so `show <merge>` prints
      // nothing and every merge — including the tip of `main` in most repositories — looked
      // like a commit that changed no files. Of the three flags that lift that, `--cc` shows
      // only hunks differing from *both* parents, so a conflict-free merge still renders
      // nothing; `-m` emits one patch per parent, which claims the merge changed the same
      // file twice. `--first-parent` answers what the Commits Pane is actually asking — what
      // this merge brought into this branch — and is byte-identical to no flag at all on a
      // non-merge commit, so the ordinary case is untouched.
      return {
        argv: ["show", "--pretty=medium", ...patchFlags, "--first-parent", target.ref, "--", ...pathTail],
        nonZeroExitMayCarryPatch: false,
        headed: true,
      }
    case "stash":
      // `git stash show` takes one revision and nothing else: adding a pathspec makes it
      // exit with "Too many revisions specified". A narrowed stash therefore goes through
      // the diff a stash entry *is* — its first parent is the commit it was taken against,
      // and `git diff stash@{0}^1 stash@{0}` is byte-identical to `stash show -p`.
      if (target.path !== null) {
        return {
          argv: ["diff", ...patchFlags, `${target.ref}^1`, target.ref, "--", ...pathTail],
          nonZeroExitMayCarryPatch: false,
          headed: false,
        }
      }
      // `show` must sit immediately after `stash`: the service reads the argv element
      // *directly* after the subcommand as its operand, and only the exact pair
      // `stash show` is on its read-only list. A flag in between makes this a mutation.
      return {
        argv: ["stash", "show", "-p", ...patchFlags, target.ref],
        nonZeroExitMayCarryPatch: false,
        headed: false,
      }
  }
}

/**
 * The file a patch section is about.
 *
 * `+++ b/<path>` is the new name and the one to prefer; a deletion writes `+++ /dev/null`,
 * so the old name is kept as the fallback. Stops at the first hunk, because from there on
 * every line is *content* and content can say anything at all.
 */
function pathOfSection(lines: readonly string[]): string | null {
  let removed: string | null = null
  for (const line of lines) {
    if (line.startsWith("@@")) break
    if (line.startsWith("+++ b/")) return line.slice("+++ b/".length)
    if (line.startsWith("--- a/")) removed = line.slice("--- a/".length)
  }
  return removed
}

/**
 * A patch, split into one self-contained patch per file.
 *
 * OpenTUI's `<diff>` parses what it is given and renders `patches[0]` — only the first file,
 * with nothing on screen to say the others existed (`renderables/Diff.ts`). Every commit and
 * every stash that touched more than one file was silently showing a fraction of itself. The
 * fix has to live here because the alternative — telling the user "4 more files not shown" —
 * leaves the Pane unable to do the one thing it is for. A `<diff>` per section renders all of
 * them, and the section boundary is unambiguous: `diff --git` can only start a line at column
 * 0 in a header, since every line inside a hunk carries a leading ` `, `+`, `-` or `\`.
 *
 * A patch with nothing in it splits to nothing, so "this target has no changes" has exactly
 * one encoding rather than also being a `<diff>` with an empty string in it.
 *
 * `headed` says whether git was asked for a commit header, and only then is the text before
 * the first section lifted off as one. A message body cannot be mistaken for a file section
 * on the way: `git show` indents every line of the message by four spaces, so nothing inside
 * one can start `diff --git` at column 0 — the same property that makes the section rule
 * unambiguous in the first place.
 */
function splitPatch(patch: string, headed: boolean): ParsedPatch {
  const sections: string[][] = []
  for (const line of patch.split("\n")) {
    const open = sections[sections.length - 1]
    if (open === undefined || line.startsWith("diff --git ")) sections.push([line])
    else open.push(line)
  }

  // A preamble exists only when the first section is not itself a file, which for a headed
  // fetch is every commit and for an unheaded one is never.
  const preamble = sections[0]
  const headless = preamble === undefined || preamble[0]?.startsWith("diff --git ") === true
  const header = headed && !headless ? preamble.join("\n").trim() : null

  return {
    header: header === "" ? null : header,
    files: (header === null ? sections : sections.slice(1))
      .map((lines) => ({
        path: pathOfSection(lines),
        patch: lines.join("\n"),
        hasHunks: lines.some((line) => line.startsWith("@@")),
      }))
      .filter((file) => file.patch.trim() !== ""),
  }
}

/** The half of the header that names which side of the repository is being diffed. */
function scopeOf(target: DiffTarget): string {
  switch (target.kind) {
    case "workingTree":
      return "working tree"
    case "staged":
      return "staged"
    case "commit":
      return `commit ${target.ref.slice(0, 8)}`
    case "branch":
      return `branch ${target.ref}`
    case "stash":
      return target.ref
  }
}

/**
 * The context line the Pane writes above git's output, where git cannot write it itself.
 *
 * This is what makes a clipped list row recoverable: a Pane's rows are one line each, so the
 * name or message that ran off the right edge has to be somewhere, and this is where. Only
 * the two kinds git says nothing about need one — a commit's own header already names it,
 * while `git show <branch>` names the tip commit and never the branch, and `stash show`
 * prints no header at all.
 */
function contextOf(target: DiffTarget, state: GitState): string | null {
  if (target.kind === "branch") {
    const upstream = state.branches.find((candidate) => candidate.name === target.ref)?.upstream
    if (upstream === undefined || upstream === null) return target.ref
    const tracking = `${upstream.remote}/${upstream.branch}`
    if (upstream.gone) return `${target.ref} → ${tracking} (gone)`
    const behind = upstream.behind > 0 ? ` ↓${upstream.behind}` : ""
    const ahead = upstream.ahead > 0 ? ` ↑${upstream.ahead}` : ""
    return `${target.ref} → ${tracking}${ahead}${behind}`
  }
  if (target.kind === "stash") {
    const entry = state.stash.find((candidate) => `stash@{${candidate.index}}` === target.ref)
    if (entry === undefined) return null
    return `${target.ref}: ${entry.message}${entry.branch === null ? "" : ` on ${entry.branch}`}`
  }
  return null
}

/**
 * The path a file-level stage/unstage would act on, or `null` when there is none.
 *
 * One function rather than the same condition written into each menu item's `when` and
 * again into its `run`: `when` cannot narrow the target for `run` (they are separate
 * functions over the same type), so the two would otherwise be free to disagree about
 * which targets are stageable.
 */
function stageablePath(target: DiffTarget): string | null {
  if (target.kind !== "workingTree" && target.kind !== "staged") return null
  return target.path
}

/**
 * Filetype for tree-sitter highlighting: the final extension, without its dot.
 *
 * `dot > 0` rather than `>= 0`, so `.gitignore` stays a dotfile instead of becoming a file
 * of type `gitignore`. A diff with no single path gets `undefined` — spanning several
 * languages, any one choice would highlight most of it wrongly.
 */
function filetypeOf(path: string | null): string | undefined {
  if (path === null) return undefined
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : undefined
}

/** Whatever a rejected promise carried, as something printable. `GitError.message` is its stderr. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default defineExtension({
  name: "diff",
  description: "Diff of the focused pane's selection",

  config: {
    view: option.enum(views, { default: "unified", description: "Initial diff layout" }),
    context: option.number({ default: 3, min: 0, max: 20, description: "Lines of context around each hunk" }),
  },

  activate(ctx): DiffApi {
    // A Cell, not Pane state: `show` is called from other Extensions long before this Pane
    // is mounted, and the target must survive being set while nothing is rendering it.
    const target = createCell<DiffTarget | null>(null)

    // Also a Cell, for the same reason in reverse: the `v` command lives in the Pane but
    // the menu item that does the same thing lives out here, and both move the one value.
    // Seeded from config and never written back — `ctx.config` is an activation-constant
    // snapshot, so a session toggle is a layer over the configured default, not an edit.
    const view = createCell<DiffView>(ctx.config.view)

    const toggleView = (): void => {
      view.set(view.get() === "unified" ? "split" : "unified")
    }

    function DiffPane() {
      const theme = useTheme()
      const current = target.use()
      const layout = view.use()
      const [state, setState] = useState<DiffState>({ kind: "empty" })
      // Live, not read once at fetch time: a branch's divergence moves under a target that
      // has not changed, and the header is the place a user reads it.
      const context = useGit((git) => (current === null ? null : contextOf(current, git)))
      // `<diff>` has no scroll API of its own, so the Pane gives it one (§1.8).
      const scroll = useScrollView()

      // Monotonic ticket. Two fetches can be in flight — the cursor moved, or a refresh
      // landed mid-fetch — and git does not answer in the order it was asked: a whole-tree
      // diff started first can resolve after a one-file diff started second. Only the
      // newest ticket may write state, so a patch for a target you have left cannot win.
      const ticket = useRef(0)

      const load = useCallback(async () => {
        const issued = (ticket.current += 1)
        const next = target.get()
        if (next === null) {
          setState({ kind: "empty" })
          return
        }

        // Read at call time, not render time: this runs again on every `git.refreshed`, and
        // a file that was untracked a moment ago may have just been staged.
        const untracked = new Set(ctx.git.state.status.untracked.map((file) => file.path))
        const fetch = fetchFor(next, ctx.config.context, untracked)
        try {
          // `allowFailure`, because a diff of a ref git does not know is something to
          // render, not an unhandled rejection inside an effect.
          const output = await ctx.git.raw(fetch.argv, { allowFailure: true })
          if (issued !== ticket.current) return
          const answered = output.exitCode === 0 || (fetch.nonZeroExitMayCarryPatch && output.stdout.trim() !== "")
          setState(
            answered
              ? { kind: "ready", ...splitPatch(output.stdout, fetch.headed) }
              : {
                  // Shown in the Pane rather than raised through `notify`, because this runs
                  // on every store refresh: a target git rejects would otherwise put up a
                  // toast roughly every two seconds.
                  kind: "failed",
                  message: output.stderr.trim() || `git ${fetch.argv.join(" ")} exited ${output.exitCode}`,
                },
          )
        } catch (error) {
          if (issued !== ticket.current) return
          setState({ kind: "failed", message: messageOf(error) })
        }
      }, [])

      const key = targetKey(current)
      useEffect(() => {
        // `loading` is set only here, on a change of target. The refresh path below
        // deliberately leaves the current patch on screen until its replacement arrives, so
        // staging a file does not blink the Pane empty in between.
        setState({ kind: "loading" })
        scroll.scrollTo("start")
        void load()
      }, [key, load, scroll])

      // Staging, committing, and checking out all change what the current target diffs to
      // without changing the target itself.
      useEvent("git.refreshed", () => {
        void load()
      })

      useCommand({
        id: "diff.toggle-view",
        title: "Toggle unified/split diff",
        hint: "layout",
        keys: "v",
        run: toggleView,
      })

      // `j`/`k` hidden, for the same reason `useListCursor` hides its own: they are the
      // motion every Pane has, and repeating them in the cheat sheet buries the rest. Each
      // binds its arrow/nav twin too, so a reader who scrolls with the keys the list Panes
      // navigate with — vim or arrows — lands on the same motion here.
      useCommand({
        id: "diff.scroll-down",
        title: "Scroll down",
        keys: ["j", "down"],
        hidden: true,
        run: () => scroll.scrollBy(1),
      })
      useCommand({
        id: "diff.scroll-up",
        title: "Scroll up",
        keys: ["k", "up"],
        hidden: true,
        run: () => scroll.scrollBy(-1),
      })
      useCommand({
        id: "diff.page-down",
        title: "Page down",
        keys: ["ctrl+d", "pagedown"],
        // Half a viewport, measured rather than guessed: only the renderable knows how tall
        // the Pane ended up.
        run: () => scroll.scrollBy(scroll.viewportRows() / 2),
      })
      useCommand({
        id: "diff.page-up",
        title: "Page up",
        keys: ["ctrl+u", "pageup"],
        run: () => scroll.scrollBy(-scroll.viewportRows() / 2),
      })
      useCommand({
        id: "diff.top",
        title: "Top of diff",
        keys: ["g", "home"],
        run: () => scroll.scrollTo("start"),
      })
      useCommand({
        id: "diff.bottom",
        title: "End of diff",
        // `shift+g`, not `G`: the binding parser lowercases a bare letter, so `"G"` would
        // bind the same stroke as `g` above and one of them would never fire (§1.1).
        keys: ["shift+g", "end"],
        run: () => scroll.scrollTo("end"),
      })

      useCommand({
        id: "diff.menu",
        title: "Diff actions",
        hint: "menu",
        keys: "x",
        run: async () => {
          const open = target.get()
          if (open === null) return ctx.popups.notify("Nothing selected", "warning")
          await ctx.menus.open("diff.actions", open)
        },
      })

      if (current === null) return <text fg={theme.textMuted}>nothing selected</text>

      // Named per section when the chrome line above cannot name the file: either the target
      // is a whole side of the repository, or git returned more than one file for it.
      const files = state.kind === "ready" ? state.files : []
      const nameFiles = current.path === null || files.length > 1

      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <text fg={theme.textMuted}>
            <span fg={theme.accent}>{scopeOf(current)}</span>
            {current.path === null ? "" : ` ${current.path}`}
            {` [${layout}]`}
          </text>
          {state.kind === "failed" ? (
            <text fg={theme.danger}>{state.message}</text>
          ) : state.kind === "ready" ? (
            // `flexBasis={0}` is what keeps the box the size of the *Pane* rather than the
            // size of its content, which is what makes it scroll instead of overflowing
            // and painting across the chrome line above it.
            <scrollbox ref={scroll.ref} focusable={false} flexGrow={1} flexBasis={0}>
              {/* Inside the scrollbox, so it scrolls away rather than costing rows on every
                  screen of a long patch — and above everything, because it is the answer to
                  "what did that clipped row actually say". Wrapping, deliberately: a commit
                  body is prose and this is the one place in the app that has room for it. */}
              {context === null && state.header === null ? null : (
                <box flexDirection="column" border={["bottom"]} borderColor={theme.border} marginBottom={1}>
                  {context === null ? null : <text fg={theme.accent}>{context}</text>}
                  {state.header === null ? null : <text fg={theme.textMuted}>{state.header}</text>}
                </box>
              )}
              {/* An empty patch is the ordinary answer for a file whose changes were just
                  staged away, and for a commit that changed nothing: the target is still
                  valid, there is simply nothing in it. */}
              {files.length === 0 ? (
                <text fg={theme.textMuted}>no changes</text>
              ) : (
                files.map((file, index) => (
                  <Fragment key={`${index}\0${file.path ?? ""}`}>
                    {nameFiles ? (
                      <text wrapMode="none" fg={theme.accent}>
                        {file.path ?? "(unnamed)"}
                      </text>
                    ) : null}
                    {file.hasHunks ? (
                      <diff diff={file.patch} view={layout} filetype={filetypeOf(file.path ?? current.path)} />
                    ) : (
                      // git wrote a section with no hunk in it. Saying so beats a filename
                      // with nothing under it, which reads as a rendering bug.
                      <text fg={theme.textMuted}>no textual diff (binary, mode or rename only)</text>
                    )}
                  </Fragment>
                ))
              )}
            </scrollbox>
          ) : (
            <text fg={theme.textMuted}>loading…</text>
          )}
        </box>
      )
    }

    const pane = ctx.panes.register({
      id: "diff",
      title: "Diff",
      component: DiffPane,
      placement: { column: 1, order: 10 },
    })

    ctx.menus.register({
      id: "diff.actions",
      title: (open) => `Diff: ${scopeOf(open)}`,
      groups: [
        {
          id: "view",
          items: [
            { key: "v", label: "Toggle unified/split", run: toggleView },
            {
              key: "y",
              label: "Copy path",
              // Hidden rather than inert on a whole-side diff: there is no one path to copy.
              when: (open) => open.path !== null,
              run: async (open) => {
                if (open.path === null) return
                try {
                  await ctx.copy(open.path)
                  ctx.popups.notify(`Copied ${open.path}`, "success")
                } catch (error) {
                  ctx.popups.notify(messageOf(error), "error")
                }
              },
            },
          ],
        },
        {
          id: "index",
          title: "Index",
          items: [
            {
              key: "s",
              label: "Stage this file",
              when: (open) => open.kind === "workingTree" && stageablePath(open) !== null,
              run: async (open) => {
                const path = stageablePath(open)
                if (path === null) return
                try {
                  await ctx.git.stage([path])
                } catch (error) {
                  ctx.popups.notify(messageOf(error), "error")
                }
              },
            },
            {
              key: "u",
              label: "Unstage this file",
              when: (open) => open.kind === "staged" && stageablePath(open) !== null,
              run: async (open) => {
                const path = stageablePath(open)
                if (path === null) return
                try {
                  await ctx.git.unstage([path])
                } catch (error) {
                  ctx.popups.notify(messageOf(error), "error")
                }
              },
            },
          ],
        },
        {
          id: "refresh",
          items: [
            {
              key: "r",
              label: "Refresh",
              // Refreshes the store rather than only this Pane: `git.refreshed` re-runs the
              // fetch anyway, so one path keeps the diff and the rest of the app in step.
              run: async () => {
                await ctx.git.refresh()
              },
            },
          ],
        },
      ],
    })

    return {
      current: () => target.get(),
      show: (next) => {
        target.set(next)
        // Reveal, never focus: `show` is called by a list Pane on every cursor move and the
        // user is still driving that Pane. Only for a real target — the default Layout tabs
        // this Pane with `commit-flow`, and pulling the tab over to say "nothing selected"
        // would take the commit editor off screen mid-commit.
        if (next !== null) pane.reveal()
      },
    }
  },
})
