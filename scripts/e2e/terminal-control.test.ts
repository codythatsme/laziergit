import { describe, expect, it } from "bun:test"
import { TerminalControl, type Session } from "@kitlangton/terminal-control"
import { chmod, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { addOrigin, createTestRepo, registerRepoCleanup, type TestRepo } from "../../packages/core/src/git/test-repo"

registerRepoCleanup()

const entrypoint = resolve(import.meta.dir, "..", "..", "packages", "core", "src", "main.tsx")
const specification = resolve(import.meta.dir, "..", "..", "docs", "extension-api.md")
const paneTitles = ["Files", "Branches", "Commits", "Stash", "[Diff] Commit"] as const

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
  return repo
}

/**
 * The `gh-workflows` extension exactly as §2 of the specification prints it.
 *
 * Extracted rather than copied so there is only one of it: a reader who types the example
 * out gets what this test proved, and a change to the example that breaks it fails here
 * instead of in someone's config directory.
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

function launchEnvironment(repo: TestRepo, pathPrefix?: string): Readonly<Record<string, string>> {
  const path = process.env.PATH
  if (path === undefined) throw new Error("The E2E test needs PATH so laziergit can invoke git")
  const home = join(repo.path, ".home")
  return {
    PATH: pathPrefix === undefined ? path : `${pathPrefix}:${path}`,
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

async function inTerminal(
  repo: TestRepo,
  run: (session: Session) => Promise<void>,
  {
    viewport = { cols: 140, rows: 45 },
    pathPrefix,
  }: { viewport?: { cols: number; rows: number }; pathPrefix?: string } = {},
): Promise<void> {
  const terminal = await TerminalControl.make({ artifacts: false })
  try {
    const session = await terminal.launch({
      command: [process.execPath, entrypoint],
      cwd: repo.path,
      viewport,
      host: "opentui",
      inheritEnv: false,
      env: launchEnvironment(repo, pathPrefix),
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

async function pressPrimaryModifier(session: Session, key: string): Promise<void> {
  const codePoint = key.codePointAt(0)
  if (codePoint === undefined) throw new TypeError("A modified key needs one character")
  // Terminal Control reports Kitty keyboard support to OpenTUI. On macOS laziergit therefore
  // resolves `mod` to Super; elsewhere it resolves to Ctrl. Writing the protocol sequence
  // exercises the same real key event instead of sending a legacy control byte that the PTY
  // line discipline can consume as XON/XOFF.
  const modifier = process.platform === "darwin" ? 9 : 5
  await session.keyboard.write(new TextEncoder().encode(`\u001b[${codePoint};${modifier}u`))
}

/**
 * A ctrl-modified key through the same protocol, for the bindings that are deliberately
 * ctrl rather than `mod` (ADR-0004) — writing the sequence keeps the PTY line discipline
 * out of it, which a legacy control byte would not.
 */
