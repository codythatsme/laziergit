/** @jsxImportSource @opentui/react */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCell,
  defineExtension,
  describeGitFailure,
  isUntracked,
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

import { fetchFor } from "./fetch"
import {
  chooseConflict,
  createConflictSession,
  lineRole,
  moveConflict,
  moveSide,
  parseConflicts,
  sideRange,
  undoConflict,
  type ConflictChoice,
  type ConflictSession,
} from "./conflicts"
import {
  createPatchSession,
  movePatchCursor,
  movePatchHunk,
  replacePatch,
  selectPatch,
  selectedPatchLines,
  togglePatchMode,
  togglePatchRange,
  type PatchSession,
} from "./patch"
import { diffThemeProps } from "./theme"

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

/** An answer carries its target: it stays on screen while the next target's fetch is in flight. */
type DiffState =
  | { readonly kind: "empty" }
  | ({ readonly kind: "ready"; readonly target: DiffTarget } & ParsedPatch)
  | { readonly kind: "failed"; readonly target: DiffTarget; readonly message: string }

type StagingSide = "unstaged" | "staged"

type Interaction =
  | { readonly kind: "passive" }
  | { readonly kind: "conflict"; readonly path: string; readonly session: ConflictSession }
  | {
      readonly kind: "staging"
      readonly path: string
      readonly side: StagingSide
      readonly session: PatchSession | null
      readonly message: string | null
    }

function otherSide(side: StagingSide): StagingSide {
  return side === "unstaged" ? "staged" : "unstaged"
}

function lineText(line: string): string {
  const withoutLf = line.endsWith("\n") ? line.slice(0, -1) : line
  return withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf
}

/**
 * Identity of a target, independent of the object carrying it: every list Pane builds a fresh
 * `DiffTarget` on each refresh. Joined on NUL, which no git ref or path can contain.
 */
function targetKey(target: DiffTarget | null): string {
  return target === null ? "" : [target.kind, "ref" in target ? target.ref : "", target.path ?? ""].join("\0")
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
      return "stash"
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
    return `${entry.message}${entry.branch === null ? "" : ` on ${entry.branch}`}`
  }
  return null
}

