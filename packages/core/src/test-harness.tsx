import { afterAll, afterEach, beforeAll } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot, type Root } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import * as laziergitRuntime from "laziergit"

import { App } from "./app"
import { ExtensionKernel } from "./extension/kernel"
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
  const global = join(directory, "global")
  const repo = join(directory, "repo")
  await Promise.all([mkdir(global), mkdir(repo)])

  let setup!: Awaited<ReturnType<typeof createTestRenderer>>
  await act(async () => {
    setup = await createTestRenderer({ width: options.width ?? 100, height: options.height ?? 28 })
  })
  const configFiles = { global: join(directory, "global.jsonc"), repo: join(directory, "repo.jsonc") }
  const kernel = new ExtensionKernel({
    repoRoot: directory,
    renderer: setup.renderer,
    directories: { global, repo },
    configFiles,
    watch: options.watch ?? false,
    debounceMs: options.debounceMs,
    pollMs: options.pollMs ?? options.debounceMs,
    onQuit: options.onQuit,
  })
  const harness: Harness = { directory, global, repo, configFiles, setup, kernel, root: null }
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
