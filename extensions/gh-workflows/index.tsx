/** @jsxImportSource @opentui/react */
import {
  createCell,
  defineExtension,
  option,
  toneColor,
  useCommand,
  useEvent,
  useGit,
  useListCursor,
  useScrollView,
  useTheme,
  type PaneProps,
} from "laziergit"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  detailRowIndexFor,
  detailRows,
  formatDuration,
  isLive,
  rowKey,
  runMeta,
  statusGlyph,
  tailLog,
  type DetailRow,
  type Job,
  type Run,
  type RunDetail,
} from "./model"

// Custom event so the palette command (registered in activate) can poke the
// pane component. Prefixed with the extension name (compile-enforced on emit);
// `void` payload means emit takes zero arguments.
declare module "laziergit" {
  interface EventMap {
    "gh-workflows.refresh": void
  }
}

const RUN_FIELDS =
  "databaseId,displayTitle,workflowName,status,conclusion,url,event,headBranch,createdAt,startedAt,updatedAt"

/**
 * What the pane is showing. One pane, three faces — `return` descends
 * runs → jobs → a job's log, `escape` climbs back out.
 */
type ActionsView = { kind: "runs" } | { kind: "run"; run: Run } | { kind: "log"; run: Run; job: Job }

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export default defineExtension({
  name: "gh-workflows",
  description: "GitHub Actions runs for the current branch (requires the `gh` CLI)",

  config: {
    limit: option.number({ default: 15, min: 1, max: 100, description: "How many runs to list" }),
    pollIntervalMs: option.number({
      default: 5000,
      min: 250,
      max: 120000,
      description: "How often to re-ask gh while a run is live",
    }),
    logLines: option.number({
      default: 200,
      min: 20,
      max: 5000,
      description: "How many log lines the job log view keeps",
    }),
  },

  activate(ctx) {
    // Cells rather than component state: the Layout unmounts a Pane it has tabbed away,
    // and where the user was — which run, which folds — has to outlive that.
    const view = createCell<ActionsView>({ kind: "runs" })
    const scope = createCell<"branch" | "all">("branch")
    const toggledSteps = createCell<ReadonlySet<number>>(new Set())

    async function gh(args: readonly string[]): Promise<{ ok: boolean; message: string }> {
      try {
        const res = await ctx.exec("gh", args)
        return { ok: res.exitCode === 0, message: res.stderr.trim() || res.stdout.trim() }
      } catch (cause) {
        // `exec` throws — it does not resolve with an exit code — when `gh` itself cannot
        // be spawned, and a machine without the GitHub CLI is an ordinary place to run.
        return { ok: false, message: messageOf(cause) }
      }
    }

    /**
     * A rerun or cancel in flight, keyed by the run's or job's id. The verb replaces the
     * row's status glyph while it runs, and the guard keeps a held-down key from firing
     * the same mutation twice.
     */
    function usePendingOps(refresh: () => void | Promise<void>) {
      const [pending, setPending] = useState<ReadonlyMap<number, string>>(new Map())
      const start = async (
        id: number,
        verb: string,
        work: () => Promise<{ ok: boolean; message: string }>,
        done: string,
      ) => {
        if (pending.has(id)) return
        setPending((prev) => new Map(prev).set(id, verb))
        const res = await work()
        setPending((prev) => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        if (!res.ok) return ctx.popups.notify(res.message || "gh failed", "error")
        ctx.popups.notify(done, "success")
        await refresh()
      }
      return { pending, start }
    }

    function RunsView({ focused }: PaneProps) {
      const theme = useTheme()
      const branch = useGit((s) => (s.head.kind === "onBranch" ? s.head.branch : null))
      const listScope = scope.use()
      const [runs, setRuns] = useState<readonly Run[]>([])
      const [error, setError] = useState<string | null>(null)
      const cursor = useListCursor({
        items: runs,
        idPrefix: "gh-workflows",
        noun: "run",
        query: {
          mode: "filter",
          fields: (run) => [run.workflowName, run.displayTitle, run.headBranch, run.event],
        },
      })
      // Monotonic ticket: a branch switch or scope toggle can leave two fetches in flight,
      // and gh does not answer in order. Only the newest may write state.
      const ticket = useRef(0)

      const refresh = useCallback(async () => {
        const issued = (ticket.current += 1)
        if (listScope === "branch" && branch === null) {
          setRuns([])
          setError(null)
          return
        }
        try {
          const res = await ctx.exec("gh", [
            "run",
            "list",
            ...(listScope === "branch" && branch !== null ? ["--branch", branch] : []),
            "--limit",
            String(ctx.config.limit),
            "--json",
            RUN_FIELDS,
          ])
          if (issued !== ticket.current) return
          if (res.exitCode !== 0) return setError(res.stderr.trim() || "gh failed")
          // No cursor reset: the cursor clamps itself to a shorter list, and a refresh
          // that returns the same runs should leave you where you were looking.
          const parsed = JSON.parse(res.stdout) as Run[]
          setError(null)
          setRuns(parsed)
        } catch (cause) {
          if (issued !== ticket.current) return
          setError(messageOf(cause))
        }
      }, [branch, listScope])

      useEffect(() => {
        void refresh()
      }, [refresh]) // initial load + every branch or scope change
      useEvent("gh-workflows.refresh", refresh) // palette command below

      // Poll only while something is moving; a settled list waits for the next mutation
      // or branch change instead of asking gh the same question forever.
      const live = runs.some((run) => isLive(run.status))
      useEffect(() => {
        if (!live) return
        const timer = setInterval(() => void refresh(), ctx.config.pollIntervalMs)
        return () => clearInterval(timer)
      }, [live, refresh])

      const ops = usePendingOps(refresh)

      useCommand({
        id: "gh-workflows.enter-run",
        title: "Show the run's jobs",
        hint: "jobs",
        keys: "return",
        run: () => {
          const run = cursor.selected
          if (run === undefined) return
          toggledSteps.set(new Set())
          view.set({ kind: "run", run })
        },
      })
      useCommand({
        id: "gh-workflows.open-run",
        title: "Open workflow run in browser",
        hint: "open",
        keys: "o",
        run: async () => {
          const run = cursor.selected
          if (run) await ctx.open(run.url)
        },
      })
      useCommand({
        id: "gh-workflows.rerun",
        title: "Rerun the run (failed jobs only when it failed)",
        hint: "rerun",
        keys: "r",
        run: () => {
          const run = cursor.selected
          if (run === undefined) return
          if (isLive(run.status)) return ctx.popups.notify("Run is still in progress", "warning")
          const failedOnly = run.conclusion === "failure"
          return ops.start(
            run.databaseId,
            "rerunning",
            () =>
              gh(
                failedOnly
                  ? ["run", "rerun", String(run.databaseId), "--failed"]
                  : ["run", "rerun", String(run.databaseId)],
              ),
            failedOnly ? "Rerunning failed jobs" : "Rerunning all jobs",
          )
        },
      })
      useCommand({
        id: "gh-workflows.rerun-all",
        title: "Rerun all jobs of the run",
        keys: "shift+r",
        run: () => {
          const run = cursor.selected
          if (run === undefined) return
          if (isLive(run.status)) return ctx.popups.notify("Run is still in progress", "warning")
          return ops.start(
            run.databaseId,
            "rerunning",
            () => gh(["run", "rerun", String(run.databaseId)]),
            "Rerunning all jobs",
          )
        },
      })
      useCommand({
        id: "gh-workflows.cancel",
        title: "Cancel the run",
        keys: "x",
        run: async () => {
          const run = cursor.selected
          if (run === undefined) return
          if (!isLive(run.status)) return ctx.popups.notify("Run already finished", "warning")
          const sure = await ctx.popups.confirm({
            title: `Cancel ${run.workflowName}?`,
            message: run.displayTitle,
            confirmLabel: "cancel run",
            danger: true,
          })
          if (!sure) return
          return ops.start(
            run.databaseId,
            "cancelling",
            () => gh(["run", "cancel", String(run.databaseId)]),
            "Cancellation requested",
          )
        },
      })
      useCommand({
        id: "gh-workflows.toggle-scope",
        title: "Toggle runs scope: current branch / all branches",
        hint: "scope",
        keys: "a",
        run: () => scope.set(scope.get() === "branch" ? "all" : "branch"),
      })

      if (error) return <text fg={theme.danger}>{error}</text>
      if (listScope === "branch" && branch === null) return <text fg={theme.textMuted}>detached HEAD — no runs</text>
      if (runs.length === 0)
        return <text fg={theme.textMuted}>{listScope === "branch" ? `no runs for ${branch}` : "no runs"}</text>

      const now = new Date()
      return (
        // Every prop here is load-bearing. `scrollRef` plus the rows' `rowId` keep the
        // selected row — the row every key acts on — inside the viewport. `flexBasis={0}`
        // stops the box being sized by its *content*: a list longer than the pane would
        // make it taller than the pane and paint over its neighbour instead of scrolling.
        // `focusable={false}` keeps it out of OpenTUI's single focus slot, which belongs
        // to the popup layer's inputs.
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {cursor.items.map((run, i) => {
            const verb = ops.pending.get(run.databaseId)
            const { glyph, tone } = statusGlyph(run.status, run.conclusion)
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
                    the bar already says, in the two columns a narrow pane can least spare. */}
                <span fg={verb === undefined ? toneColor(theme, tone) : theme.info}>
                  {verb === undefined ? glyph : "↻"}
                </span>{" "}
                {run.workflowName} — {run.displayTitle}
                <span fg={theme.textMuted}> · {verb ?? runMeta(run, listScope === "all", now)}</span>
              </text>
            )
          })}
        </scrollbox>
      )
    }

    function RunJobsView({ run, focused }: { run: Run; focused: boolean }) {
      const theme = useTheme()
      const toggled = toggledSteps.use()
      const [detail, setDetail] = useState<RunDetail | null>(null)
      const [error, setError] = useState<string | null>(null)
      const ticket = useRef(0)

      const refresh = useCallback(async () => {
        const issued = (ticket.current += 1)
        try {
          const res = await ctx.exec("gh", ["run", "view", String(run.databaseId), "--json", "status,conclusion,jobs"])
          if (issued !== ticket.current) return
          if (res.exitCode !== 0) return setError(res.stderr.trim() || "gh failed")
          setError(null)
          setDetail(JSON.parse(res.stdout) as RunDetail)
        } catch (cause) {
          if (issued !== ticket.current) return
          setError(messageOf(cause))
        }
      }, [run.databaseId])

      useEffect(() => {
        void refresh()
      }, [refresh])
      useEvent("gh-workflows.refresh", refresh)

      const live = detail !== null && isLive(detail.status)
      useEffect(() => {
        if (!live) return
        const timer = setInterval(() => void refresh(), ctx.config.pollIntervalMs)
        return () => clearInterval(timer)
      }, [live, refresh])

      const rows = useMemo(() => detailRows(detail?.jobs ?? [], toggled), [detail, toggled])
      const cursor = useListCursor({ items: rows, idPrefix: "gh-workflows.jobs", noun: "job" })

      /**
       * The cursor follows the row it was on, not the index: folding a job above the
       * cursor deletes several rows at once, and a poll can auto-expand one. Resolved
       * during render, so no frame lights the wrong row.
       */
      const anchor = useRef<{ rows: readonly DetailRow[]; key: string | null }>({ rows, key: null })
      const anchored =
        anchor.current.rows !== rows && anchor.current.key !== null ? detailRowIndexFor(rows, anchor.current.key) : -1
      const index = anchored === -1 ? cursor.index : anchored
      const selected = rows[index]
      useEffect(() => {
        if (index !== cursor.index) cursor.setIndex(index)
        anchor.current = { rows, key: selected === undefined ? null : rowKey(selected) }
      })

      const ops = usePendingOps(refresh)

      useCommand({
        id: "gh-workflows.jobs.back",
        title: "Back to the runs list",
        hint: "back",
        keys: "escape",
        run: () => view.set({ kind: "runs" }),
      })
      useCommand({
        id: "gh-workflows.jobs.toggle-steps",
        title: "Expand / collapse a job's steps, or open a step's log",
        keys: "return",
        run: () => {
          if (selected === undefined) return
          if (selected.kind === "step") return view.set({ kind: "log", run, job: selected.job })
          const next = new Set(toggled)
          if (!next.delete(selected.job.databaseId)) next.add(selected.job.databaseId)
          toggledSteps.set(next)
        },
      })
      useCommand({
        id: "gh-workflows.jobs.log",
        title: "View the job's log tail",
        hint: "log",
        keys: "l",
        run: () => {
          if (selected !== undefined) view.set({ kind: "log", run, job: selected.job })
        },
      })
      useCommand({
        id: "gh-workflows.jobs.retry",
        title: "Rerun this job and its dependents",
        hint: "retry",
        keys: "r",
        run: () => {
          if (selected === undefined) return
          const job = selected.job
          if (live) return ctx.popups.notify("Run is still in progress", "warning")
          return ops.start(
            job.databaseId,
            "rerunning",
            // GitHub reruns whole jobs, never single steps — `r` on a step retries its job.
            () => gh(["run", "rerun", "--job", String(job.databaseId)]),
            `Rerunning ${job.name}`,
          )
        },
      })
      useCommand({
        id: "gh-workflows.jobs.rerun-all",
        title: "Rerun all jobs of the run",
        keys: "shift+r",
        run: () => {
          if (live) return ctx.popups.notify("Run is still in progress", "warning")
          return ops.start(
            run.databaseId,
            "rerunning",
            () => gh(["run", "rerun", String(run.databaseId)]),
            "Rerunning all jobs",
          )
        },
      })
      useCommand({
        id: "gh-workflows.jobs.cancel",
        title: "Cancel the run",
        keys: "x",
        run: async () => {
          if (!live) return ctx.popups.notify("Run already finished", "warning")
          const sure = await ctx.popups.confirm({
            title: `Cancel ${run.workflowName}?`,
            message: run.displayTitle,
            confirmLabel: "cancel run",
            danger: true,
          })
          if (!sure) return
          return ops.start(
            run.databaseId,
            "cancelling",
            () => gh(["run", "cancel", String(run.databaseId)]),
            "Cancellation requested",
          )
        },
      })
      useCommand({
        id: "gh-workflows.jobs.open",
        title: "Open job in browser",
        keys: "o",
        run: async () => {
          await ctx.open(selected?.job.url ?? run.url)
        },
      })

      const runNow = detail ?? run
      const head = statusGlyph(runNow.status, runNow.conclusion)
      const now = new Date()
      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          {/* Outside the scrollbox: what the Pane is drilled into must not scroll away. */}
          <text wrapMode="none" fg={theme.textMuted}>
            <span fg={toneColor(theme, head.tone)}>{head.glyph}</span> <span fg={theme.accent}>{run.workflowName}</span>{" "}
            — {run.displayTitle}
          </text>
          {error !== null ? (
            <text fg={theme.danger}>{error}</text>
          ) : detail === null ? (
            <text fg={theme.textMuted}>loading jobs…</text>
          ) : rows.length === 0 ? (
            <text fg={theme.textMuted}>no jobs</text>
          ) : (
            <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
              {rows.map((row, i) => {
                const glyphOf =
                  row.kind === "job"
                    ? statusGlyph(row.job.status, row.job.conclusion)
                    : statusGlyph(row.step.status, row.step.conclusion)
                const verb = row.kind === "job" ? ops.pending.get(row.job.databaseId) : undefined
                const duration =
                  row.kind === "job"
                    ? formatDuration(row.job.startedAt, row.job.completedAt, now)
                    : formatDuration(row.step.startedAt, row.step.completedAt, now)
                const trailer = verb ?? duration
                return (
                  <text
                    key={rowKey(row)}
                    id={cursor.rowId(i)}
                    wrapMode="none"
                    bg={i === index && focused ? theme.selection : undefined}
                  >
                    {row.kind === "step" ? "  " : ""}
                    <span fg={verb === undefined ? toneColor(theme, glyphOf.tone) : theme.info}>
                      {verb === undefined ? glyphOf.glyph : "↻"}
                    </span>{" "}
                    {row.kind === "job" ? row.job.name : row.step.name}
                    {trailer === null ? null : <span fg={theme.textMuted}> · {trailer}</span>}
                  </text>
                )
              })}
            </scrollbox>
          )}
        </box>
      )
    }

    function JobLogView({ run, job }: { run: Run; job: Job }) {
      const theme = useTheme()
      const [lines, setLines] = useState<readonly string[] | null>(null)
      const [error, setError] = useState<string | null>(null)
      const scroll = useScrollView()
      const ticket = useRef(0)

      const refresh = useCallback(async () => {
        const issued = (ticket.current += 1)
        try {
          // `--log-failed` for a failed job: only the failing steps' output, which is
          // what the tail should land on. Anything else gets the whole job log.
          const failed = job.conclusion === "failure"
          const res = await ctx.exec("gh", [
            "run",
            "view",
            "--job",
            String(job.databaseId),
            failed ? "--log-failed" : "--log",
          ])
          if (issued !== ticket.current) return
          if (res.exitCode !== 0) return setError(res.stderr.trim() || "gh failed")
          setError(null)
          setLines(tailLog(res.stdout, ctx.config.logLines))
        } catch (cause) {
          if (issued !== ticket.current) return
          setError(messageOf(cause))
        }
      }, [job.databaseId, job.conclusion])

      useEffect(() => {
        void refresh()
      }, [refresh])
      useEvent("gh-workflows.refresh", refresh)

      useEffect(() => {
        // The tail's end is where the failure is; start there, scroll up to the cause.
        if (lines !== null) scroll.scrollTo("end")
      }, [lines, scroll])

      useCommand({
        id: "gh-workflows.log.back",
        title: "Back to the run's jobs",
        hint: "back",
        keys: "escape",
        run: () => view.set({ kind: "run", run }),
      })
      useCommand({
        id: "gh-workflows.log.open",
        title: "Open job in browser",
        hint: "open",
        keys: "o",
        run: () => ctx.open(job.url),
      })
      // Hidden like `useListCursor`'s own motion keys: every Pane has them, and repeating
      // them in the cheat sheet buries the rest.
      useCommand({
        id: "gh-workflows.log.down",
        title: "Scroll down",
        keys: ["j", "down"],
        hidden: true,
        run: () => scroll.scrollBy(1),
      })
      useCommand({
        id: "gh-workflows.log.up",
        title: "Scroll up",
        keys: ["k", "up"],
        hidden: true,
        run: () => scroll.scrollBy(-1),
      })
      useCommand({
        id: "gh-workflows.log.page-down",
        title: "Page down",
        keys: ["ctrl+d", "pagedown"],
        run: () => scroll.scrollBy(scroll.viewportRows() / 2),
      })
      useCommand({
        id: "gh-workflows.log.page-up",
        title: "Page up",
        keys: ["ctrl+u", "pageup"],
        run: () => scroll.scrollBy(-scroll.viewportRows() / 2),
      })
      useCommand({
        id: "gh-workflows.log.top",
        title: "Top of log",
        keys: ["g", "home"],
        run: () => scroll.scrollTo("start"),
      })
      useCommand({
        id: "gh-workflows.log.bottom",
        title: "End of log",
        // `shift+g`, not `G`: the parser lowercases a bare letter, colliding with `g` above.
        keys: ["shift+g", "end"],
        run: () => scroll.scrollTo("end"),
      })

      const head = statusGlyph(job.status, job.conclusion)
      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <text wrapMode="none" fg={theme.textMuted}>
            <span fg={toneColor(theme, head.tone)}>{head.glyph}</span> <span fg={theme.accent}>{job.name}</span> — log
          </text>
          {error !== null ? (
            <text fg={theme.danger}>{error}</text>
          ) : lines === null ? (
            <text fg={theme.textMuted}>loading log…</text>
          ) : lines.length === 0 ? (
            <text fg={theme.textMuted}>empty log</text>
          ) : (
            <scrollbox ref={scroll.ref} focusable={false} flexGrow={1} flexBasis={0}>
              {lines.map((line, i) => (
                <text key={i} wrapMode="none">
                  {line === "" ? " " : line}
                </text>
              ))}
            </scrollbox>
          )}
        </box>
      )
    }

    // Pane components are defined inside activate so they can close over `ctx`.
    function ActionsPane(props: PaneProps) {
      const current = view.use()
      if (current.kind === "run") return <RunJobsView run={current.run} focused={props.focused} />
      if (current.kind === "log") return <JobLogView run={current.run} job={current.job} />
      return <RunsView {...props} />
    }

    const pane = ctx.panes.register({
      id: "gh-workflows",
      title: "Actions",
      component: ActionsPane,
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
