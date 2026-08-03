import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"
import { act } from "react"

import { gitIsolationEnv } from "../git/test-repo"
import {
  createHarness,
  frame,
  highlighted,
  installHarnessLifecycle,
  press,
  pressEscape,
  refreshGit,
  renderApp,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

/** The shipped Extension itself, not a copy — the same directory `main.tsx` loads. */
const ghWorkflowsExtension = resolve(import.meta.dir, "..", "..", "..", "..", "extensions", "gh-workflows")

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

/** Just enough `files` to hold initial focus, so the Actions Pane is a Pane among others. */
const filesSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "files",
    activate(ctx) {
      function FilesPane() {
        return <text content="files pane" />
      }
      ctx.panes.register({ id: "files", title: "Files", component: FilesPane, placement: { column: 0, order: 20 } })
    },
  })
`

/**
 * A `gh` on PATH whose answers the test controls: it logs each argv line to `gh.log` and
 * dispatches on the subcommand — `run list` answers `runs-<branch>.json` (empty branch for
 * the all-branches scope), `run view` answers `view-<run-id>.json` or `log-<job-id>.txt`
 * when a log flag is present, and `run rerun` / `run cancel` just succeed. `open`/`xdg-open`
 * beside it catch the pane's browser hand-off, which must never reach the real one.
 */
interface GhStub {
  readonly bin: string
  readonly openLog: string
  setRuns(branch: string, runs: readonly unknown[]): Promise<void>
  delayRuns(branch: string, seconds: number): Promise<void>
  setDetail(runId: number, detail: unknown): Promise<void>
  setLog(jobId: number, text: string): Promise<void>
  replace(body: string): Promise<void>
  calls(): Promise<readonly string[]>
  opened(): Promise<string>
}

async function installGh(harness: Harness): Promise<GhStub> {
  const bin = join(harness.directory, "bin")
  await mkdir(bin, { recursive: true })
  const log = join(bin, "gh.log")
  const openLog = join(bin, "opened.log")

  const gh = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    'branch=""',
    'job=""',
    "wantlog=0",
    'prev=""',
    'for arg in "$@"; do',
    '  case "$prev" in',
    '    --branch) branch="$arg" ;;',
    '    --job) job="$arg" ;;',
    "  esac",
    '  case "$arg" in',
    "    --log|--log-failed) wantlog=1 ;;",
    "  esac",
    '  prev="$arg"',
    "done",
    'case "$1 $2" in',
    '  "run list")',
    `    if [ -f "${bin}/delay-$branch" ]; then sleep "$(cat "${bin}/delay-$branch")"; fi`,
    `    exec cat "${bin}/runs-$branch.json" ;;`,
    '  "run view")',
    `    if [ "$wantlog" = 1 ]; then exec cat "${bin}/log-$job.txt"; fi`,
    `    exec cat "${bin}/view-$3.json" ;;`,
    '  "run rerun"|"run cancel") exit 0 ;;',
    "esac",
    "exit 1",
    "",
  ].join("\n")
  const open = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${openLog}"\n`

  await Promise.all([
    writeFile(join(bin, "gh"), gh, { mode: 0o755 }),
    writeFile(join(bin, "open"), open, { mode: 0o755 }),
    writeFile(join(bin, "xdg-open"), open, { mode: 0o755 }),
  ])
  process.env.PATH = `${bin}${delimiter}${originalPath}`

  return {
    bin,
    openLog,
    setRuns: (branch, runs) => writeFile(join(bin, `runs-${branch}.json`), JSON.stringify(runs)),
    delayRuns: (branch, seconds) => writeFile(join(bin, `delay-${branch}`), String(seconds)),
    setDetail: (runId, detail) => writeFile(join(bin, `view-${runId}.json`), JSON.stringify(detail)),
    setLog: (jobId, text) => writeFile(join(bin, `log-${jobId}.txt`), text),
    replace: (body) => writeFile(join(bin, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 }),
    calls: async () => (await Bun.file(log).text()).trim().split("\n"),
    opened: async () => (await Bun.file(openLog).text()).trim(),
  }
}

function run(id: number, title: string, status: string, conclusion: string, extra: Record<string, unknown> = {}) {
  return {
    databaseId: id,
    displayTitle: title,
    workflowName: "verify",
    status,
    conclusion,
    url: `https://example.invalid/${id}`,
    event: "push",
    headBranch: "main",
    createdAt: "2026-07-29T10:00:00Z",
    startedAt: "2026-07-29T10:00:00Z",
    updatedAt: "2026-07-29T10:00:42Z",
    ...extra,
  }
}

