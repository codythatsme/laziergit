import { afterAll, afterEach, beforeAll } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot, type Root } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { format } from "node:util"
import { act } from "react"
import * as laziergitRuntime from "laziergit"

import { App } from "./app"
import type { ClipboardWriterSpec, ExternalOpener } from "./extension/context"
import { ExtensionKernel } from "./extension/kernel"
import { gitIsolationEnv } from "./git/test-repo"
import type { UiSlotRegistry } from "./ui/slots"

type Plugin = Parameters<UiSlotRegistry["register"]>[0]
type PluginErrorListener = Parameters<UiSlotRegistry["onPluginError"]>[0]

/**
 * A slot registry with no renderer behind it, for host tests that only care about what
 * was registered and how failures are reported.
 */
export function createFakeSlotRegistry() {
  const plugins = new Map<string, Plugin>()
  const errorListeners = new Set<PluginErrorListener>()
  const registry = {
    register(plugin: Plugin) {
      if (plugins.has(plugin.id)) throw new Error(`Plugin "${plugin.id}" is already registered`)
      plugins.set(plugin.id, plugin)
      return () => plugins.delete(plugin.id)
    },
    onPluginError(listener: PluginErrorListener) {
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
    },
  } as unknown as UiSlotRegistry

  return {
    registry,
    get pluginIds(): readonly string[] {
      return [...plugins.keys()]
    },
    get errorListenerCount(): number {
      return errorListeners.size
    },
    slotsOf(pluginId: string): readonly string[] {
      const plugin = plugins.get(pluginId)
      return plugin ? Object.keys(plugin.slots) : []
    },
    report(pluginId: string, error: Error): void {
      for (const listener of errorListeners) {
        listener({ pluginId, slot: pluginId, phase: "render", source: "react", error, timestamp: 0 })
      }
    },
  }
}

export interface Harness {
  readonly directory: string
  readonly configDirectory: string
  /** Bundled-scope Extension directory; created empty, so tests opt in by writing to it. */
  readonly bundled: string
  /** Global-scope Extension directory. */
  readonly global: string
  /** Repo-scope Extension directory. */
  readonly repo: string
  readonly themeGlobal: string
  readonly configFiles: { readonly global: string; readonly repo: string }
  readonly setup: Awaited<ReturnType<typeof createTestRenderer>>
  readonly kernel: ExtensionKernel
  root: Root | null
}

export interface HarnessOptions {
  readonly watch?: boolean
  readonly debounceMs?: number
  readonly pollMs?: number
  readonly width?: number
  readonly height?: number
  readonly onQuit?: () => void
  readonly clipboardWriters?: readonly ClipboardWriterSpec[]
  readonly openExternal?: ExternalOpener
  /** Opt into filesystem Theme discovery/schema publication for tests that exercise it. */
  readonly themes?: boolean
  /**
   * Toasts outlive any single test by default, because an expiry timer firing between two
   * assertions is an update no test could have waited for. Pass a short lifetime only where
   * expiry itself is the subject.
   */
  readonly toastLifetimeMs?: number
  /**
   * Initialise the harness directory as a git repository with one commit. Off by default:
   * a harness without one exercises the degraded path, where the store serves the empty
   * snapshot and nothing polls.
   */
  readonly git?: boolean
}

/**
 * Nulling the global config also nulls the developer's `init.defaultBranch`, so the branch name
 * is pinned per-command: on a git old enough to default to `master`, every test asserting on
 * `main` would otherwise fail for an unrelated reason.
 */
