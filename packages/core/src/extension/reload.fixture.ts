import type { PluginContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createReactSlotRegistry } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as laziergitRuntime from "laziergit"

import { ExtensionKernel } from "./kernel"
import type { PaneSlots } from "./pane-host"

ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })

interface FixtureState {
  lone?: string
  directory?: string
  lifecycle: string[]
}

const state = globalThis as typeof globalThis & { __laziergitReloadFixtureState?: FixtureState }
state.__laziergitReloadFixtureState = { lifecycle: [] }
const fixtureState = state.__laziergitReloadFixtureState

const directory = await mkdtemp(join(tmpdir(), "laziergit-reload-fixture-"))
const global = join(directory, "global")
const repo = join(directory, "repo")
await Promise.all([mkdir(global), mkdir(repo)])
const setup = await createTestRenderer({ width: 20, height: 8 })
const registry = createReactSlotRegistry<PaneSlots, PluginContext>(setup.renderer, {})
const kernel = new ExtensionKernel({
  repoRoot: directory,
  registry,
  directories: { global, repo },
  debounceMs: 10,
})
const entry = join(repo, "reload.ts")
const directoryEntry = join(repo, "directory-reload")

function loneSource(version: string): string {
  return `
    import { defineExtension } from "laziergit"
    const state = (globalThis as any).__laziergitReloadFixtureState
    export default defineExtension({
      name: "reload-fixture",
      activate(ctx) {
        state.lone = "${version}"
        state.lifecycle.push("lone:${version}:activate")
        ctx.onDispose(() => state.lifecycle.push("lone:${version}:dispose"))
      },
      deactivate() { state.lifecycle.push("lone:${version}:deactivate") },
    })
  `
}

function directorySource(): string {
  return `
    import { defineExtension } from "laziergit"
    import { version } from "./version"
    import localValue from "local-value"
    const state = (globalThis as any).__laziergitReloadFixtureState
    export default defineExtension({
      name: "directory-reload-fixture",
      activate(ctx) {
        state.directory = version + ":" + localValue
        state.lifecycle.push("directory:" + version + ":activate")
        ctx.onDispose(() => state.lifecycle.push("directory:" + version + ":dispose"))
      },
      deactivate() { state.lifecycle.push("directory:" + version + ":deactivate") },
    })
  `
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20)
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`)
}

async function cacheNames(): Promise<readonly string[]> {
  const names = await Promise.all([readdir(global), readdir(repo)])
  return names.flat().filter((name) => name.startsWith(".laziergit-cache-"))
}

function lifecycleCounts(prefix: "lone" | "directory") {
  const entries = fixtureState.lifecycle.filter((entry) => entry.startsWith(`${prefix}:`))
  return {
    activate: entries.filter((entry) => entry.endsWith(":activate")).length,
    deactivate: entries.filter((entry) => entry.endsWith(":deactivate")).length,
    dispose: entries.filter((entry) => entry.endsWith(":dispose")).length,
  }
}

try {
  await writeFile(entry, loneSource("first"))
  await kernel.start()
  await waitFor("initial lone-file activation", () => fixtureState.lone === "first")

  await writeFile(entry, loneSource("second"))
  await waitFor("lone-file watcher reload", () => fixtureState.lone === "second")

  const localDependency = join(directoryEntry, "node_modules", "local-value")
  await mkdir(localDependency, { recursive: true })
  await Promise.all([
    writeFile(join(directoryEntry, "package.json"), JSON.stringify({ main: "index.ts" })),
    writeFile(
      join(localDependency, "package.json"),
      JSON.stringify({ name: "local-value", type: "module", main: "index.js" }),
    ),
    writeFile(join(localDependency, "index.js"), `export default "local"`),
    writeFile(join(directoryEntry, "index.ts"), directorySource()),
    writeFile(join(directoryEntry, "version.ts"), `export const version = "first"`),
  ])
  await waitFor("directory Extension activation", () => fixtureState.directory === "first:local")

  await writeFile(join(directoryEntry, "version.ts"), `export const version = "second"`)
  await waitFor("directory helper reload", () => fixtureState.directory === "second:local")

  const liveCaches = await cacheNames()
  if (liveCaches.length !== 2) {
    throw new Error(`Expected one live cache per Extension; received ${liveCaches.join(", ")}`)
  }
  const generations = new Set(liveCaches.map((name) => /^\.laziergit-cache-\d+-(\d+)-/.exec(name)?.[1] ?? "missing"))
  if (generations.size !== 1 || generations.has("missing")) {
    throw new Error(`Expected one stable live generation; received ${[...generations].join(", ")}`)
  }

  for (const prefix of ["lone", "directory"] as const) {
    const counts = lifecycleCounts(prefix)
    if (counts.activate !== counts.deactivate + 1 || counts.deactivate !== counts.dispose) {
      throw new Error(`Unexpected live lifecycle counts for ${prefix}: ${JSON.stringify(counts)}`)
    }
  }

  const firstStop = kernel.stop()
  if (kernel.stop() !== firstStop) throw new Error("Expected repeated stop() calls to share one Promise")
  await firstStop

  for (const prefix of ["lone", "directory"] as const) {
    const counts = lifecycleCounts(prefix)
    if (counts.activate !== counts.deactivate || counts.deactivate !== counts.dispose) {
      throw new Error(`Unexpected stopped lifecycle counts for ${prefix}: ${JSON.stringify(counts)}`)
    }
  }
  if ((await cacheNames()).length !== 0) throw new Error("Expected stop() to remove every import copy")

  const activationsAfterStop = fixtureState.lifecycle.filter((entry) => entry.endsWith(":activate")).length
  await writeFile(entry, loneSource("third"))
  await Bun.sleep(100)
  const finalActivations = fixtureState.lifecycle.filter((entry) => entry.endsWith(":activate")).length
  if (finalActivations !== activationsAfterStop) throw new Error("Watcher rearmed after stop()")
} finally {
  await kernel.stop()
  setup.renderer.destroy()
  await rm(directory, { recursive: true, force: true })
  delete state.__laziergitReloadFixtureState
}
