import type { PluginContext } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createReactSlotRegistry } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as laziergitRuntime from "laziergit"

import { ExtensionKernel } from "./kernel"
import type { PaneSlots } from "./pane-host"

ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })

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

function source(version: string): string {
  return `
    import { defineExtension } from "laziergit"
    export default defineExtension({
      name: "reload-fixture",
      activate() { ;(globalThis as any).__laziergitReloadFixture = "${version}" },
    })
  `
}

try {
  await writeFile(entry, source("first"))
  await kernel.start()
  await writeFile(entry, source("second"))

  const state = globalThis as typeof globalThis & { __laziergitReloadFixture?: string }
  const deadline = Date.now() + 2_000
  while (state.__laziergitReloadFixture !== "second" && Date.now() < deadline) await Bun.sleep(20)
  if (state.__laziergitReloadFixture !== "second") {
    throw new Error(`Expected watcher reload to activate second source; received ${state.__laziergitReloadFixture}`)
  }

  const localDependency = join(directoryEntry, "node_modules", "local-value")
  await mkdir(localDependency, { recursive: true })
  await Promise.all([
    writeFile(join(directoryEntry, "package.json"), JSON.stringify({ main: "index.ts" })),
    writeFile(
      join(localDependency, "package.json"),
      JSON.stringify({ name: "local-value", type: "module", main: "index.js" }),
    ),
    writeFile(join(localDependency, "index.js"), `export default "local"`),
    writeFile(
      join(directoryEntry, "index.ts"),
      `
        import { defineExtension } from "laziergit"
        import { version } from "./version"
        import localValue from "local-value"
        export default defineExtension({
          name: "directory-reload-fixture",
          activate() { ;(globalThis as any).__laziergitDirectoryReloadFixture = version + ":" + localValue },
        })
      `,
    ),
    writeFile(join(directoryEntry, "version.ts"), `export const version = "first"`),
  ])

  const readDirectoryVersion = () =>
    (globalThis as typeof globalThis & { __laziergitDirectoryReloadFixture?: string }).__laziergitDirectoryReloadFixture
  const directoryLoadDeadline = Date.now() + 2_000
  while (readDirectoryVersion() !== "first:local" && Date.now() < directoryLoadDeadline) {
    await Bun.sleep(20)
  }
  if (readDirectoryVersion() !== "first:local") {
    throw new Error("Expected directory extension to activate")
  }

  await writeFile(join(directoryEntry, "version.ts"), `export const version = "second"`)
  const helperReloadDeadline = Date.now() + 2_000
  while (readDirectoryVersion() !== "second:local" && Date.now() < helperReloadDeadline) {
    await Bun.sleep(20)
  }
  if (readDirectoryVersion() !== "second:local") {
    throw new Error(`Expected changed directory helper to reload; received ${readDirectoryVersion()}`)
  }
} finally {
  await kernel.stop()
  setup.renderer.destroy()
  await rm(directory, { recursive: true, force: true })
}