function step(number: number, name: string, conclusion: string | null, status = "completed") {
  return { number, name, status, conclusion }
}

function job(
  id: number,
  name: string,
  conclusion: string | null,
  steps: readonly unknown[] = [],
  status = "completed",
) {
  return {
    databaseId: id,
    name,
    status,
    conclusion,
    url: `https://example.invalid/job/${id}`,
    startedAt: "2026-07-29T10:00:00Z",
    completedAt: "2026-07-29T10:00:10Z",
    steps,
  }
}

/** A failed run's detail: a green job with folded steps, a red one with the culprit step. */
function brokenRunDetail() {
  return {
    status: "completed",
    conclusion: "failure",
    jobs: [
      job(201, "build", "success", [step(1, "checkout", "success")]),
      job(202, "test", "failure", [step(1, "setup", "success"), step(2, "run tests", "failure")]),
    ],
  }
}

/**
 * Reads the repository behind the app's back, so assertions test git and not the store.
 * Inside `act`, because a refresh landing mid-spawn is a React update.
 */
async function git(harness: Harness, ...args: readonly string[]): Promise<string> {
  let stdout = ""
  await act(async () => {
    const child = Bun.spawn(["git", ...args], {
      cwd: harness.directory,
      env: { ...process.env, ...gitIsolationEnv },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`)
    stdout = out
  })
  return stdout
}

/** One commit on `main`, with everything the harness and stub write kept out of git's view. */
async function seed(harness: Harness): Promise<void> {
  await writeFile(
    join(harness.directory, ".git", "info", "exclude"),
    "bundled/\nglobal/\nrepo/\nbin/\n*.jsonc\nconfig.schema.json\n",
  )
  await writeFile(join(harness.directory, "seed.txt"), "seed\n")
  await git(harness, "add", "seed.txt")
  await git(harness, "commit", "--quiet", "--message", "first commit")
}

/** The fingerprint poll is parked by default; checkouts made mid-test go through `refreshGit`. */
async function start(harness: Harness, config = `{ "git": { "refreshIntervalMs": 60000 } }`): Promise<void> {
  await Promise.all([
    symlink(ghWorkflowsExtension, join(harness.bundled, "gh-workflows")),
    writeFile(join(harness.repo, "files.tsx"), filesSource),
    writeFile(harness.configFiles.repo, config),
  ])
  await renderApp(harness)
}

/** The frame, once it shows `text`. Fails the test if it never does. */
async function frameShowing(harness: Harness, text: string): Promise<string> {
  await waitForFrame(harness, text)
  return frame(harness)
}

async function workflowsHarness(): Promise<Harness> {
  const harness = await createHarness({ git: true, width: 120, height: 36 })
  await seed(harness)
  return harness
}

// The stub `gh` is a shell script, which Windows cannot spawn — and skipping the stub would
// let a real gh on PATH answer with the network. The pane's own logic has no platform branch.
describe.skipIf(process.platform === "win32")("gh-workflows pane", () => {
  it("lists the branch's runs with a glyph per outcome", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [
      run(1, "first run", "completed", "success"),
      run(2, "second run", "completed", "failure"),
      run(3, "third run", "in_progress", ""),
    ])
    await start(harness)

    const listed = await frameShowing(harness, "verify — first run")
    expect(listed).toContain("✓ verify — first run")
    expect(listed).toContain("✗ verify — second run")
    expect(listed).toContain("● verify — third run")

    const asked = await gh.calls()
    expect(asked[0]).toContain("--branch main")
    expect(asked[0]).toContain("--limit 15")
  })

  it("passes the configured limit through to gh", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(1, "first run", "completed", "success")])
    await start(harness, `{ "extensions": { "gh-workflows": { "limit": 3 } }, "git": { "refreshIntervalMs": 60000 } }`)

    await frameShowing(harness, "verify — first run")
    expect((await gh.calls())[0]).toContain("--limit 3")
  })

  it("refetches when the branch changes under it", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(1, "on main", "completed", "success")])
    await gh.setRuns("topic", [run(2, "on topic", "completed", "success")])
    await start(harness)

    await frameShowing(harness, "verify — on main")
    await git(harness, "checkout", "--quiet", "-b", "topic")
    await refreshGit(harness)

    await frameShowing(harness, "verify — on topic")
    expect(frame(harness)).not.toContain("on main")
  })

  it("focuses the pane and refetches from the palette command", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(1, "stale run", "completed", "success")])
    await start(harness)

    await frameShowing(harness, "verify — stale run")
    await gh.setRuns("main", [run(2, "fresh run", "completed", "success")])

    await press(harness, "p", { ctrl: true })
    await waitForFrame(harness, "Filter commands")
    await press(harness, () => void harness.setup.mockInput.typeText("GitHub"))
    await waitForFrame(harness, "GitHub Actions: refresh runs")
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await frameShowing(harness, "verify — fresh run")
    // The highlight only paints on the focused Pane, so a lit row is the focus assertion.
    await waitFor(
      harness,
      () => highlighted(harness).some((row) => row.includes("fresh run")),
      "the fresh run's row to be lit",
    )
  })

  it("opens the selected run in the browser", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [
      run(1, "first run", "completed", "success"),
      run(2, "second run", "completed", "failure"),
    ])
    await start(harness)
    await frameShowing(harness, "verify — second run")

    await press(harness, "2")
    await press(harness, "j")
    await press(harness, "o")

    await waitFor(
      harness,
      async () => (await Bun.file(gh.openLog).exists()) && (await gh.opened()) === "https://example.invalid/2",
      "the run's URL to reach the opener",
    )
  })

  it("shows gh's own refusal when it fails", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.replace('echo "gh: not logged in" >&2\nexit 1')
    await start(harness)

    await frameShowing(harness, "gh: not logged in")
  })

  it("shows the parse failure when gh answers with something other than JSON", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.replace("echo not json")
    await start(harness)

    await frameShowing(harness, "JSON Parse error")
  })

  it("enters a run to its jobs, folds by outcome, and escapes back", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(2, "broken run", "completed", "failure"), run(1, "good run", "completed", "success")])
    await gh.setDetail(2, brokenRunDetail())
    await start(harness)
    await frameShowing(harness, "verify — broken run")

    await press(harness, "2")
    await press(harness, () => harness.setup.mockInput.pressEnter())

    // The failed job's steps start visible, the green job's stay folded.
    const jobs = await frameShowing(harness, "✗ run tests")
    expect(jobs).toContain("✓ build")
    expect(jobs).toContain("✗ test")
    expect(jobs).toContain("✓ setup")
    expect(jobs).not.toContain("checkout")

    // `return` on the green job unfolds it.
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await frameShowing(harness, "✓ checkout")

    await pressEscape(harness)
    const back = await frameShowing(harness, "verify — good run")
    expect(back).not.toContain("run tests")
  })

  it("reruns a job with r inside a run, and asks gh again after", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(2, "broken run", "completed", "failure")])
    await gh.setDetail(2, brokenRunDetail())
    await start(harness)
    await frameShowing(harness, "verify — broken run")

    await press(harness, "2")
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await frameShowing(harness, "✗ run tests")

    await press(harness, "j")
    await press(harness, "r")

    // The mutation is followed by a fresh `run view`, not a stale frame — and the refetch is
    // the rerun's last effect, so it is what the wait must cover.
    await waitFor(
      harness,
      async () => {
        const calls = await gh.calls()
        return (
          calls.some((line) => line.startsWith("run rerun --job 202")) &&
          calls.filter((line) => line.startsWith("run view 2")).length >= 2
        )
      },
      "the job rerun to reach gh and be followed by a fresh run view",
    )
  })

  it("reruns only the failed jobs of a failed run, everything for a green one", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(2, "broken run", "completed", "failure"), run(1, "good run", "completed", "success")])
    await start(harness)
    await frameShowing(harness, "verify — broken run")

    // Each wait also requires the rerun's follow-up list refetch, which is the mutation's
    // last effect — the rerun call alone leaves that refetch to land after the test.
    await press(harness, "2")
    await press(harness, "r")
    await waitFor(
      harness,
      async () => {
        const calls = await gh.calls()
        return (
          calls.some((line) => line === "run rerun 2 --failed") &&
          calls.filter((line) => line.startsWith("run list")).length >= 2
        )
      },
      "the failed-only rerun to reach gh and refresh the list",
    )

    await press(harness, "j")
    await press(harness, "r")
    await waitFor(
      harness,
      async () => {
        const calls = await gh.calls()
        return (
          calls.some((line) => line === "run rerun 1") &&
          calls.filter((line) => line.startsWith("run list")).length >= 3
        )
      },
      "the full rerun to reach gh and refresh the list",
    )
  })

  it("cancels a live run only after the confirm", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(3, "slow run", "in_progress", "")])
    await start(
      harness,
      `{ "extensions": { "gh-workflows": { "pollIntervalMs": 250 } }, "git": { "refreshIntervalMs": 60000 } }`,
    )
    await frameShowing(harness, "verify — slow run")

    await press(harness, "2")
    await press(harness, "x")
    await frameShowing(harness, "Cancel verify?")
    expect((await gh.calls()).some((line) => line.startsWith("run cancel"))).toBe(false)

    await press(harness, "y")
    await waitFor(
      harness,
      async () => (await gh.calls()).some((line) => line === "run cancel 3"),
      "the cancel to reach gh",
    )

    // Settle the run before the test ends: the cancel's follow-up refetch and the live-run
    // poll both update the pane on their own schedule, and an update landing after the last
    // wait is an update outside act. The write itself sits inside act for the same reason.
    await act(async () => {
      await gh.setRuns("main", [run(3, "slow run", "completed", "success")])
    })
    await waitForFrame(harness, "✓ verify — slow run")
  })

  it("toggles between the branch's runs and every branch's", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(1, "on main", "completed", "success")])
    await gh.setRuns("", [run(9, "on other", "completed", "success", { headBranch: "other" })])
    await start(harness)
    const current = await frameShowing(harness, "verify — on main")
    expect(current).toContain("current branch · main")
    await gh.delayRuns("", 0.2)

    await press(harness, "2")
    await press(harness, "a")

    const loading = frame(harness)
    expect(loading).toContain("all branches")
    expect(loading).toContain("loading runs…")
    expect(loading).not.toContain("on main")

    // The all-branches row names its branch; the branch-scoped row never did.
    const all = await frameShowing(harness, "verify — on other")
    expect(all).toContain("all branches")
    expect(all).toContain("other · push")
    const listCalls = (await gh.calls()).filter((line) => line.startsWith("run list"))
    expect(listCalls.some((line) => !line.includes("--branch"))).toBe(true)

    await press(harness, "a")
    await frameShowing(harness, "verify — on main")
  })

  it("shows a failed job's log tail and escapes back to the jobs", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(2, "broken run", "completed", "failure")])
    await gh.setDetail(2, brokenRunDetail())
    await gh.setLog(202, "test\trun tests\tExpected 3, got 4\ntest\trun tests\tError: assertion failed\n")
    await start(harness)
    await frameShowing(harness, "verify — broken run")

    await press(harness, "2")
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await frameShowing(harness, "✗ run tests")

    await press(harness, "j")
    await press(harness, "l")

    // The gh prefix columns are stripped; the words are what the tail shows.
    const log = await frameShowing(harness, "Expected 3, got 4")
    expect(log).toContain("Error: assertion failed")
    expect((await gh.calls()).some((line) => line === "run view --job 202 --log-failed")).toBe(true)

    await pressEscape(harness)
    await frameShowing(harness, "✓ build")
  })

  it("polls gh while a run is live", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(3, "slow run", "in_progress", "")])
    await start(
      harness,
      `{ "extensions": { "gh-workflows": { "pollIntervalMs": 250 } }, "git": { "refreshIntervalMs": 60000 } }`,
    )
    await frameShowing(harness, "verify — slow run")

    await waitFor(
      harness,
      async () => (await gh.calls()).filter((line) => line.startsWith("run list")).length >= 3,
      "the pane to poll gh repeatedly",
    )

    // A completed run is what parks the poll; waiting for it on screen absorbs the last
    // fetch inside act before the test ends, and the write sits inside act because a poll
    // can land while it is awaited.
    await act(async () => {
      await gh.setRuns("main", [run(3, "slow run", "completed", "success")])
    })
    await waitForFrame(harness, "✓ verify — slow run")
  })
})

describe("gh-workflows pane without a branch", () => {
  it("names the detached HEAD instead of asking gh about it", async () => {
    const harness = await workflowsHarness()
    await git(harness, "checkout", "--quiet", "--detach")
    await start(harness)

    const detached = await frameShowing(harness, "current branch · detached HEAD")
    expect(detached).toContain("no runs")
  })
})
