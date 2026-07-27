import { afterAll, afterEach, beforeAll } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot, type Root } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import * as laziergitRuntime from "laziergit"

import { App } from "./app"
import type { ClipboardWriterSpec } from "./extension/context"
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
  /** Bundled-scope Extension directory; created empty, so tests opt in by writing to it. */
  readonly bundled: string
  /** Global-scope Extension directory. */
  readonly global: string
  /** Repo-scope Extension directory. */
  readonly repo: string
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

const harnesses: Harness[] = []
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let hadActEnvironment = false
let previousActEnvironment: boolean | undefined

/**
 * Registers the lifecycle every kernel test needs: the runtime module hooks Extensions
 * resolve `"laziergit"` through, React's act environment, and teardown of every harness
 * a test created. Call once at the top of a test file.
 */
export function installHarnessLifecycle(): void {
  beforeAll(() => {
    ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })
    hadActEnvironment = Object.hasOwn(actGlobal, "IS_REACT_ACT_ENVIRONMENT")
    previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterAll(() => {
    if (hadActEnvironment) actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    else delete actGlobal.IS_REACT_ACT_ENVIRONMENT
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
    }
  })
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "laziergit-"))
  const bundled = join(directory, "bundled")
  const global = join(directory, "global")
  const repo = join(directory, "repo")
  await Promise.all([mkdir(bundled), mkdir(global), mkdir(repo)])
  if (options.git === true) await initRepository(directory)

  let setup!: Awaited<ReturnType<typeof createTestRenderer>>
  await act(async () => {
    setup = await createTestRenderer({ width: options.width ?? 100, height: options.height ?? 28 })
  })
  const configFiles = { global: join(directory, "global.jsonc"), repo: join(directory, "repo.jsonc") }
  const kernel = new ExtensionKernel({
    repoRoot: directory,
    renderer: setup.renderer,
    directories: { bundled, global, repo },
    configFiles,
    watch: options.watch ?? false,
    debounceMs: options.debounceMs,
    pollMs: options.pollMs ?? options.debounceMs,
    onQuit: options.onQuit,
    clipboardWriters: options.clipboardWriters,
  })
  const harness: Harness = { directory, bundled, global, repo, configFiles, setup, kernel, root: null }
  harnesses.push(harness)
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

export async function writeExtension(directory: string, name: string, source: string): Promise<void> {
  await writeFile(join(directory, name), source)
}

export function frame(harness: Harness): string {
  return harness.setup.captureCharFrame()
}

/**
 * The rows currently painted with the selection colour, trimmed, in screen order. The list
 * Panes draw no cursor marker — the highlight is the cursor — so this reads the same fact off
 * the styled capture, proving the row the user sees lit in the colour the theme lights it.
 *
 * A list, not a single row, because "exactly one row is lit" is itself worth asserting. Only
 * the spans carrying the selection colour are joined: a screen line crosses every column, so
 * taking the whole line would append whatever the diff Pane is drawing beside the row.
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
