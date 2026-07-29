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
  renderApp,
  settle,
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
 * A `gh` on PATH whose runs the test controls: it logs each argv line to `gh.log` and answers
 * with `runs-<branch>.json` for whatever `--branch` it was asked. `open`/`xdg-open` beside it
 * catch the pane's browser hand-off, which must never reach the real one from a test.
 */
interface GhStub {
  readonly bin: string
  readonly openLog: string
  setRuns(branch: string, runs: readonly unknown[]): Promise<void>
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
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--branch" ]; then branch="$arg"; fi',
    '  prev="$arg"',
    "done",
    `exec cat "${bin}/runs-$branch.json"`,
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
    replace: (body) => writeFile(join(bin, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 }),
    calls: async () => (await Bun.file(log).text()).trim().split("\n"),
    opened: async () => (await Bun.file(openLog).text()).trim(),
  }
}

function run(id: number, title: string, status: string, conclusion: string) {
  return {
    databaseId: id,
    displayTitle: title,
    workflowName: "verify",
    status,
    conclusion,
    url: `https://example.invalid/${id}`,
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

async function start(harness: Harness, config?: string): Promise<void> {
  await Promise.all([
    symlink(ghWorkflowsExtension, join(harness.bundled, "gh-workflows")),
    writeFile(join(harness.repo, "files.tsx"), filesSource),
    ...(config === undefined ? [] : [writeFile(harness.configFiles.repo, config)]),
  ])
  await renderApp(harness)
}

/**
 * A key press, plus enough real time for the terminal parser to disambiguate it — a lone
 * escape byte is only a key once the parser has waited for the sequence it could start.
 */
async function press(harness: Harness, action: () => void): Promise<void> {
  await act(async () => {
    action()
    await Bun.sleep(60)
  })
  await settle(harness)
}

/**
 * A refresh spawns `gh` in another process, so what follows is worth asserting only once
 * that has landed, the pane has repainted, and React has committed. Polled rather than
 * slept for, and the failure carries the frame.
 */
async function settleUntil(harness: Harness, what: string, holds: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => {
      await Bun.sleep(10)
    })
    await settle(harness)
    if (await holds()) return
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame(harness)}`)
}

/** The frame, once it shows `text`. Fails the test if it never does. */
async function frameShowing(harness: Harness, text: string): Promise<string> {
  await settleUntil(harness, `the frame to show "${text}"`, () => frame(harness).includes(text))
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
    await start(harness, `{ "extensions": { "gh-workflows": { "limit": 3 } } }`)

    await frameShowing(harness, "verify — first run")
    expect((await gh.calls())[0]).toContain("--limit 3")
  })

  it("refetches when the branch changes under it", async () => {
    const harness = await workflowsHarness()
    const gh = await installGh(harness)
    await gh.setRuns("main", [run(1, "on main", "completed", "success")])
    await gh.setRuns("topic", [run(2, "on topic", "completed", "success")])
    // Fast enough for the poll to notice an outside checkout within the test's patience.
    await start(harness, `{ "git": { "refreshIntervalMs": 250 } }`)

    await frameShowing(harness, "verify — on main")
    await git(harness, "checkout", "--quiet", "-b", "topic")

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

    await press(harness, () => harness.setup.mockInput.pressKey("p", { ctrl: true }))
    await press(harness, () => void harness.setup.mockInput.typeText("GitHub"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await frameShowing(harness, "verify — fresh run")
    // The highlight only paints on the focused Pane, so a lit row is the focus assertion.
    await settleUntil(harness, "the fresh run's row to be lit", () =>
      highlighted(harness).some((row) => row.includes("fresh run")),
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

    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("o"))

    await settleUntil(
      harness,
      "the run's URL to reach the opener",
      async () => (await Bun.file(gh.openLog).exists()) && (await gh.opened()) === "https://example.invalid/2",
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
})

describe("gh-workflows pane without a branch", () => {
  it("names the detached HEAD instead of asking gh about it", async () => {
    const harness = await workflowsHarness()
    await git(harness, "checkout", "--quiet", "--detach")
    await start(harness)

    await frameShowing(harness, "detached HEAD — no runs")
  })
})