/**
 * The path a file-level stage/unstage would act on, or `null` when there is none. Shared so a
 * Command availability and execution share this test, so they cannot disagree.
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
    // Cells, not Pane state: `show` can run while this Pane is unmounted.
    const target = createCell<DiffTarget | null>(null)
    // Seeded from config and never written back: `ctx.config` is an activation snapshot, so
    // the toggle is a session layer over the configured default.
    const view = createCell<DiffView>(ctx.config.view)
    const interaction = createCell<Interaction>({ kind: "passive" })
    let pane: ReturnType<typeof ctx.panes.register>
    let mutationTail: Promise<void> = Promise.resolve()
    let interactionTicket = 0

    function enqueueMutation(work: () => Promise<void>): Promise<void> {
      const next = mutationTail.then(work, work)
      mutationTail = next.catch(() => undefined)
      return next
    }

    async function focusFiles(conflict = false): Promise<void> {
      if (conflict) {
        try {
          await ctx.commands.execute("files.focus-conflict")
          return
        } catch {
          // A user may replace the files extension with one that only implements `files.focus`.
        }
      }
      try {
        await ctx.commands.execute("files.focus")
      } catch {
        // The diff extension is also valid by itself in a custom Layout.
      }
    }

    async function readConflict(path: string, preferred?: ConflictSession["side"]): Promise<ConflictSession | null> {
      const content = await Bun.file(`${ctx.git.root}/${path}`).text()
      const parsed = parseConflicts(content)
      if (parsed.kind === "malformed") throw new Error(parsed.message)
      return createConflictSession(content, preferred)
    }

    async function fetchStagingPatch(path: string, side: StagingSide): Promise<string> {
      const untracked = new Set(ctx.git.state.status.files.filter(isUntracked).map((file) => file.path))
      const request = fetchFor(
        { kind: side === "unstaged" ? "workingTree" : "staged", path },
        ctx.config.context,
        untracked,
      )
      // Rename metadata makes a partial patch move the whole path. Interactive staging treats
      // it as delete+add instead, while the passive diff keeps the user's configured rename view.
      const argv = request.argv[0] === "diff" ? ["diff", "--no-renames", ...request.argv.slice(1)] : request.argv
      const output = await ctx.git.raw(argv, { allowFailure: true })
      return output.exitCode === 0 || (request.nonZeroExitMayCarryPatch && output.stdout.trim() !== "")
        ? output.stdout
        : ""
    }

    async function loadStaging(path: string, preferred: StagingSide, previous?: PatchSession): Promise<Interaction> {
      const firstPatch = await fetchStagingPatch(path, preferred)
      const first = previous === undefined ? createPatchSession(firstPatch) : replacePatch(previous, firstPatch)
      if (first !== null) return { kind: "staging", path, side: preferred, session: first, message: null }

      const alternate = otherSide(preferred)
      const alternatePatch = await fetchStagingPatch(path, alternate)
      const second = createPatchSession(alternatePatch)
      return second === null
        ? { kind: "staging", path, side: preferred, session: null, message: "no stageable text changes" }
        : { kind: "staging", path, side: alternate, session: second, message: null }
    }

    async function refreshInteraction(): Promise<void> {
      const issued = (interactionTicket += 1)
      const open = interaction.get()
      try {
        if (open.kind === "conflict") {
          const session = await readConflict(open.path, open.session.side)
          if (issued !== interactionTicket) return
          if (session === null) {
            interaction.set({ kind: "passive" })
            await focusFiles(true)
          } else interaction.set({ kind: "conflict", path: open.path, session })
          return
        }
        if (open.kind === "staging") {
          const next = await loadStaging(open.path, open.side, open.session ?? undefined)
          if (issued === interactionTicket) interaction.set(next)
        }
      } catch (error) {
        if (issued === interactionTicket) ctx.popups.notify(describeGitFailure(error), "error")
      }
    }

    async function resolveConflict(choice: ConflictChoice): Promise<void> {
      await enqueueMutation(async () => {
        const open = interaction.get()
        if (open.kind !== "conflict") return
        const resolution = chooseConflict(open.session, choice)
        await Bun.write(`${ctx.git.root}/${open.path}`, resolution.content)
        if (resolution.session !== null) {
          interaction.set({ kind: "conflict", path: open.path, session: resolution.session })
          return
        }
        interaction.set({ kind: "passive" })
        await ctx.git.refresh()
        await focusFiles(true)
      })
    }

    async function undoResolution(): Promise<void> {
      await enqueueMutation(async () => {
        const open = interaction.get()
        if (open.kind !== "conflict") return
        const session = undoConflict(open.session)
        if (session === open.session) return
        await Bun.write(`${ctx.git.root}/${open.path}`, session.content)
        interaction.set({ kind: "conflict", path: open.path, session })
      })
    }

    async function stageBlob(stage: 1 | 2 | 3, path: string): Promise<string | null> {
      const output = await ctx.git.raw(["show", `:${stage}:${path}`], { allowFailure: true })
      return output.exitCode === 0 ? output.stdout : null
    }

    async function resolveWholeFile(strategy: "ours" | "theirs" | "union"): Promise<void> {
      await enqueueMutation(async () => {
        const open = interaction.get()
        if (open.kind !== "conflict") return
        const [base, current, incoming] = await Promise.all([
          stageBlob(1, open.path),
          stageBlob(2, open.path),
          stageBlob(3, open.path),
        ])
        if (current === null || incoming === null) throw new Error("This conflict has no textual current/incoming pair")

        const directory = await mkdtemp(join(tmpdir(), "laziergit-merge-file-"))
        try {
          const basePath = join(directory, "base")
          const currentPath = join(directory, "current")
          const incomingPath = join(directory, "incoming")
          await Promise.all([
            writeFile(basePath, base ?? ""),
            writeFile(currentPath, current),
            writeFile(incomingPath, incoming),
          ])
          const output = await ctx.git.raw(
            ["merge-file", "--stdout", `--${strategy}`, currentPath, basePath, incomingPath],
            { allowFailure: true },
          )
          // merge-file reports the number of conflicts (capped at 127), even though --ours,
          // --theirs and --union still produced the requested complete output.
          if (output.exitCode >= 128) throw new Error(output.stderr.trim() || "git merge-file failed")
          await Bun.write(`${ctx.git.root}/${open.path}`, output.stdout)
          await ctx.git.stage([open.path])
          interaction.set({ kind: "passive" })
          await focusFiles(true)
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      })
    }

    async function runMergetool(): Promise<void> {
      const open = interaction.get()
      if (open.kind !== "conflict") return
      // Lazygit deliberately lets mergetool walk the complete unresolved set from here.
      const exitCode = await ctx.interactive("git", ["mergetool"])
      await ctx.git.refresh()
      if (exitCode !== 0) ctx.popups.notify(`git mergetool exited ${exitCode}`, "error")
      else await refreshInteraction()
    }

    async function openWholeFileMenu(): Promise<void> {
      if (interaction.get().kind !== "conflict") return
      await ctx.popups.menu({
        title: "Resolve whole file",
        groups: [
          {
            items: [
              { key: "c", label: "Use current changes", run: () => resolveWholeFile("ours") },
              { key: "i", label: "Use incoming changes", run: () => resolveWholeFile("theirs") },
              { key: "b", label: "Use both", run: () => resolveWholeFile("union") },
              { key: "m", label: "Open external merge tool", run: runMergetool },
            ],
          },
        ],
      })
    }

    async function editOpenPath(): Promise<void> {
      const open = interaction.get()
      if (open.kind === "passive") return
      const editor = (await ctx.git.raw(["var", "GIT_EDITOR"], { allowFailure: true })).stdout.trim()
      const command = editor === "" ? (process.env.EDITOR ?? "vi") : editor
      const shell = process.env.SHELL ?? "/bin/sh"
      const exitCode = await ctx.interactive(shell, [
        "-c",
        `${command} "$1"`,
        "laziergit-editor",
        `${ctx.git.root}/${open.path}`,
      ])
      await ctx.git.refresh()
      if (exitCode !== 0) ctx.popups.notify(`Editor exited ${exitCode}`, "error")
      else await refreshInteraction()
    }

    async function applyPatch(discard = false): Promise<void> {
      await enqueueMutation(async () => {
        const open = interaction.get()
        if (open.kind !== "staging" || open.session === null) return
        const reverse = open.side === "staged" || discard
        const patch = selectPatch(open.session, { reverse })
        if (patch === null) return

        if (discard && open.side === "unstaged") {
          const confirmed = await ctx.popups.confirm({
            title: "Discard selected changes?",
            message: `Throw away the selected ${open.session.mode === "hunk" ? "hunk" : "line or range"} in ${open.path}.`,
            confirmLabel: "discard",
            danger: true,
          })
          if (!confirmed) return
        }

        const args = [
          "apply",
          ...(open.side === "staged" || !discard ? ["--cached"] : []),
          ...(reverse ? ["--reverse"] : []),
          "--whitespace=nowarn",
          "-",
        ]
        await ctx.git.raw(args, { stdin: patch })
        interaction.set(await loadStaging(open.path, open.side, open.session))
      })
    }

    async function switchStagingSide(): Promise<void> {
      const open = interaction.get()
      if (open.kind !== "staging") return
      const patch = await fetchStagingPatch(open.path, otherSide(open.side))
      const session = createPatchSession(patch, open.session?.cursor)
      if (session === null) {
        ctx.popups.notify(`No ${otherSide(open.side)} changes`, "info")
        return
      }
      interaction.set({ kind: "staging", path: open.path, side: otherSide(open.side), session, message: null })
    }

    async function leaveInteraction(): Promise<void> {
      interactionTicket += 1
      interaction.set({ kind: "passive" })
      await focusFiles()
    }

    const toggleView = (): void => {
      view.set(view.get() === "unified" ? "split" : "unified")
    }

    function DiffPane() {
      const theme = useTheme()
      const diffTheme = diffThemeProps(theme)
      const current = target.use()
      const active = interaction.use()
      const layout = view.use()
      const [state, setState] = useState<DiffState>({ kind: "empty" })
      // Trails `current` while a fetch is in flight, so nothing below the chrome line draws a
      // patch under another target's headings.
      const shown = state.kind === "empty" ? null : state.target
      // Live, not read once at fetch time: a branch's divergence moves under an unchanged
      // target, and this line is where a user reads it.
      const context = useGit((git) => (shown === null ? null : contextOf(shown, git)))
      // `<diff>` has no scroll API of its own, so the Pane gives it one.
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
              ? { kind: "ready", target: next, ...splitPatch(output.stdout, fetch.headed) }
              : {
                  // In the Pane rather than through `notify`: this runs on every store
                  // refresh, so a rejected target would toast every couple of seconds.
                  kind: "failed",
                  target: next,
                  message: output.stderr.trim() || `git ${fetch.argv.join(" ")} exited ${output.exitCode}`,
                },
          )
        } catch (error) {
          if (issued !== ticket.current) return
          setState({ kind: "failed", target: next, message: messageOf(error) })
        }
      }, [])

      const key = targetKey(current)
      useEffect(() => {
        // Clearing here would blank the Pane for the frames a git process takes, flashing on
        // every cursor move of the list the user is driving.
        void load()
      }, [key, load])

      const shownKey = targetKey(shown)
      useEffect(() => {
        // Keyed on the patch that lands, not the target that asked for it: the outgoing patch
        // would otherwise be seen jumping to its top before its replacement arrived.
        scroll.scrollTo("start")
      }, [shownKey, scroll])

      const interactiveCursor =
        active.kind === "conflict"
          ? (active.session.conflicts[active.session.conflictIndex]?.start ?? 0)
          : active.kind === "staging"
            ? (active.session?.cursor ?? 0)
            : -1
      useEffect(() => {
        if (interactiveCursor >= 0) scroll.scrollTo(Math.max(0, interactiveCursor - 2))
      }, [interactiveCursor, scroll])

      // Staging, committing and checking out change what an unchanged target diffs to.
      useEvent("git.refreshed", () => (interaction.get().kind === "passive" ? load() : refreshInteraction()))

      useCommand({
        id: "diff.toggle-view",
        title: "Toggle unified/split diff or staging range",
        hint: "layout",
        keys: "v",
        when: () => interaction.get().kind !== "conflict",
        run: () => {
          const open = interaction.get()
          if (open.kind === "staging" && open.session !== null) {
            interaction.set({ ...open, session: togglePatchRange(open.session) })
          } else toggleView()
        },
      })
      useCommand({
        id: "diff.copy-path",
        title: "Copy diff path",
        keys: "y",
        when: () => current?.path !== null && current?.path !== undefined,
        run: async () => {
          const open = target.get()
          if (open?.path === null || open?.path === undefined) return
          try {
            await ctx.copy(open.path)
            ctx.popups.notify(`Copied ${open.path}`, "success")
          } catch (error) {
            ctx.popups.notify(messageOf(error), "error")
          }
        },
      })
      useCommand({
        id: "diff.stage",
        title: "Stage the diffed file",
        keys: "s",
        when: () =>
          interaction.get().kind === "passive" && current?.kind === "workingTree" && stageablePath(current) !== null,
        run: async () => {
          const open = target.get()
          const path = open === null ? null : stageablePath(open)
          if (path === null) return
          try {
            await ctx.git.stage([path])
          } catch (error) {
            ctx.popups.notify(messageOf(error), "error")
          }
        },
      })
      useCommand({
        id: "diff.unstage",
        title: "Unstage the diffed file",
        keys: "u",
        when: () =>
          interaction.get().kind === "passive" && current?.kind === "staged" && stageablePath(current) !== null,
        run: async () => {
          const open = target.get()
          const path = open === null ? null : stageablePath(open)
          if (path === null) return
          try {
            await ctx.git.unstage([path])
          } catch (error) {
            ctx.popups.notify(messageOf(error), "error")
          }
        },
      })
      useCommand({
        id: "diff.refresh",
        title: "Refresh repository state",
        keys: "r",
        run: () => ctx.git.refresh(),
      })

      // Hidden like `useListCursor`'s own motion keys: every Pane has them, and repeating them
      // in the cheat sheet buries the rest.
      useCommand({
        id: "diff.scroll-down",
        title: "Next line or conflict side",
        keys: ["j", "down"],
        hidden: true,
        run: () => {
          const open = interaction.get()
          if (open.kind === "conflict") interaction.set({ ...open, session: moveSide(open.session, 1) })
          else if (open.kind === "staging" && open.session !== null) {
            interaction.set({ ...open, session: movePatchCursor(open.session, 1) })
          } else scroll.scrollBy(1)
        },
      })
      useCommand({
        id: "diff.scroll-up",
        title: "Previous line or conflict side",
        keys: ["k", "up"],
        hidden: true,
        run: () => {
          const open = interaction.get()
          if (open.kind === "conflict") interaction.set({ ...open, session: moveSide(open.session, -1) })
          else if (open.kind === "staging" && open.session !== null) {
            interaction.set({ ...open, session: movePatchCursor(open.session, -1) })
          } else scroll.scrollBy(-1)
        },
      })
      useCommand({
        id: "diff.previous-block",
        title: "Previous conflict or hunk",
        keys: ["h", "left"],
        when: () => interaction.get().kind !== "passive",
        run: () => {
          const open = interaction.get()
          if (open.kind === "conflict") interaction.set({ ...open, session: moveConflict(open.session, -1) })
          else if (open.kind === "staging" && open.session !== null)
            interaction.set({ ...open, session: movePatchHunk(open.session, -1) })
        },
      })
      useCommand({
        id: "diff.next-block",
        title: "Next conflict or hunk",
        keys: ["l", "right"],
        when: () => interaction.get().kind !== "passive",
        run: () => {
          const open = interaction.get()
          if (open.kind === "conflict") interaction.set({ ...open, session: moveConflict(open.session, 1) })
          else if (open.kind === "staging" && open.session !== null)
            interaction.set({ ...open, session: movePatchHunk(open.session, 1) })
        },
      })
      useCommand({
        id: "diff.choose",
        title: "Choose conflict side or apply staging selection",
        hint: "choose",
        keys: "space",
        when: () => interaction.get().kind !== "passive",
        run: () => {
          const open = interaction.get()
          return open.kind === "conflict" ? resolveConflict(open.session.side) : applyPatch()
        },
      })
      useCommand({
        id: "diff.choose-both",
        title: "Choose both conflict sides",
        hint: "both",
        keys: "b",
        when: () => interaction.get().kind === "conflict",
        run: () => resolveConflict("both"),
      })
      useCommand({
        id: "diff.undo-conflict",
        title: "Undo conflict choice",
        hint: "undo",
        keys: "z",
        when: () => interaction.get().kind === "conflict",
        run: undoResolution,
      })
      useCommand({
        id: "diff.whole-file-conflict",
        title: "Resolve the whole conflicted file",
        hint: "whole file",
        keys: "shift+m",
        when: () => interaction.get().kind === "conflict",
        run: openWholeFileMenu,
      })
      useCommand({
        id: "diff.staging-mode",
        title: "Toggle line/hunk staging",
        hint: "line/hunk",
        keys: "a",
        when: () => interaction.get().kind === "staging",
        run: () => {
          const open = interaction.get()
          if (open.kind === "staging" && open.session !== null)
            interaction.set({ ...open, session: togglePatchMode(open.session) })
        },
      })
      useCommand({
        id: "diff.staging-side",
        title: "Switch staged/unstaged changes",
        hint: "side",
        keys: "tab",
        when: () => interaction.get().kind === "staging",
        run: switchStagingSide,
      })
      useCommand({
        id: "diff.staging-discard",
        title: "Discard or unstage selection",
        hint: "discard",
        keys: "d",
        when: () => interaction.get().kind === "staging",
        run: () => applyPatch(true),
      })
      useCommand({
        id: "diff.edit-interactive",
        title: "Edit current file",
        keys: ["e", "shift+e"],
        when: () => interaction.get().kind !== "passive",
        run: editOpenPath,
      })
      useCommand({
        id: "diff.open-interactive",
        title: "Open current file",
        keys: "o",
        when: () => interaction.get().kind !== "passive",
        run: async () => {
          const open = interaction.get()
          if (open.kind !== "passive") await ctx.open(`${ctx.git.root}/${open.path}`)
        },
      })
      useCommand({
        id: "diff.leave-interactive",
        title: "Return to files",
        hint: "back",
        keys: ["escape", "return"],
        when: () => interaction.get().kind !== "passive",
        run: leaveInteraction,
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
        id: "diff.scroll-left",
        title: "Scroll left",
        keys: "shift+h",
        run: () => scroll.scrollByColumns(-2),
      })
      useCommand({
        id: "diff.scroll-right",
        title: "Scroll right",
        keys: "shift+l",
        run: () => scroll.scrollByColumns(2),
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

      if (active.kind === "conflict") {
        const selectedBlock = active.session.conflicts[active.session.conflictIndex]
        const selected = selectedBlock === undefined ? null : sideRange(selectedBlock, active.session.side)
        return (
          <box flexDirection="column" flexGrow={1} flexBasis={0}>
            <text wrapMode="none" fg={theme.textMuted}>
              <span fg={theme.danger}>conflict</span>
              {` ${active.path}  ${active.session.conflictIndex + 1}/${active.session.conflicts.length}  `}
              <span fg={theme.accent}>{active.session.side}</span>
            </text>
            <scrollbox ref={scroll.ref} focusable={false} flexGrow={1} flexBasis={0}>
              {active.session.lines.map((line, index) => {
                const block = active.session.conflicts.find(
                  (candidate) => index >= candidate.start && index <= candidate.end,
                )
                const role = block === undefined ? null : lineRole(block, index)
                const highlighted =
                  block === selectedBlock && selected !== null && index >= selected[0] && index < selected[1]
                const color =
                  role === "marker"
                    ? theme.danger
                    : role === "current"
                      ? theme.diffRemoved
                      : role === "incoming"
                        ? theme.diffAdded
                        : role === "ancestor"
                          ? theme.warning
                          : theme.text
                return (
                  <text key={index} wrapMode="none" fg={color} bg={highlighted ? theme.selection : undefined}>
                    {lineText(line) || " "}
                  </text>
                )
              })}
            </scrollbox>
          </box>
        )
      }

      if (active.kind === "staging") {
        const selected = active.session === null ? new Set<number>() : selectedPatchLines(active.session)
        const range = active.session?.anchor === null ? "" : " range"
        return (
          <box flexDirection="column" flexGrow={1} flexBasis={0}>
            <text wrapMode="none" fg={theme.textMuted}>
              <span fg={theme.accent}>{active.side}</span>
              {` ${active.path}${active.session === null ? "" : `  [${active.session.mode}${range}]`}`}
            </text>
            <scrollbox ref={scroll.ref} focusable={false} flexGrow={1} flexBasis={0}>
              {active.session === null ? (
                <text fg={theme.textMuted}>{active.message ?? "no stageable text changes"}</text>
              ) : (
                active.session.patch.lines.map((line) => {
                  const color =
                    line.kind === "added"
                      ? theme.diffAdded
                      : line.kind === "removed"
                        ? theme.diffRemoved
                        : line.kind === "hunkHeader"
                          ? theme.accent
                          : line.kind === "header" || line.kind === "metadata"
                            ? theme.textMuted
                            : theme.text
                  return (
                    <text
                      key={line.index}
                      wrapMode="none"
                      fg={color}
                      bg={selected.has(line.index) ? theme.selection : undefined}
                    >
                      {line.text || " "}
                    </text>
                  )
                })
              )}
            </scrollbox>
          </box>
        )
      }

      if (current === null) return <text fg={theme.textMuted}>nothing selected</text>

      // Named per section only where the chrome line above cannot name the file.
      const files = state.kind === "ready" ? state.files : []
      const nameFiles = shown === null || shown.path === null || files.length > 1

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
                      <diff
                        diff={file.patch}
                        view={layout}
                        filetype={filetypeOf(file.path ?? state.target.path)}
                        fg={diffTheme.fg}
                        lineNumberFg={diffTheme.lineNumberFg}
                        lineNumberBg={diffTheme.lineNumberBg}
                        addedBg={diffTheme.addedBg}
                        removedBg={diffTheme.removedBg}
                        contextBg={diffTheme.contextBg}
                        addedSignColor={diffTheme.addedSignColor}
                        removedSignColor={diffTheme.removedSignColor}
                        addedLineNumberBg={diffTheme.addedLineNumberBg}
                        removedLineNumberBg={diffTheme.removedLineNumberBg}
                        selectionBg={diffTheme.selectionBg}
                        selectionFg={diffTheme.selectionFg}
                      />
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

    pane = ctx.panes.register({
      id: "diff",
      title: "Diff",
      component: DiffPane,
      placement: { column: 1, order: 10 },
    })

    return {
      current: () => target.get(),
      show: (next) => {
        interactionTicket += 1
        interaction.set({ kind: "passive" })
        target.set(next)
        // Reveal, never focus: `show` runs on every cursor move of the Pane the user is
        // driving. Only for a real target, so clearing a source cannot displace another tab.
        if (next !== null) pane.reveal()
      },
      openConflict: async (path) => {
        try {
          const session = await readConflict(path)
          if (session === null) {
            ctx.popups.notify(`${path} has no complete text-conflict markers`, "warning")
            return
          }
          interactionTicket += 1
          target.set({ kind: "workingTree", path })
          interaction.set({ kind: "conflict", path, session })
          pane.reveal()
          pane.focus()
        } catch (error) {
          ctx.popups.notify(`Open conflict: ${describeGitFailure(error)}`, "error")
        }
      },
      openStaging: async (path) => {
        try {
          const next = await loadStaging(path, "unstaged")
          interactionTicket += 1
          target.set({ kind: next.kind === "staging" && next.side === "staged" ? "staged" : "workingTree", path })
          interaction.set(next)
          pane.reveal()
          pane.focus()
        } catch (error) {
          ctx.popups.notify(`Open staging: ${describeGitFailure(error)}`, "error")
        }
      },
    }
  },
})
