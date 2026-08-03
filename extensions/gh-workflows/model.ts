import type { Tone } from "laziergit"

/** One `gh run list --json` row. gh's status/conclusion sets grow; compare, don't exhaust. */
export interface Run {
  databaseId: number
  displayTitle: string
  workflowName: string
  /** "queued" | "in_progress" | "completed" | "waiting" | ... */
  status: string
  /** "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "" | ... */
  conclusion: string
  url: string
  event: string
  headBranch: string
  createdAt: string
  startedAt: string
  updatedAt: string
}

/** A fresh copy ordered by creation time, with malformed dates parked at the end. */
export function newestRunsFirst(runs: readonly Run[]): readonly Run[] {
  const created = (run: Run): number => {
    const timestamp = Date.parse(run.createdAt)
    return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
  }
  return [...runs].sort((left, right) => created(right) - created(left))
}

export interface Step {
  number: number
  name: string
  status: string
  /** gh emits `null` for steps that have not concluded. */
  conclusion: string | null
  startedAt?: string
  completedAt?: string
}

export interface Job {
  databaseId: number
  name: string
  status: string
  conclusion: string | null
  url: string
  startedAt?: string
  completedAt?: string
  steps?: readonly Step[]
}

/** The slice of `gh run view --json status,conclusion,jobs` the detail view reads. */
export interface RunDetail {
  status: string
  conclusion: string
  jobs: readonly Job[]
}

export interface StatusGlyph {
  glyph: string
  tone: Tone
}

const QUEUED = new Set(["queued", "waiting", "pending", "requested"])

export function statusGlyph(status: string, conclusion: string | null): StatusGlyph {
  if (QUEUED.has(status)) return { glyph: "○", tone: "muted" }
  if (status !== "completed") return { glyph: "●", tone: "warning" }
  if (conclusion === "success") return { glyph: "✓", tone: "success" }
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure")
    return { glyph: "✗", tone: "danger" }
  return { glyph: "-", tone: "muted" }
}

export function isLive(status: string): boolean {
  return status !== "completed"
}

function seconds(from: string | undefined, to: string | undefined, now: Date): number | null {
  if (from === undefined || from === "") return null
  const start = Date.parse(from)
  if (Number.isNaN(start)) return null
  const end = to === undefined || to === "" ? now.getTime() : Date.parse(to)
  if (Number.isNaN(end)) return null
  return Math.max(0, Math.round((end - start) / 1000))
}

/** "42s", "3m12s", "2h5m" — elapsed so far when `completedAt` is missing. */
export function formatDuration(
  startedAt: string | undefined,
  completedAt: string | undefined,
  now: Date,
): string | null {
  const total = seconds(startedAt, completedAt, now)
  if (total === null) return null
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const rest = total % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
}

/** "5s", "3m", "2h", "4d" — coarse on purpose; the list repaints only on poll ticks. */
export function formatAge(createdAt: string, now: Date): string | null {
  const total = seconds(createdAt, undefined, now)
  if (total === null) return null
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m`
  if (total < 86400) return `${Math.floor(total / 3600)}h`
  return `${Math.floor(total / 86400)}d`
}

/** The muted trailer after a run's title: branch (all-branches mode only), event, timing. */
export function runMeta(run: Run, showBranch: boolean, now: Date): string {
  const timing = isLive(run.status) ? formatAge(run.createdAt, now) : formatDuration(run.startedAt, run.updatedAt, now)
  const parts = [...(showBranch ? [run.headBranch] : []), run.event, ...(timing === null ? [] : [timing])]
  return parts.filter((part) => part !== "").join(" · ")
}

/**
 * A job's steps start visible when there is something to look at — the job failed or is
 * still running — and folded when it succeeded. `toggled` records the user's flips
 * against that default, so a poll that changes a job's outcome does not undo them.
 */
export function expandedByDefault(job: Job): boolean {
  if (isLive(job.status)) return true
  return job.conclusion === "failure" || job.conclusion === "timed_out" || job.conclusion === "startup_failure"
}

export function isExpanded(job: Job, toggled: ReadonlySet<number>): boolean {
  return expandedByDefault(job) !== toggled.has(job.databaseId)
}

export interface JobRow {
  kind: "job"
  job: Job
}

export interface StepRow {
  kind: "step"
  job: Job
  step: Step
}

export type DetailRow = JobRow | StepRow

export function detailRows(jobs: readonly Job[], toggled: ReadonlySet<number>): readonly DetailRow[] {
  return jobs.flatMap((job): readonly DetailRow[] => [
    { kind: "job", job },
    ...(isExpanded(job, toggled) ? (job.steps ?? []).map((step): StepRow => ({ kind: "step", job, step })) : []),
  ])
}

export function rowKey(row: DetailRow): string {
  return row.kind === "job" ? `job.${row.job.databaseId}` : `step.${row.job.databaseId}.${row.step.number}`
}

/** Exact row, else the step's job row (its steps just folded), else -1. */
export function detailRowIndexFor(rows: readonly DetailRow[], key: string): number {
  const exact = rows.findIndex((row) => rowKey(row) === key)
  if (exact !== -1 || !key.startsWith("step.")) return exact
  const jobKey = `job.${key.split(".")[1]}`
  return rows.findIndex((row) => rowKey(row) === jobKey)
}

/**
 * The last `limit` lines of a `gh run view --log` answer, without the `job\tstep\t`
 * prefix gh puts on every line — the view already names both.
 */
export function tailLog(raw: string, limit: number): readonly string[] {
  const lines = raw.replace(/\r/g, "").split("\n")
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.slice(Math.max(0, lines.length - limit)).map((line) => {
    const parts = line.split("\t")
    return parts.length >= 3 ? parts.slice(2).join("\t") : line
  })
}
