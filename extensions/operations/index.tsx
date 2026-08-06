/** @jsxImportSource @opentui/react */
import {
  defineExtension,
  describeGitFailure,
  GitError,
  isConflicted,
  option,
  useGit,
  useTheme,
  type GitOperation,
  type GitOperationKind,
} from "laziergit"

const labels: Readonly<Record<GitOperationKind, string>> = {
  merge: "merge",
  rebase: "rebase",
  cherryPick: "cherry-pick",
  revert: "revert",
}

function shellWord(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

const noOpEditor = [process.execPath, "-e", "void 0", "--"].map(shellWord).join(" ")
const continueEnv = Object.freeze({
  GIT_EDITOR: noOpEditor,
  GIT_SEQUENCE_EDITOR: noOpEditor,
  EDITOR: noOpEditor,
  VISUAL: noOpEditor,
})

function commandName(kind: GitOperationKind): string {
  return kind === "cherryPick" ? "cherry-pick" : kind
}

function conflictCount(operation: GitOperation, files: readonly { readonly kind: string }[]): number {
  return operation.effective === null ? 0 : files.filter((file) => file.kind === "conflicted").length
}

function hasConflictMarkers(contents: string): boolean {
  let start = false
  for (const line of contents.split(/(?<=\n)/)) {
    const bare = line.endsWith("\n") ? line.slice(0, -1).replace(/\r$/, "") : line.replace(/\r$/, "")
    if (/^<{7,}(?: |$)/.test(bare)) start = true
    if (start && /^>{7,}(?: |$)/.test(bare)) return true
  }
  return false
}

function isEmptyStep(error: GitError): boolean {
  const message = `${error.stderr}\n${error.stdout}`
  return (
    message.includes("No changes - did you forget to use 'git add'") ||
    message.includes("The previous cherry-pick is now empty") ||
    message.includes("previous cherry-pick is now empty")
  )
}

export default defineExtension({
  name: "operations",
  description: "Continue, abort, skip, and recover interrupted Git operations",

  config: {
    autoStageResolvedConflicts: option.boolean({
      default: true,
      description: "Stage text conflicts once their markers are gone and offer to continue operations started here",
    }),
  },

  activate(ctx) {
    let checkingResolvedFiles = false
    let continuePromptOpen = false
    const observedInlineConflicts = new Set<string>()

    const fail = (verb: string, error: unknown): void => {
      ctx.popups.notify(`${verb}: ${describeGitFailure(error)}`, "error")
    }

    function currentKind(): GitOperationKind | null {
      return ctx.git.state.operation.effective
    }

    function unresolved(): number {
      return conflictCount(ctx.git.state.operation, ctx.git.state.status.files)
    }

    async function runChoice(choice: "continue" | "abort" | "skip"): Promise<void> {
      const kind = currentKind()
      if (kind === null) {
        ctx.popups.notify("No merge, rebase, cherry-pick, or revert is in progress", "warning")
        return
      }
      if (choice === "continue" && unresolved() > 0) {
        ctx.popups.notify("Resolve and stage every conflict before continuing", "warning")
        return
      }

      const command = commandName(kind)
      try {
        await ctx.git.raw([command, `--${choice}`], { env: continueEnv })
        ctx.popups.notify(
          `${labels[kind]} ${choice === "abort" ? "aborted" : choice === "skip" ? "advanced" : "continued"}`,
          "success",
        )
      } catch (error) {
        if (choice === "continue" && error instanceof GitError && isEmptyStep(error) && kind !== "merge") {
          try {
            await ctx.git.raw([command, "--skip"], { env: continueEnv })
            ctx.popups.notify(`Skipped empty ${labels[kind]} step`, "success")
            return
          } catch (skipError) {
            fail(`Skip ${labels[kind]}`, skipError)
            return
          }
        }
        fail(`${choice[0]?.toUpperCase() ?? ""}${choice.slice(1)} ${labels[kind]}`, error)
      }
    }

    async function abort(): Promise<void> {
      const kind = currentKind()
      if (kind === null) return
      const confirmed = await ctx.popups.confirm({
        title: `Abort ${labels[kind]}?`,
        message: `Discard the in-progress ${labels[kind]} and restore its starting state.`,
        confirmLabel: "abort",
        danger: true,
      })
      if (confirmed) await runChoice("abort")
    }

    async function viewConflicts(): Promise<void> {
      try {
        await ctx.commands.execute("files.focus-conflict")
      } catch {
        await ctx.commands.execute("files.focus")
      }
    }

    async function openMenu(): Promise<void> {
      const kind = currentKind()
      if (kind === null) return
      const items = [
        { label: "continue", value: "continue" as const },
        { label: "abort…", value: "abort" as const },
        ...(kind === "merge" ? [] : [{ label: "skip", value: "skip" as const }]),
        ...(unresolved() === 0 ? [] : [{ label: "view conflicts", value: "view" as const }]),
      ]
      const choice = await ctx.popups.select({
        title: `${labels[kind][0]?.toUpperCase()}${labels[kind].slice(1)} options`,
        items,
      })
      if (choice === "continue" || choice === "skip") await runChoice(choice)
      else if (choice === "abort") await abort()
      else if (choice === "view") await viewConflicts()
    }

    const menuCommand = ctx.commands.register({
      id: "operations.menu",
      title: "View current Git operation options",
      keys: "m",
      when: () => currentKind() !== null,
      run: openMenu,
    })
    ctx.git.subscribe(
      (state) => state.operation,
      () => menuCommand.refresh(),
    )

    function OperationSegment() {
      const theme = useTheme()
      const kind = useGit((state) => state.operation.effective)
      if (kind === null) return null
      return <text wrapMode="none" fg={theme.warning}>{`${labels[kind]} in progress`}</text>
    }
    ctx.statusline.register({ id: "operations", component: OperationSegment, align: "left", priority: 100 })

    async function inspectResolvedFiles(): Promise<void> {
      if (checkingResolvedFiles || !ctx.config.autoStageResolvedConflicts) return
      checkingResolvedFiles = true
      try {
        const conflicted = ctx.git.state.status.files.filter(isConflicted)
        for (const file of conflicted) {
          let contents: string
          try {
            contents = await Bun.file(`${ctx.git.root}/${file.path}`).text()
          } catch {
            continue
          }
          if (contents.includes("\0")) continue
          if (hasConflictMarkers(contents)) {
            observedInlineConflicts.add(file.path)
            continue
          }
          if (!observedInlineConflicts.has(file.path)) continue
          observedInlineConflicts.delete(file.path)
          try {
            await ctx.git.stage([file.path])
          } catch (error) {
            fail(`Auto-stage ${file.path}`, error)
          }
        }
      } finally {
        checkingResolvedFiles = false
      }
    }

    async function offerContinue(kind: GitOperationKind): Promise<void> {
      if (continuePromptOpen || !ctx.config.autoStageResolvedConflicts) return
      continuePromptOpen = true
      try {
        const confirmed = await ctx.popups.confirm({
          title: "All conflicts resolved",
          message: `Continue the ${labels[kind]}?`,
          confirmLabel: "continue",
        })
        if (!confirmed) return
        const current = ctx.git.state.operation
        if (current.effective !== kind || conflictCount(current, ctx.git.state.status.files) > 0) return
        await runChoice("continue")
      } finally {
        continuePromptOpen = false
      }
    }

    let previousConflictCount = unresolved()
    ctx.events.on("git.refreshed", async ({ state }) => {
      const kind = state.operation.effective
      const conflicts = conflictCount(state.operation, state.status.files)

      if (kind !== null && conflicts === 0 && previousConflictCount > 0 && state.operation.initiatedHere) {
        void offerContinue(kind)
      }

      previousConflictCount = conflicts
      await inspectResolvedFiles()
    })

    // The initial snapshot may already contain markers. Record them before the first external
    // edit so a later refresh can distinguish resolution from a markerless non-text conflict.
    void inspectResolvedFiles()
  },
})
