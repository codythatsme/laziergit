import { describe, expect, it } from "bun:test"
import { TerminalControl, type Session } from "@kitlangton/terminal-control"
import { chmod, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { defaultTheme } from "../../packages/core/src/extension/theme"
import { addOrigin, createTestRepo, registerRepoCleanup, type TestRepo } from "../../packages/core/src/git/test-repo"

registerRepoCleanup()

/** The selection colour the app is actually running with — no config here overrides it. */
const selection = {
  r: Number.parseInt(defaultTheme.selection.slice(1, 3), 16),
  g: Number.parseInt(defaultTheme.selection.slice(3, 5), 16),
  b: Number.parseInt(defaultTheme.selection.slice(5, 7), 16),
}

const entrypoint = resolve(import.meta.dir, "..", "..", "packages", "core", "src", "main.tsx")
const specification = resolve(import.meta.dir, "..", "..", "docs", "extension-api.md")
const paneTitles = ["Files", "Local branches", "Commits", "Stash", "Actions", "[Diff] - Commit"] as const

type Layout = "all-panes" | "working-panes"

function config(layout: Layout): string {
  const columns =
    layout === "all-panes"
      ? ""
      : `"columns": [
          { "cells": [["files", "branches", "commits", "stash"]] },
          { "cells": [["diff", "commit-flow"]] }
        ],`
  return `{ "layout": { ${columns} "focus": "files" }, "git": { "refreshIntervalMs": 250 } }`
}

async function createE2eRepo(layout: Layout = "working-panes"): Promise<TestRepo> {
  const repo = await createTestRepo()
  await repo.write(".git/info/exclude", ".laziergit/\n.termctrl-artifacts/\n.home/\n")
  await repo.write("tracked.txt", "one\n")
  await repo.git("add", "tracked.txt")
  await repo.commit("first commit")
  await mkdir(join(repo.path, ".laziergit"), { recursive: true })
  await repo.write(".laziergit/config.jsonc", config(layout))
  // Every session boots the bundled gh-workflows pane, so every session gets a `gh` with no
  // runs: the machine's own gh would put the network and its auth state on the screen. A test
  // that wants runs overwrites this stub.
  const bin = join(repo.path, ".home", "bin")
  await mkdir(bin, { recursive: true })
  await Bun.write(join(bin, "gh"), "#!/bin/sh\necho '[]'\n")
  await chmod(join(bin, "gh"), 0o755)
  return repo
}

/**
 * The `gh-workflows` extension exactly as §2 of the specification prints it. Extracted rather
 * than copied, so a change to the example that breaks it fails here instead of in someone's
 * config directory.
 */
async function workedExample(): Promise<string> {
  const document = await Bun.file(specification).text()
  const heading = document.indexOf("## 2. Worked example A")
  if (heading === -1) throw new Error("The specification no longer has a §2 worked example to run")
  const open = document.indexOf("```tsx\n", heading)
  const close = document.indexOf("\n```", open)
  if (open === -1 || close === -1) throw new Error("§2's worked example is not in a tsx code fence")
  return document.slice(open + "```tsx\n".length, close + 1)
}

function launchEnvironment(repo: TestRepo): Readonly<Record<string, string>> {
  const path = process.env.PATH
  if (path === undefined) throw new Error("The E2E test needs PATH so laziergit can invoke git")
  const home = join(repo.path, ".home")
  return {
    // The sandbox's stubs — a `gh` at minimum — shadow the machine's own binaries.
    PATH: `${join(home, "bin")}:${path}`,
    TERM: "xterm-256color",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  }
}

async function terminalFailure(session: Session, waitingFor: string, cause: unknown): Promise<Error> {
  const [status, logs, capture] = await Promise.all([
    session.status(),
    session.logs.text(),
    session.screen.capture({ allowIncomplete: true }),
  ])
  return new Error(
    `Terminal session failed while waiting for ${waitingFor}.\nStatus: ${JSON.stringify(status)}\nLogs:\n${logs}\nScreen:\n${capture.text}`,
    { cause },
  )
}

async function waitForText(session: Session, text: string | RegExp, timeoutMs = 15_000): Promise<void> {
  try {
    await session.screen.waitForText(text, { timeoutMs })
  } catch (error) {
    throw await terminalFailure(session, JSON.stringify(text), error)
  }
}

async function waitForScreen(
  session: Session,
  description: string,
  predicate: (screen: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> {
  try {
    const snapshot = await session.screen.waitUntil((screen) => predicate(screen.text), { timeoutMs })
    return snapshot.text
  } catch (error) {
    throw await terminalFailure(session, description, error)
  }
}

/**
 * The row the focused Pane has lit, read off the terminal's own cells. The list Panes draw no
 * cursor marker — the selection highlight is the cursor — and this is the only place that
 * highlight is checked against a real terminal rather than OpenTUI's buffer.
 *
 * Matched on the default preset's own `selection` token, byte for byte, so a terminal that
 * quantised the 24-bit colour on the way through fails here.
 */
async function selectedRow(session: Session): Promise<string> {
  const frame = await session.screen.frame()
  const rows = new Map<number, { x: number; text: string }[]>()
  for (const cell of frame.cells) {
    if (cell.background.r !== selection.r) continue
    if (cell.background.g !== selection.g || cell.background.b !== selection.b) continue
    const row = rows.get(cell.y) ?? []
    row.push({ x: cell.x, text: cell.text })
    rows.set(cell.y, row)
  }

  // The widest run wins: only one Pane has focus, so only one row is lit — but a popup's
  // own selected line is drawn in the same colour, and it is the shorter of the two.
  const widest = [...rows.values()].sort((left, right) => right.length - left.length)[0] ?? []
  return widest
    .sort((left, right) => left.x - right.x)
    .map((cell) => cell.text)
    .join("")
    .trim()
}

async function waitForSelectedRow(session: Session, text: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  for (;;) {
    last = await selectedRow(session)
    if (last.includes(text)) return
    if (Date.now() > deadline) {
      throw await terminalFailure(session, `the highlighted row to be "${text}" (it was "${last}")`, undefined)
    }
    await Bun.sleep(100)
  }
}

async function inTerminal(
  repo: TestRepo,
  run: (session: Session) => Promise<void>,
  { viewport = { cols: 140, rows: 45 } }: { viewport?: { cols: number; rows: number } } = {},
): Promise<void> {
  const terminal = await TerminalControl.make({ artifacts: false })
  try {
    const session = await terminal.launch({
      command: [process.execPath, entrypoint],
      cwd: repo.path,
      viewport,
      host: "opentui",
      inheritEnv: false,
      env: launchEnvironment(repo),
    })
    try {
      await run(session)
    } finally {
      await session.stop()
    }
  } finally {
    await terminal.close()
  }
}

async function pressKittyModifier(session: Session, key: string, modifier: number): Promise<void> {
  const codePoint = key.codePointAt(0)
  if (codePoint === undefined) throw new TypeError("A modified key needs one character")
  await session.keyboard.write(new TextEncoder().encode(`\u001b[${codePoint};${modifier}u`))
}

async function pressPrimaryModifier(session: Session, key: string): Promise<void> {
  // Terminal Control reports Kitty keyboard support to OpenTUI, so `mod` resolves to Super on
  // macOS and Ctrl elsewhere. Writing the protocol sequence exercises a real key event rather
  // than a legacy control byte the PTY line discipline can consume as XON/XOFF.
  const modifier = process.platform === "darwin" ? 9 : 5
  await pressKittyModifier(session, key, modifier)
}

async function pressOption(session: Session, key: string): Promise<void> {
  await pressKittyModifier(session, key, 3)
}

async function pressSuper(session: Session, key: string): Promise<void> {
  await pressKittyModifier(session, key, 9)
}

/**
 * A ctrl-modified key through the same protocol, for the bindings that are deliberately ctrl
 * rather than `mod`.
 */
async function pressCtrl(session: Session, key: string): Promise<void> {
  await pressKittyModifier(session, key, 5)
}

async function openCommandPalette(session: Session): Promise<void> {
  await pressCtrl(session, "p")
  // Keyboard writes only acknowledge PTY delivery. Wait until the popup's input owns
  // subsequent keys so a fast runner cannot send the query into the underlying Pane.
  await waitForText(session, "Filter commands")
}

async function pressEscape(session: Session): Promise<void> {
  // With Kitty disambiguation enabled, a physical Escape key is reported as its Unicode
  // codepoint rather than the ambiguous lone ESC byte.
  await session.keyboard.write(new TextEncoder().encode("\u001b[27u"))
}

describe("laziergit through a real terminal", () => {
  it("boots every Bundled Extension pane with live repository content", async () => {
    const repo = await createE2eRepo("all-panes")
    await addOrigin(repo)
    await inTerminal(repo, async (session) => {
      await waitForText(session, "first commit")
      // The one pane whose content arrives through a spawned `gh` rather than git.
      await waitForText(session, "no runs for main")
      const screen = await session.screen.text()

      for (const title of paneTitles) expect(screen).toContain(title)
      // A row in sync says nothing about its upstream, so the marker is the whole of it.
      expect(screen).toContain("* main")
      expect(screen).toContain("working tree clean")
      expect(screen).toContain("no stashes")
      // The status line names where HEAD is; the divergence beside it is suppressed while
      // there is none to report.
      expect(screen).not.toContain("↑")
    })
  }, 20_000)

  it("moves and reveals the files cursor with arrows and j/k/g/G", async () => {
    const repo = await createE2eRepo()
    for (let index = 0; index < 30; index += 1) {
      await repo.write(`row${String(index).padStart(2, "0")}.txt`, `row ${index}\n`)
    }

    await inTerminal(
      repo,
      async (session) => {
        await waitForSelectedRow(session, "?? row00.txt")

        await session.keyboard.press("ArrowDown")
        await waitForSelectedRow(session, "?? row01.txt")
        await session.keyboard.press("ArrowUp")
        await waitForSelectedRow(session, "?? row00.txt")

        await session.keyboard.type("j")
        await waitForSelectedRow(session, "?? row01.txt")
        await session.keyboard.type("k")
        await waitForSelectedRow(session, "?? row00.txt")

        await session.keyboard.type("G")
        const last = await waitForScreen(
          session,
          "the last file and its diff to be visible",
          (screen) => screen.includes("?? row29.txt") && screen.includes("working tree row29.txt"),
        )
        expect(last).not.toContain("row00.txt")
        await waitForSelectedRow(session, "?? row29.txt")

        await session.keyboard.type("g")
        await waitForSelectedRow(session, "?? row00.txt")
      },
      { viewport: { cols: 120, rows: 24 } },
    )
  }, 20_000)

  it("filters files and searches commits while preserving commit context", async () => {
    const repo = await createE2eRepo()
    await repo.write("tracked.txt", "two\n")
    await repo.git("commit", "--quiet", "--all", "--message", "middle needle")
    await repo.write("tracked.txt", "three\n")
    await repo.git("commit", "--quiet", "--all", "--message", "latest wrapper")
    await repo.write("alpha.txt", "alpha\n")
    await repo.write("needle-file.txt", "needle\n")

    await inTerminal(repo, async (session) => {
      await waitForSelectedRow(session, "?? alpha.txt")

      await session.keyboard.type("/")
      await waitForText(session, "Filter:")
      await session.keyboard.type("needle-file")
      const filtered = await waitForScreen(
        session,
        "the files list to filter while the query is being typed",
        (screen) => screen.includes("?? needle-file.txt") && !screen.includes("?? alpha.txt"),
      )
      expect(filtered).toContain("Filter: needle-file")
      await waitForSelectedRow(session, "?? needle-file.txt")

      await session.keyboard.press("Enter")
      await waitForText(session, "matches for 'needle-file' (1 of 2)")
      await pressEscape(session)
      await waitForText(session, "?? alpha.txt")
      await waitForSelectedRow(session, "?? needle-file.txt")

      await openCommandPalette(session)
      await session.keyboard.type("Focus commits")
      await waitForText(session, "Focus commits")
      await session.keyboard.press("Enter")
      await waitForSelectedRow(session, "latest wrapper")

      await session.keyboard.type("/")
      await waitForText(session, "Search:")
      await session.keyboard.type("middle needle")
      await session.keyboard.press("Enter")
      await waitForSelectedRow(session, "middle needle")
      const history = await session.screen.text()
      expect(history).toContain("latest wrapper")
      expect(history).toContain("first commit")

      await session.keyboard.type("j")
      await waitForSelectedRow(session, "first commit")
      await session.keyboard.type("n")
      await waitForSelectedRow(session, "middle needle")
    })
  }, 20_000)

  /**
   * The only place `keys: "return"` is proven against a real terminal. OpenTUI names the Enter
   * key `return` and core installs no aliases, so `keys: "enter"` would parse, register, and
   * never fire — invisible to a unit test that presses the name it bound.
   */
  it("collapses a folder with Enter, hiding its descendants", async () => {
    const repo = await createE2eRepo()
    await repo.write("pkg/a.txt", "a\n")
    await repo.write("pkg/sub/b.txt", "b\n")

    await inTerminal(repo, async (session) => {
      // Also the only check that the fold triangles are one cell wide in a real terminal: at
      // two they would push the status columns off their grid.
      await waitForText(session, "▼  pkg")
      expect(await session.screen.text()).toContain("a.txt")

      // The descendants go with it, the compressed `sub` chain included.
      await session.keyboard.press("Enter")
      const folded = await waitForScreen(
        session,
        "the folder to collapse and take its files with it",
        (screen) => screen.includes("▶  pkg") && !screen.includes("a.txt"),
      )
      expect(folded).not.toContain("b.txt")

      await session.keyboard.press("Enter")
      await waitForText(session, "▼  pkg")
    })
  }, 20_000)

  it("stages, commits, amends, and pushes while the editor captures ordinary keys", async () => {
    const repo = await createE2eRepo()
    await addOrigin(repo)
    await repo.write("tracked.txt", "two\n")

    await inTerminal(repo, async (session) => {
      await waitForText(session, " M tracked.txt")
      await session.keyboard.type(" ")
      await waitForText(session, "M  tracked.txt")

      await session.keyboard.type("c")
      // The hint bar, which during a capture is the Pane's two remaining keys.
      await waitForText(session, "ctrl+s commit")
      await session.keyboard.type("q from e2e")
      await waitForText(session, "q from e2e")
      expect((await session.status()).state).toBe("running")

      await pressPrimaryModifier(session, "s")
      await waitForText(session, "Committed")
      expect(await repo.git("log", "-1", "--format=%s")).toBe("q from e2e\n")

      await repo.write("tracked.txt", "three\n")
      await waitForText(session, " M tracked.txt")
      await session.keyboard.type(" ")
      await waitForText(session, "M  tracked.txt")

      await session.keyboard.type("A")
      await waitForText(session, "amending the last commit")
      await session.keyboard.type(" amended")
      await pressPrimaryModifier(session, "s")
      await waitForText(session, "Amended")

      expect(await repo.git("log", "-1", "--format=%s")).toBe("q from e2e amended\n")
      expect(await repo.git("rev-list", "--count", "HEAD")).toBe("2\n")

      await session.keyboard.type("P")
      await waitForText(session, "Pushed main to origin/main")
      expect(await repo.git("rev-parse", "HEAD")).toBe(await repo.git("rev-parse", "origin/main"))
    })
  }, 30_000)

  it("focuses branches through the palette, shows live keys, and checks one out", async () => {
    const repo = await createE2eRepo()
    await repo.git("checkout", "--quiet", "-b", "topic")
    await repo.write("tracked.txt", "topic\n")
    await repo.git("commit", "--quiet", "--all", "--message", "topic change")
    await repo.git("checkout", "--quiet", "main")

    await inTerminal(repo, async (session) => {
      await waitForText(session, "working tree clean")

      await openCommandPalette(session)
      await session.keyboard.type("Focus branches")
      await waitForText(session, "Focus branches")
      await session.keyboard.press("Enter")
      await waitForText(session, "branch main")

      await session.keyboard.type("?")
      const keys = await waitForScreen(
        session,
        "the focused branches pane's live keybindings",
        (screen) => screen.includes("Keybindings — branches") && screen.includes("Check out branch"),
      )
      // Scoped to the Pane holding the keyboard: the files Pane is on screen, in the same
      // tab group, and its keys are not on this sheet.
      expect(keys).not.toContain("Stage / unstage file")
      expect(keys).toContain("Global")
      await pressEscape(session)
      await waitForScreen(session, "the keybindings popup to close", (screen) => !screen.includes("Keybindings"))

      await session.keyboard.press("ArrowDown")
      await waitForText(session, "branch topic")
      await session.keyboard.type(" ")
      await waitForText(session, "* topic")

      expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("topic\n")
    })
  }, 20_000)

  it("merges the selected branch into the checked-out branch", async () => {
    const repo = await createE2eRepo()
    await repo.git("checkout", "--quiet", "-b", "topic")
    await repo.write("tracked.txt", "topic\n")
    await repo.git("commit", "--quiet", "--all", "--message", "topic change")
    await repo.git("checkout", "--quiet", "main")
    const topic = await repo.git("rev-parse", "topic")

    await inTerminal(repo, async (session) => {
      await waitForText(session, "working tree clean")
      await openCommandPalette(session)
      await session.keyboard.type("Focus branches")
      await waitForText(session, "Focus branches")
      await session.keyboard.press("Enter")
      await waitForText(session, "branch main")

      await session.keyboard.press("ArrowDown")
      await waitForText(session, "branch topic")
      await session.keyboard.type("M")
      await waitForText(session, "Merge topic into main")
      await waitForText(session, "Regular merge (fast-forward)")
      await session.keyboard.type("m")
      await waitForText(session, "Merged topic into main")

      expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("main\n")
      expect(await repo.git("rev-parse", "main")).toBe(topic)
    })
  }, 20_000)

  /**
   * The project's acceptance test, run by machine: a user drops a `.tsx` file into their own
   * config directory and the feature exists — no core change, nothing rebuilt.
   *
   * The extension is lifted out of the specification itself rather than copied here, so §2's
   * worked example is executed rather than merely published; an example that stops compiling
   * or drifts from the API it teaches fails this test.
   *
   * `gh` is stubbed on PATH: the point under test is laziergit's loading, layout, cursor and
   * hint machinery, not GitHub's availability.
   *
   * The same extension ships as a Bundled Extension, so this install also exercises scope
   * precedence: the user's copy must shadow the bundled one, and only one pane may exist.
   */
  it("loads §2's worked example from the user's config directory and runs it", async () => {
    const repo = await createE2eRepo()
    const home = join(repo.path, ".home")
    const extensions = join(home, ".config", "laziergit", "extensions")
    await mkdir(extensions, { recursive: true })
    await Bun.write(join(extensions, "gh-workflows.tsx"), await workedExample())

    // Long enough that a row which failed to clip would visibly reflow inside the pane.
    const clipped = `an unusually long run title that keeps going ${"and going ".repeat(8)}TAIL`
    const runs = [
      { databaseId: 1, displayTitle: "first run", workflowName: "verify", status: "completed", conclusion: "success" },
      { databaseId: 2, displayTitle: "second run", workflowName: "verify", status: "completed", conclusion: "failure" },
      { databaseId: 3, displayTitle: clipped, workflowName: "verify", status: "in_progress", conclusion: "" },
    ].map((run) => ({ ...run, url: `https://example.invalid/${run.databaseId}` }))

    const bin = join(home, "bin")
    await mkdir(bin, { recursive: true })
    const stub = join(bin, "gh")
    await Bun.write(stub, `#!/bin/sh\ncat <<'LAZIERGIT_JSON'\n${JSON.stringify(runs)}\nLAZIERGIT_JSON\n`)
    await chmod(stub, 0o755)

    await inTerminal(repo, async (session) => {
      // The pane the user's file registered, drawn from the stub's runs — and drawn where
      // its `placement` hint asked, without being named in this repository's Layout.
      await waitForText(session, "Actions")
      const listed = await waitForScreen(
        session,
        "the workflow runs the stubbed gh reported",
        (screen) => screen.includes("verify — first run") && screen.includes("verify — second run"),
      )
      expect(listed).toContain("✓")
      expect(listed).toContain("✗")
      // One row is one line: the third title is clipped at the column edge, so its
      // tail never reaches the screen. Without `wrapMode="none"` it reflows and TAIL shows.
      expect(listed).not.toContain("TAIL")

      // Tab reaches it, and the cursor it got from `useListCursor` walks and lights rows.
      await session.keyboard.press("Tab")
      await waitForSelectedRow(session, "✓ verify — first run")
      // `hint` on the user's own Command reaches the bottom row, like any bundled one.
      await waitForText(session, "o open")
      // The highlighted frame can arrive before the focus transition has gone quiet at the
      // PTY boundary. Do not let the next key race the tail of that transition.
      await session.screen.waitForIdle({ quietForMs: 100 })

      await session.keyboard.press("ArrowDown")
      await waitForSelectedRow(session, "✗ verify — second run")
      await session.keyboard.type("G")
      await waitForSelectedRow(session, "●")

      // The user's Command is on the focused Pane's cheat sheet, under the extension's name.
      await session.keyboard.type("?")
      const keys = await waitForScreen(session, "the user extension's own keybindings", (screen) =>
        screen.includes("Keybindings — gh-workflows"),
      )
      expect(keys).toContain("Open workflow run in browser")
      expect(keys).toContain("Next run")
    })
  }, 30_000)

  it("saves and pops a stash through the focused panes", async () => {
    const repo = await createE2eRepo()
    await repo.write("tracked.txt", "stashed\n")

    await inTerminal(repo, async (session) => {
      await waitForText(session, " M tracked.txt")
      await session.keyboard.type("s")
      await waitForText(session, "Stash message")

      await session.keyboard.type("first second")
      await waitForText(session, "first second")
      await pressOption(session, "\u007f")
      await waitForScreen(
        session,
        "Option+Backspace to delete the previous word",
        (screen) => screen.includes("first ") && !screen.includes("second"),
      )
      await pressSuper(session, "\u007f")
      await waitForText(session, "leave empty for git's default")

      await session.keyboard.type("from e2e")
      await session.keyboard.press("Enter")
      await waitForText(session, "working tree clean")

      expect(await repo.git("status", "--porcelain")).toBe("")

      await session.keyboard.type("4")
      await waitForText(session, "from e2e on main")
      await session.keyboard.type("p")
      await waitForText(session, "no stashes")

      expect(await repo.git("stash", "list")).toBe("")
      expect(await Bun.file(join(repo.path, "tracked.txt")).text()).toBe("stashed\n")
    })
  }, 20_000)
})
