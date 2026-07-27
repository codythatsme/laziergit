/** @jsxImportSource @opentui/react */
import {
  createCell,
  defineExtension,
  isUntracked,
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
  /** `null` where git wrote a section with no `+++`/`---` pair. */
  readonly path: string | null
  readonly patch: string
  /** False for a binary file, or a pure mode or rename change. */
  readonly hasHunks: boolean
}

interface ParsedPatch {
  /** Everything git wrote before the first file section; `null` for a bare patch. */
  readonly header: string | null
  readonly files: readonly FilePatch[]
}

type DiffState =
  | { readonly kind: "empty" }
  | { readonly kind: "loading" }
  | ({ readonly kind: "ready" } & ParsedPatch)
  | { readonly kind: "failed"; readonly message: string }

/**
 * Identity of a target, independent of the object carrying it: every list Pane builds a fresh
 * `DiffTarget` on each refresh. Joined on NUL, which no git ref or path can contain.
 */
function targetKey(target: DiffTarget | null): string {
  return target === null ? "" : [target.kind, "ref" in target ? target.ref : "", target.path ?? ""].join("\0")
}

interface DiffFetch {
  readonly argv: readonly string[]
  /** `git diff --no-index` exits 1 both for "they differ" and for "cannot read"; only the
   * presence of a patch tells them apart. */
  readonly nonZeroExitMayCarryPatch: boolean
  /** Whether git was asked to print its own commit header before the patch. */
  readonly headed: boolean
}

/**
 * The git invocation for a target. Every shape here must stay on `ctx.git.raw`'s read-only
 * list: a fetch counted as a mutation would refresh the store, which re-runs the fetch.
 */
function fetchFor(target: DiffTarget, context: number, untracked: ReadonlySet<string>): DiffFetch {
  // `--no-ext-diff` is the only thing that disarms a user's `GIT_EXTERNAL_DIFF`, whose output
  // has no `@@` in it; it is a diff-only option, so core cannot pin it globally.
  const patchFlags = ["--no-ext-diff", `-U${context}`]
  // `literalPathspec` because git reads every path as a pattern: `foo[1].txt` would otherwise
  // also match `foo1.txt` (§1.5).
  const pathspec = target.path === null ? [] : ["--", literalPathspec(target.path)]
  // For argvs that write their own `--`. It goes in unconditionally: anything naming a
  // revision must end the revision list, or `git show docs` is an ambiguous argument.
  const pathTail = target.path === null ? [] : [literalPathspec(target.path)]
  switch (target.kind) {
    case "workingTree":
      // An untracked file has nothing in the index to diff against, so plain `git diff` prints
      // nothing; `--no-index` against `/dev/null` renders the whole file as added. Untracked
      // paths only — a tracked one would render whole rather than as its change. The path is
      // raw because `--no-index` takes filesystem paths, not pathspecs.
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
      // A branch is a ref like any other; the kinds differ only in the line the Pane writes
      // above the result.
      //
      // `--pretty=medium` is pinned rather than left to the user's `format.pretty`, which core
      // does not pin: `oneline` drops the body, and a custom format drops the four-space
      // message indent that keeps a message line from parsing as a `diff --git` boundary.
      //
      // `--first-parent` is what makes a merge render at all — git prints no diff for one
      // otherwise — and is byte-identical to no flag on a non-merge commit. `--cc` renders
      // nothing for a conflict-free merge, and `-m` claims each file changed once per parent.
      return {
        argv: ["show", "--pretty=medium", ...patchFlags, "--first-parent", target.ref, "--", ...pathTail],
        nonZeroExitMayCarryPatch: false,
        headed: true,
      }
    case "stash":
      // `git stash show` takes one revision and nothing else, so a narrowed stash diffs the
      // entry against its first parent instead — byte-identical to `stash show -p`.
      if (target.path !== null) {
        return {
          argv: ["diff", ...patchFlags, `${target.ref}^1`, target.ref, "--", ...pathTail],
          nonZeroExitMayCarryPatch: false,
          headed: false,
        }
      }
      // `show` must sit immediately after `stash`: the service reads the next argv element as
      // the operand, and only the exact pair `stash show` is on its read-only list.
      return {
        argv: ["stash", "show", "-p", ...patchFlags, target.ref],
        nonZeroExitMayCarryPatch: false,
        headed: false,
      }
  }
}

/**
 * The file a patch section is about. Prefers the new name; a deletion writes `+++ /dev/null`,
 * so the old one is the fallback. Stops at the first hunk, where content could say anything.
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
 * A patch, split into one self-contained patch per file, because OpenTUI's `<diff>` renders
 * only `patches[0]`. The boundary is unambiguous: `diff --git` can start a line at column 0
 * only in a header, since every line inside a hunk begins with ` `, `+`, `-` or `\`.
 *
 * `headed` lifts git's commit header off the front. A message body cannot be mistaken for a
 * section on the way — `git show` indents every message line by four spaces.
 */
