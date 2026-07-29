/** @jsxImportSource @opentui/react */
import {
  defineExtension,
  option,
  useCommand,
  useEvent,
  useGit,
  useListCursor,
  useTheme,
  type PaneProps,
  type Theme,
} from "laziergit"
import { useCallback, useEffect, useState } from "react"

interface Run {
  databaseId: number
  displayTitle: string
  workflowName: string
  /** "queued" | "in_progress" | "completed" | "waiting" | ... — gh's set grows; compare, don't exhaust */
  status: string
  /** "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "" | ... */
  conclusion: string
  url: string
}

// Custom event so the palette command (registered in activate) can poke the
// pane component. Prefixed with the extension name (compile-enforced on emit);
// `void` payload means emit takes zero arguments.
declare module "laziergit" {
  interface EventMap {
    "gh-workflows.refresh": void
  }
}

function icon(run: Run, theme: Theme): { glyph: string; color: string } {
  if (run.status !== "completed") return { glyph: "●", color: theme.warning }
  if (run.conclusion === "success") return { glyph: "✓", color: theme.success }
  if (run.conclusion === "failure") return { glyph: "✗", color: theme.danger }
  return { glyph: "-", color: theme.textMuted }
}

export default defineExtension({
  name: "gh-workflows",
  description: "GitHub Actions runs for the current branch (requires the `gh` CLI)",

  config: {
    limit: option.number({ default: 15, min: 1, max: 100, description: "How many runs to list" }),
  },

  activate(ctx) {
    // Pane components are defined inside activate so they can close over `ctx`.
    function WorkflowRunsPane({ focused }: PaneProps) {
      const theme = useTheme()
      const branch = useGit((s) => (s.head.kind === "onBranch" ? s.head.branch : null))
      const [runs, setRuns] = useState<readonly Run[]>([])
      const [error, setError] = useState<string | null>(null)
      // j/k/g/G, clamped to the list, in one line — every list pane wants the same
      // cursor, so it is API rather than four copies of the same useState (§5.11).
      const cursor = useListCursor({ items: runs, idPrefix: "gh-workflows", noun: "run" })

      const refresh = useCallback(async () => {
        if (!branch) return setRuns([])
        try {
          const res = await ctx.exec("gh", [
            "run",
            "list",
            "--branch",
            branch,
            "--limit",
            String(ctx.config.limit),
            "--json",
            "databaseId,displayTitle,workflowName,status,conclusion,url",
          ])
          if (res.exitCode !== 0) return setError(res.stderr.trim() || "gh failed")
          // No cursor reset: the cursor clamps itself to a shorter list, and a refresh
          // that returns the same runs should leave you where you were looking.
          const parsed = JSON.parse(res.stdout) as Run[]
          setError(null)
          setRuns(parsed)
        } catch (cause) {
          // `exec` throws — it does not resolve with an exit code — when `gh` itself cannot
          // be spawned, and a machine without the GitHub CLI is an ordinary place to run.
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [branch])

      useEffect(() => {
        void refresh()
      }, [refresh]) // initial load + every branch change
      useEvent("gh-workflows.refresh", refresh) // palette command below

      // A pane-scoped command: active only while this pane is focused, disposed on
      // unmount, listed in the cheat sheet. Also a palette entry — running it from the
      // palette focuses this pane first (focus-then-run), so the selection it acts on
      // is the visible one.
      useCommand({
        id: "gh-workflows.open-run",
        title: "Open workflow run in browser",
        // One registration, three surfaces: the key, the cheat sheet row, and — because it
        // carries a `hint` — the hint bar while this pane is focused (§1.10).
        hint: "open",
        keys: "o",
        run: async () => {
          const run = cursor.selected
          if (run) await ctx.open(run.url)
        },
      })

      if (error) return <text fg={theme.danger}>{error}</text>
      if (!branch) return <text fg={theme.textMuted}>detached HEAD — no runs</text>
      if (runs.length === 0) return <text fg={theme.textMuted}>no runs for {branch}</text>

      return (
        // Every prop here is load-bearing. `scrollRef` plus the rows' `rowId` keep the
        // selected row — the row every key acts on — inside the viewport. `flexBasis={0}`
        // stops the box being sized by its *content*: a list longer than the pane would
        // make it taller than the pane and paint over its neighbour instead of scrolling.
        // `focusable={false}` keeps it out of OpenTUI's single focus slot, which belongs
        // to the popup layer's inputs.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {runs.map((run, i) => {
            const { glyph, color } = icon(run, theme)
            const selected = i === cursor.index
            return (
              // `wrapMode="none"` is not optional decoration: without it a long run title
              // reflows over two lines and the list stops being a list (§1.8).
              <text
                key={run.databaseId}
                id={cursor.rowId(i)}
                wrapMode="none"
                bg={selected && focused ? theme.selection : undefined}
              >
                {/* The highlight is the whole of the cursor — no `❯` beside it. Every
                    bundled list Pane made the same trade: a marker said a second time what
                    the bar already says, in the two columns a narrow pane can least spare.
                    It buys a real cost, which is that an unfocused pane marks nothing. */}
                <span fg={color}>{glyph}</span> {run.workflowName} — {run.displayTitle}
              </text>
            )
          })}
        </scrollbox>
      )
    }

    const pane = ctx.panes.register({
      id: "gh-workflows",
      title: "Actions",
      component: WorkflowRunsPane,
      // Below stash rather than tied with it, so the sidebar reads files, branches,
      // commits, stash, actions. Hint only; the user's Layout wins.
      placement: { column: 0, order: 60 },
    })

    ctx.commands.register({
      id: "gh-workflows.refresh",
      title: "GitHub Actions: refresh runs",
      run: () => {
        pane.focus()
        ctx.events.emit("gh-workflows.refresh") // void payload → zero args
      },
    })
  },
})