async function pressCtrl(session: Session, key: string): Promise<void> {
  const codePoint = key.codePointAt(0)
  if (codePoint === undefined) throw new TypeError("A modified key needs one character")
  await session.keyboard.write(new TextEncoder().encode(`\u001b[${codePoint};5u`))
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
        await waitForText(session, "❯ ?? row00.txt")

        await session.keyboard.press("ArrowDown")
        await waitForText(session, "❯ ?? row01.txt")
        await session.keyboard.press("ArrowUp")
        await waitForText(session, "❯ ?? row00.txt")

        await session.keyboard.type("j")
        await waitForText(session, "❯ ?? row01.txt")
        await session.keyboard.type("k")
        await waitForText(session, "❯ ?? row00.txt")

        await session.keyboard.type("G")
        const last = await waitForScreen(
          session,
          "the last file and its diff to be visible",
          (screen) => screen.includes("❯ ?? row29.txt") && screen.includes("working tree row29.txt"),
        )
        expect(last).not.toContain("row00.txt")

        await session.keyboard.type("g")
        await waitForText(session, "❯ ?? row00.txt")
      },
      { viewport: { cols: 120, rows: 24 } },
    )
  }, 20_000)

  /**
   * The only place `keys: "return"` is proven against a real terminal.
   *
   * OpenTUI names the Enter key `return`, and core does not install the keymap's alias
   * field — so `keys: "enter"` parses, registers, typechecks, and shows up in the cheat
   * sheet while never firing. That failure is invisible to a unit test that presses the
   * name it bound; only a real PTY sending a real Enter byte catches it.
   */
  it("collapses a folder with Enter, hiding its descendants", async () => {
    const repo = await createE2eRepo()
    await repo.write("pkg/a.txt", "a\n")
    await repo.write("pkg/sub/b.txt", "b\n")

    await inTerminal(repo, async (session) => {
      await waitForText(session, "❯ ▾  pkg")
      expect(await session.screen.text()).toContain("a.txt")

      // The descendants go with it, the compressed `sub` chain included.
      await session.keyboard.press("Enter")
      const folded = await waitForScreen(
        session,
        "the folder to collapse and take its files with it",
        (screen) => screen.includes("❯ ▸  pkg") && !screen.includes("a.txt"),
      )
      expect(folded).not.toContain("b.txt")

      await session.keyboard.press("Enter")
      await waitForText(session, "❯ ▾  pkg")
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

      await pressCtrl(session, "p")
      await waitForText(session, "Commands")
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

  /**
   * The acceptance test of PLAN.md, run by machine.
   *
   * The gate is that a user drops a `.tsx` file into their own config directory and the
   * feature exists — no core change, no bundled change, nothing rebuilt. Rather than keep a
   * copy of that file here, this lifts the extension **out of the specification itself**, so
   * §2's worked example is executed rather than merely published. An example that stops
   * compiling, stops rendering, or drifts from the API it teaches fails this test, which is
   * the defect it exists to prevent: the spec is what an authoring agent learns from, and it
   * had already grown a row that wrapped where §1.8 says rows clip.
   *
   * `gh` is stubbed on PATH — the point under test is laziergit's loading, layout, cursor and
   * hint machinery, not GitHub's availability or the network.
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

    await inTerminal(
      repo,
      async (session) => {
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
        // One row is one line (§1.8): the third title is clipped at the column edge, so its
        // tail never reaches the screen. Without `wrapMode="none"` it reflows and TAIL shows.
        expect(listed).not.toContain("TAIL")

        // Tab reaches it, and the cursor it got from `useListCursor` walks and marks rows.
        await session.keyboard.press("Tab")
        await waitForText(session, "❯ ✓ verify — first run")
        // `hint` on the user's own Command reaches the bottom row, like any bundled one.
        await waitForText(session, "o open")

        await session.keyboard.type("j")
        await waitForText(session, "❯ ✗ verify — second run")
        await session.keyboard.type("G")
        await waitForText(session, "❯ ●")

        // The user's Command is on the focused Pane's cheat sheet, under the extension's name.
        await session.keyboard.type("?")
        const keys = await waitForScreen(session, "the user extension's own keybindings", (screen) =>
          screen.includes("Keybindings — gh-workflows"),
        )
        expect(keys).toContain("Open workflow run in browser")
        expect(keys).toContain("Next run")
      },
      { pathPrefix: bin },
    )
  }, 30_000)

  it("saves and pops a stash through the focused panes", async () => {
    const repo = await createE2eRepo()
    await repo.write("tracked.txt", "stashed\n")

    await inTerminal(repo, async (session) => {
      await waitForText(session, " M tracked.txt")
      await session.keyboard.type("s")
      await waitForText(session, "Stash message")
      await session.keyboard.type("from e2e")
      await session.keyboard.press("Enter")
      await waitForText(session, "working tree clean")

      expect(await repo.git("status", "--porcelain")).toBe("")

      await session.keyboard.type("4")
      await waitForText(session, "stash@{0} from e2e on main")
      await session.keyboard.type("p")
      await waitForText(session, "no stashes")

      expect(await repo.git("stash", "list")).toBe("")
      expect(await Bun.file(join(repo.path, "tracked.txt")).text()).toBe("stashed\n")
    })
  }, 20_000)
})
