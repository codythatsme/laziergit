import { describe, expect, it } from "bun:test"
import { TerminalControl, type Session } from "@kitlangton/terminal-control"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { addOrigin, createTestRepo, registerRepoCleanup, type TestRepo } from "../../packages/core/src/git/test-repo"

registerRepoCleanup()

const entrypoint = resolve(import.meta.dir, "..", "..", "packages", "core", "src", "main.tsx")
const paneTitles = ["Status", "Files", "Branches", "Commits", "Stash", "[Diff] Commit"] as const

type Layout = "all-panes" | "working-panes"

function config(layout: Layout): string {
  const columns =
    layout === "all-panes"
      ? ""
      : `"columns": [
          { "cells": [["files", "status", "branches", "commits", "stash"]] },
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

function launchEnvironment(repo: TestRepo): Readonly<Record<string, string>> {
  const path = process.env.PATH
  if (path === undefined) throw new Error("The E2E test needs PATH so laziergit can invoke git")
  const home = join(repo.path, ".home")
  return {
    PATH: path,
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
  viewport = { cols: 140, rows: 45 },
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
      expect(screen).toMatch(/\* main\s+✓/)
      expect(screen).toContain("working tree clean")
      expect(screen).toContain("no stashes")
      expect(screen).toContain("↑0 ↓0")
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
        await waitForText(session, "❯ ? row00.txt")

        await session.keyboard.press("ArrowDown")
        await waitForText(session, "❯ ? row01.txt")
        await session.keyboard.press("ArrowUp")
        await waitForText(session, "❯ ? row00.txt")

        await session.keyboard.type("j")
        await waitForText(session, "❯ ? row01.txt")
        await session.keyboard.type("k")
        await waitForText(session, "❯ ? row00.txt")

        await session.keyboard.type("G")
        const last = await waitForScreen(
          session,
          "the last file and its diff to be visible",
          (screen) => screen.includes("❯ ? row29.txt") && screen.includes("working tree row29.txt"),
        )
        expect(last).not.toContain("row00.txt")

        await session.keyboard.type("g")
        await waitForText(session, "❯ ? row00.txt")
      },
      { cols: 120, rows: 24 },
    )
  }, 20_000)

  it("stages, commits, amends, and pushes while the editor captures ordinary keys", async () => {
    const repo = await createE2eRepo()
    await addOrigin(repo)
    await repo.write("tracked.txt", "two\n")

    await inTerminal(repo, async (session) => {
      await waitForText(session, "Unstaged")
      await session.keyboard.type(" ")
      await waitForText(session, "Staged")

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
      await waitForText(session, "Unstaged")
      await session.keyboard.type(" ")
      await waitForText(session, "Staged")

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
    const topicOid = (await repo.git("rev-parse", "HEAD")).trim()
    await repo.git("checkout", "--quiet", "main")

    await inTerminal(repo, async (session) => {
      await waitForText(session, "working tree clean")

      await pressCtrl(session, "p")
      await waitForText(session, "Commands")
      await session.keyboard.type("Focus branches")
      await waitForText(session, "Focus branches")
      await session.keyboard.press("Enter")
      await waitForText(session, `commit ${(await repo.git("rev-parse", "HEAD")).trim().slice(0, 8)}`)

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
      await waitForText(session, `commit ${topicOid.slice(0, 8)}`)
      await session.keyboard.type(" ")
      await waitForText(session, "* topic  no upstream")

      expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("topic\n")
    })
  }, 20_000)

  it("saves and pops a stash through the focused panes", async () => {
    const repo = await createE2eRepo()
    await repo.write("tracked.txt", "stashed\n")

    await inTerminal(repo, async (session) => {
      await waitForText(session, "Unstaged")
      await session.keyboard.type("s")
      await waitForText(session, "Stash message")
      await session.keyboard.type("from e2e")
      await session.keyboard.press("Enter")
      await waitForText(session, "working tree clean")

      expect(await repo.git("status", "--porcelain")).toBe("")

      await session.keyboard.type("5")
      await waitForText(session, "stash@{0} from e2e on main")
      await session.keyboard.type("p")
      await waitForText(session, "no stashes")

      expect(await repo.git("stash", "list")).toBe("")
      expect(await Bun.file(join(repo.path, "tracked.txt")).text()).toBe("stashed\n")
    })
  }, 20_000)
})