function splitPatch(patch: string, headed: boolean): ParsedPatch {
  const sections: string[][] = []
  for (const line of patch.split("\n")) {
    const open = sections[sections.length - 1]
    if (open === undefined || line.startsWith("diff --git ")) sections.push([line])
    else open.push(line)
  }

  // A preamble exists only when the first section is not itself a file.
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
 * The context line the Pane writes above git's output, so a clipped list row is recoverable.
 * Only branches and stashes need one: `git show <branch>` names the tip commit and never the
 * branch, and `stash show` prints no header at all.
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
 * The path a file-level stage/unstage would act on, or `null` when there is none. Shared so a
 * menu item's `when` and its `run` cannot disagree — `when` cannot narrow the type for `run`.
 */
function stageablePath(target: DiffTarget): string | null {
  if (target.kind !== "workingTree" && target.kind !== "staged") return null
  return target.path
}

/**
 * Filetype for tree-sitter highlighting: the final extension, without its dot. `dot > 0` keeps
 * `.gitignore` a dotfile rather than a file of type `gitignore`.
 */
function filetypeOf(path: string | null): string | undefined {
  if (path === null) return undefined
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : undefined
}

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
    // Cells, not Pane state: `show` and the menu items run while this Pane is unmounted.
    const target = createCell<DiffTarget | null>(null)
    // Seeded from config and never written back: `ctx.config` is an activation snapshot, so
    // the toggle is a session layer over the configured default.
    const view = createCell<DiffView>(ctx.config.view)

    const toggleView = (): void => {
      view.set(view.get() === "unified" ? "split" : "unified")
    }

    function DiffPane() {
      const theme = useTheme()
      const current = target.use()
      const layout = view.use()
      const [state, setState] = useState<DiffState>({ kind: "empty" })
      // Live, not read once at fetch time: a branch's divergence moves under an unchanged
      // target, and this line is where a user reads it.
      const context = useGit((git) => (current === null ? null : contextOf(current, git)))
      // `<diff>` has no scroll API of its own, so the Pane gives it one (§1.8).
      const scroll = useScrollView()

      // Monotonic ticket: two fetches can be in flight, and git does not answer in order. Only
      // the newest may write state, so a patch for a target you have left cannot win.
      const ticket = useRef(0)

      const load = useCallback(async () => {
        const issued = (ticket.current += 1)
        const next = target.get()
        if (next === null) {
          setState({ kind: "empty" })
          return
        }

        // Read at call time: this runs again on every `git.refreshed`, and a file that was
        // untracked a moment ago may have just been staged.
        const untracked = new Set(ctx.git.state.status.files.filter(isUntracked).map((file) => file.path))
        const fetch = fetchFor(next, ctx.config.context, untracked)
        try {
          // `allowFailure`: a diff of a ref git does not know is something to render, not an
          // unhandled rejection inside an effect.
          const output = await ctx.git.raw(fetch.argv, { allowFailure: true })
          if (issued !== ticket.current) return
          const answered = output.exitCode === 0 || (fetch.nonZeroExitMayCarryPatch && output.stdout.trim() !== "")
          setState(
            answered
              ? { kind: "ready", ...splitPatch(output.stdout, fetch.headed) }
              : {
                  // In the Pane rather than through `notify`: this runs on every store
                  // refresh, so a rejected target would toast every couple of seconds.
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
        // Only a change of target shows `loading`; a refresh leaves the current patch up until
        // its replacement arrives, so staging a file does not blink the Pane empty.
        setState({ kind: "loading" })
        scroll.scrollTo("start")
        void load()
      }, [key, load, scroll])

      // Staging, committing and checking out change what an unchanged target diffs to.
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

      // Hidden like `useListCursor`'s own motion keys: every Pane has them, and repeating them
      // in the cheat sheet buries the rest.
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
        // `shift+g`, not `G`: the parser lowercases a bare letter, colliding with `g` above.
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

      // Named per section only where the chrome line above cannot name the file.
      const files = state.kind === "ready" ? state.files : []
      const nameFiles = current.path === null || files.length > 1

      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          {/* Outside the scrollbox: what the Pane is pointed at must not scroll away. */}
          <text wrapMode="none" fg={theme.textMuted}>
            <span fg={theme.accent}>{scopeOf(current)}</span>
            {current.path === null ? "" : ` ${current.path}`}
            {` [${layout}]`}
          </text>
          {state.kind === "failed" ? (
            <text fg={theme.danger}>{state.message}</text>
          ) : state.kind === "ready" ? (
            // `flexBasis={0}` sizes the box to the Pane rather than to its content, so the
            // patch scrolls instead of overflowing the chrome line above it.
            <scrollbox ref={scroll.ref} focusable={false} flexGrow={1} flexBasis={0}>
              {context === null && state.header === null ? null : (
                <box flexDirection="column" border={["bottom"]} borderColor={theme.border} marginBottom={1}>
                  {context === null ? null : <text fg={theme.accent}>{context}</text>}
                  {state.header === null ? null : <text fg={theme.textMuted}>{state.header}</text>}
                </box>
              )}
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
              // The store, not just this Pane: `git.refreshed` re-runs the fetch anyway.
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
        // Reveal, never focus: `show` runs on every cursor move of the Pane the user is
        // driving. Only for a real target, or an empty diff would displace the commit editor.
        if (next !== null) pane.reveal()
      },
    }
  },
})
