import { expect, it } from "bun:test"

import {
  detailRowIndexFor,
  detailRows,
  expandedByDefault,
  formatAge,
  formatDuration,
  isExpanded,
  rowKey,
  runMeta,
  statusGlyph,
  tailLog,
  type Job,
  type Run,
  type Step,
} from "./model"

function step(number: number, conclusion: string | null = "success", status = "completed"): Step {
  return { number, name: `step ${number}`, status, conclusion }
}

function job(id: number, conclusion: string | null, status = "completed", steps: readonly Step[] = []): Job {
  return { databaseId: id, name: `job ${id}`, status, conclusion, url: `https://example.invalid/job/${id}`, steps }
}

const now = new Date("2026-07-29T12:00:00Z")

it("maps status and conclusion to one glyph each", () => {
  expect(statusGlyph("queued", "")).toEqual({ glyph: "○", tone: "muted" })
  expect(statusGlyph("waiting", "")).toEqual({ glyph: "○", tone: "muted" })
  expect(statusGlyph("in_progress", "")).toEqual({ glyph: "●", tone: "warning" })
  expect(statusGlyph("completed", "success")).toEqual({ glyph: "✓", tone: "success" })
  expect(statusGlyph("completed", "failure")).toEqual({ glyph: "✗", tone: "danger" })
  expect(statusGlyph("completed", "timed_out")).toEqual({ glyph: "✗", tone: "danger" })
  expect(statusGlyph("completed", "cancelled")).toEqual({ glyph: "-", tone: "muted" })
  expect(statusGlyph("completed", null)).toEqual({ glyph: "-", tone: "muted" })
})

it("formats durations across the unit boundaries", () => {
  expect(formatDuration("2026-07-29T11:59:18Z", "2026-07-29T12:00:00Z", now)).toBe("42s")
  expect(formatDuration("2026-07-29T11:56:48Z", "2026-07-29T12:00:00Z", now)).toBe("3m12s")
  expect(formatDuration("2026-07-29T11:57:00Z", "2026-07-29T12:00:00Z", now)).toBe("3m")
  expect(formatDuration("2026-07-29T09:55:00Z", "2026-07-29T12:00:00Z", now)).toBe("2h5m")
  expect(formatDuration("2026-07-29T11:59:00Z", undefined, now)).toBe("1m")
  expect(formatDuration(undefined, undefined, now)).toBeNull()
  expect(formatDuration("not a date", undefined, now)).toBeNull()
})

it("formats ages coarsely", () => {
  expect(formatAge("2026-07-29T11:59:55Z", now)).toBe("5s")
  expect(formatAge("2026-07-29T11:57:00Z", now)).toBe("3m")
  expect(formatAge("2026-07-29T10:00:00Z", now)).toBe("2h")
  expect(formatAge("2026-07-25T12:00:00Z", now)).toBe("4d")
})

it("builds a run's meta trailer with and without the branch", () => {
  const run: Run = {
    databaseId: 1,
    displayTitle: "t",
    workflowName: "w",
    status: "completed",
    conclusion: "success",
    url: "",
    event: "push",
    headBranch: "main",
    createdAt: "2026-07-29T11:59:00Z",
    startedAt: "2026-07-29T11:59:00Z",
    updatedAt: "2026-07-29T11:59:42Z",
  }
  expect(runMeta(run, false, now)).toBe("push · 42s")
  expect(runMeta(run, true, now)).toBe("main · push · 42s")
  expect(runMeta({ ...run, status: "in_progress" }, false, now)).toBe("push · 1m")
})

it("starts failed and live jobs expanded, successful ones folded", () => {
  expect(expandedByDefault(job(1, "failure"))).toBe(true)
  expect(expandedByDefault(job(2, null, "in_progress"))).toBe(true)
  expect(expandedByDefault(job(3, "success"))).toBe(false)
  expect(expandedByDefault(job(4, "skipped"))).toBe(false)
})

it("toggling flips against the default, so a poll does not undo the user", () => {
  const failed = job(1, "failure")
  const passed = job(2, "success")
  expect(isExpanded(failed, new Set())).toBe(true)
  expect(isExpanded(failed, new Set([1]))).toBe(false)
  expect(isExpanded(passed, new Set([2]))).toBe(true)
})

it("flattens jobs to rows with steps only under expanded jobs", () => {
  const jobs = [
    job(1, "failure", "completed", [step(1, "success"), step(2, "failure")]),
    job(2, "success", "completed", [step(1)]),
  ]
  const rows = detailRows(jobs, new Set())
  expect(rows.map(rowKey)).toEqual(["job.1", "step.1.1", "step.1.2", "job.2"])
  expect(detailRows(jobs, new Set([2])).map(rowKey)).toEqual(["job.1", "step.1.1", "step.1.2", "job.2", "step.2.1"])
})

it("re-anchors a folded step to its job row", () => {
  const jobs = [job(1, "failure", "completed", [step(1), step(2)]), job(2, "success")]
  const folded = detailRows(jobs, new Set([1]))
  expect(detailRowIndexFor(folded, "step.1.2")).toBe(0)
  expect(detailRowIndexFor(folded, "job.2")).toBe(1)
  expect(detailRowIndexFor(folded, "job.9")).toBe(-1)
})

it("tails a log and strips gh's job and step prefixes", () => {
  const raw = ["build\tCheckout\tline one", "build\tCheckout\tline two", "plain line", ""].join("\n")
  expect(tailLog(raw, 10)).toEqual(["line one", "line two", "plain line"])
  expect(tailLog(raw, 2)).toEqual(["line two", "plain line"])
  expect(tailLog("a\tb\tkeep\textra tabs", 10)).toEqual(["keep\textra tabs"])
})