async function initRepository(directory: string): Promise<void> {
  const env = { ...process.env, ...gitIsolationEnv }
  const commands = [
    ["-c", "init.defaultBranch=main", "init", "--quiet"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
    ["config", "core.autocrlf", "false"],
  ] as const

  for (const args of commands) {
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}`)
  }
}

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

/**
 * The registry of the lifecycle currently accepting harnesses. Each `installHarnessLifecycle`
 * call owns its own list, so one file's teardown can only ever destroy harnesses that file
 * created — never a repository another file is still using.
 */
let activeHarnesses: Harness[] | null = null

/**
 * Registers the lifecycle every kernel test needs: the runtime module hooks Extensions
 * resolve `"laziergit"` through, React's act environment, teardown of every harness a test
 * created, and a trap that fails any test whose React updates escaped `act` — a leaked
 * update is work the test did not wait for, which is exactly how CI-only flakes start.
 * Call once at the top of a test file.
 */
export function installHarnessLifecycle(): void {
  const harnesses: Harness[] = []
  const leakedUpdates: string[] = []
  let hadActEnvironment = false
  let previousActEnvironment: boolean | undefined
  let originalConsoleError: typeof console.error | undefined

  beforeAll(() => {
    ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })
    hadActEnvironment = Object.hasOwn(actGlobal, "IS_REACT_ACT_ENVIRONMENT")
    previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true
    activeHarnesses = harnesses

    originalConsoleError = console.error
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("not wrapped in act")) {
        leakedUpdates.push(format(...args))
        return
      }
      originalConsoleError?.(...args)
    }
  })

  afterAll(() => {
    if (hadActEnvironment) actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    else delete actGlobal.IS_REACT_ACT_ENVIRONMENT
    if (originalConsoleError) console.error = originalConsoleError
    if (activeHarnesses === harnesses) activeHarnesses = null
  })

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      if (harness.root) {
        await act(async () => {
          await harness.kernel.stop()
          harness.root?.unmount()
          harness.root = null
          harness.setup.renderer.destroy()
        })
      } else {
        await harness.kernel.stop()
        harness.setup.renderer.destroy()
      }
      await rm(harness.directory, { recursive: true, force: true })
      await rm(harness.configDirectory, { recursive: true, force: true })
    }

    if (leakedUpdates.length > 0) {
      const details = leakedUpdates.splice(0).join("\n\n")
      throw new Error(
        `React updates escaped act during this test — wait for them with waitForFrame/waitFor:\n${details}`,
      )
    }
  })
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "laziergit-"))
  const configDirectory = await mkdtemp(join(tmpdir(), "laziergit-config-"))
  const bundled = join(directory, "bundled")
  const global = join(directory, "global")
  const repo = join(directory, "repo")
  const themeGlobal = join(configDirectory, "themes")
  await Promise.all([mkdir(bundled), mkdir(global), mkdir(repo), mkdir(themeGlobal)])
  if (options.git === true) await initRepository(directory)

  let setup!: Awaited<ReturnType<typeof createTestRenderer>>
  await act(async () => {
    setup = await createTestRenderer({ width: options.width ?? 100, height: options.height ?? 28 })
  })
  const configFiles = { global: join(configDirectory, "config.jsonc"), repo: join(directory, "repo.jsonc") }
  const kernel = new ExtensionKernel({
    repoRoot: directory,
    renderer: setup.renderer,
    directories: { bundled, global, repo },
    themeDirectory: themeGlobal,
    themeResources: options.themes ?? false,
    configFiles,
    watch: options.watch ?? false,
    debounceMs: options.debounceMs,
    pollMs: options.pollMs ?? options.debounceMs,
    onQuit: options.onQuit,
    clipboardWriters: options.clipboardWriters,
    openExternal: options.openExternal,
    toastLifetimeMs: options.toastLifetimeMs ?? 60_000,
  })
  const harness: Harness = {
    directory,
    configDirectory,
    bundled,
    global,
    repo,
    themeGlobal,
    configFiles,
    setup,
    kernel,
    root: null,
  }
  if (activeHarnesses === null) throw new Error("createHarness needs installHarnessLifecycle() at the top of the file")
  activeHarnesses.push(harness)
  return harness
}

export async function renderApp(harness: Harness): Promise<void> {
  harness.root = createRoot(harness.setup.renderer)
  act(() => harness.root?.render(<App kernel={harness.kernel} />))
  await act(async () => harness.kernel.start())
  await settle(harness)
}

/** Lets keymap dispatch, Command execution, and React commit all catch up. */
export async function settle(harness: Harness): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  await harness.setup.renderOnce()
  await harness.setup.renderOnce()
}

/**
 * A key press through the mock terminal, drained through dispatch and the React commit.
 * The Command a key starts is deliberately fire-and-forget in production, so this returns
 * while that work may still be running: assert its outcome with {@link waitForFrame} or
 * {@link waitFor}, never against the very next frame.
 */
export async function press(
  harness: Harness,
  key: string | (() => void),
  modifiers?: Parameters<Harness["setup"]["mockInput"]["pressKey"]>[1],
): Promise<void> {
  await act(async () => {
    if (typeof key === "function") key()
    else harness.setup.mockInput.pressKey(key, modifiers)
  })
  await settle(harness)
}

/**
 * A lone escape byte is only a key once the terminal parser has waited out the sequence it
 * could start, so this is the one press that must spend real time.
 */
export async function pressEscape(harness: Harness): Promise<void> {
  await act(async () => {
    harness.setup.mockInput.pressEscape()
    await Bun.sleep(60)
  })
  await settle(harness)
}

export interface WaitOptions {
  readonly timeoutMs?: number
}

/**
 * Polls until `condition` holds, settling the renderer between looks. The condition runs
 * inside `act` because it may await — shell out to git, say — while the store publishes and
 * Panes re-render. Timing out reports the last frame, so a CI log shows what the screen
 * actually held.
 */
export async function waitFor(
  harness: Harness,
  condition: () => boolean | Promise<boolean>,
  what: string,
  options: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  for (;;) {
    await settle(harness)
    let met = false
    await act(async () => {
      met = await condition()
    })
    if (met) return
    if (Date.now() >= deadline) break
    await act(async () => {
      await Bun.sleep(15)
    })
  }
  const diagnostics = harness.kernel.diagnostics
    .getSnapshot()
    .map((entry) => `${entry.phase}: ${entry.message}`)
    .join("\n")
  throw new Error(
    `Timed out waiting for ${what}. Last frame:\n${frame(harness)}\n` +
      (diagnostics.length === 0 ? "No diagnostics." : `Diagnostics:\n${diagnostics}`),
  )
}

/** Waits until the frame contains `expected` — or satisfies it, when given a predicate. */
export async function waitForFrame(
  harness: Harness,
  expected: string | ((screen: string) => boolean),
  options: WaitOptions = {},
): Promise<void> {
  const what = typeof expected === "string" ? `the frame to contain ${JSON.stringify(expected)}` : "the frame to match"
  await waitFor(
    harness,
    () => (typeof expected === "string" ? frame(harness).includes(expected) : expected(frame(harness))),
    what,
    options,
  )
}

/**
 * Runs a Command to completion, unlike the keyboard path, which cannot await it. For
 * behaviour tests; whether a key reaches the Command is a routing fact to assert off
 * `kernel.commands.getSnapshot()` or with one focused keyboard test.
 */
export async function runCommand(harness: Harness, id: string): Promise<void> {
  await act(async () => {
    await harness.kernel.commands.execute(id)
    await harness.kernel.events.drain()
  })
  await settle(harness)
}

/**
 * Publishes the store after a git mutation made behind the app's back, without waiting out
 * the fingerprint poll — tests that are about the poll itself configure a real interval.
 */
export async function refreshGit(harness: Harness): Promise<void> {
  await act(async () => {
    await harness.kernel.git.refresh()
  })
  await settle(harness)
}

export async function writeExtension(directory: string, name: string, source: string): Promise<void> {
  await writeFile(join(directory, name), source)
}

export function frame(harness: Harness): string {
  return harness.setup.captureCharFrame()
}

/**
 * The rows currently painted with the selection colour, trimmed, in screen order. The list
 * Panes draw no cursor marker — the highlight is the cursor. Only the spans carrying the
 * selection colour are joined: a screen line crosses every column, so taking the whole line
 * would append whatever the diff Pane is drawing beside the row.
 */
export function highlighted(harness: Harness): readonly string[] {
  const selection = RGBA.fromHex(harness.kernel.theme.getSnapshot().selection)
  return harness.setup
    .captureSpans()
    .lines.map((line) =>
      line.spans
        .filter((span) => span.bg?.equals(selection) === true)
        .map((span) => span.text)
        .join("")
        // Trailing only. The leading columns are a row's status pair, and `" M x"` versus
        // `"M  x"` is the difference between an unstaged and a staged file.
        .replace(/\s+$/, ""),
    )
    .filter((text) => text.trim().length > 0)
}
