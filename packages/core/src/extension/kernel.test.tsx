import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { PluginContext } from "@opentui/core"
import { createReactSlotRegistry, createRoot, type Root } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import * as laziergitRuntime from "laziergit"
import { StaleContextError, type ExtensionContext, type PaneHandle } from "laziergit"

import { App } from "../app"
import { ExtensionKernel } from "./kernel"
import type { PaneSlots } from "./pane-host"

interface Harness {
  readonly directory: string
  readonly global: string
  readonly repo: string
  readonly setup: Awaited<ReturnType<typeof createTestRenderer>>
  readonly kernel: ExtensionKernel
  root: Root | null
}

const harnesses: Harness[] = []

beforeAll(() => {
  ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })
})

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.kernel.stop()
    act(() => {
      harness.root?.unmount()
      harness.root = null
      harness.setup.renderer.destroy()
    })
    await rm(harness.directory, { recursive: true, force: true })
  }
})

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "laziergit-m1-"))
  const global = join(directory, "global")
  const repo = join(directory, "repo")
  await Promise.all([mkdir(global), mkdir(repo)])
  const setup = await createTestRenderer({ width: 100, height: 28 })
  const registry = createReactSlotRegistry<PaneSlots, PluginContext>(setup.renderer, {})
  const kernel = new ExtensionKernel({
    repoRoot: directory,
    registry,
    directories: { global, repo },
    watch: false,
  })
  const harness = { directory, global, repo, setup, kernel, root: null }
  harnesses.push(harness)
  return harness
}

function testGlobals() {
  return globalThis as typeof globalThis & {
    __laziergitLifecycle?: string[]
    __laziergitOldContext?: ExtensionContext
    __laziergitOldHandle?: PaneHandle
    __laziergitDependentActivated?: boolean
    __laziergitSurvivorActivated?: boolean
    __laziergitEventTailRan?: boolean
  }
}

describe("ExtensionKernel lifecycle", () => {
  it("activates needs in order and disposes dependents before providers", async () => {
    const harness = await createHarness()
    testGlobals().__laziergitLifecycle = []

    await writeFile(
      join(harness.global, "provider.ts"),
      `
        import { defineExtension } from "laziergit"
        const log = (value: string) => (globalThis as any).__laziergitLifecycle.push(value)
        export default defineExtension({
          name: "provider",
          activate(ctx) {
            log("provider:activate")
            ctx.onDispose(() => log("provider:dispose"))
            return { value: 42 }
          },
          deactivate() { log("provider:deactivate") },
        })
      `,
    )
    await writeFile(
      join(harness.repo, "consumer.ts"),
      `
        import { defineExtension } from "laziergit"
        const log = (value: string) => (globalThis as any).__laziergitLifecycle.push(value)
        export default defineExtension({
          name: "consumer",
          needs: ["provider"],
          activate(ctx) {
            log("consumer:activate:" + (ctx.extensions.get("provider") as any).value)
            ctx.onDispose(() => log("consumer:dispose"))
          },
          deactivate() { log("consumer:deactivate") },
        })
      `,
    )

    await harness.kernel.start()
    expect(testGlobals().__laziergitLifecycle).toEqual(["provider:activate", "consumer:activate:42"])

    await harness.kernel.reload()
    expect(testGlobals().__laziergitLifecycle).toEqual([
      "provider:activate",
      "consumer:activate:42",
      "consumer:deactivate",
      "consumer:dispose",
      "provider:deactivate",
      "provider:dispose",
      "provider:activate",
      "consumer:activate:42",
    ])
    expect(harness.kernel.getSnapshot().filter((entry) => entry.state === "active")).toHaveLength(2)
  })

  it("poisons stale Context surfaces while leaving signal and late disposal safe", async () => {
    const harness = await createHarness()
    await writeFile(
      join(harness.repo, "capture.ts"),
      `
        import { defineExtension } from "laziergit"
        export default defineExtension({
          name: "capture",
          activate(ctx) {
            ;(globalThis as any).__laziergitOldContext = ctx
            ;(globalThis as any).__laziergitOldHandle = ctx.panes.register({
              id: "capture",
              title: "Capture",
              component: () => null,
            })
          },
        })
      `,
    )

    await harness.kernel.start()
    const oldContext = testGlobals().__laziergitOldContext
    const oldHandle = testGlobals().__laziergitOldHandle
    expect(oldContext?.signal.aborted).toBe(false)

    await harness.kernel.reload()
    expect(oldContext?.signal.aborted).toBe(true)
    expect(() => oldContext?.config).toThrow(StaleContextError)
    expect(() => oldHandle?.focus()).toThrow(StaleContextError)
    expect(() => oldHandle?.dispose()).not.toThrow()
  })

  it("isolates activation and event-handler failures", async () => {
    const harness = await createHarness()
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    testGlobals().__laziergitDependentActivated = false
    testGlobals().__laziergitSurvivorActivated = false
    testGlobals().__laziergitEventTailRan = false

    await Promise.all([
      writeFile(
        join(harness.repo, "broken.ts"),
        `
          import { defineExtension } from "laziergit"
          export default defineExtension({
            name: "broken",
            activate() { throw new Error("activation exploded") },
          })
        `,
      ),
      writeFile(
        join(harness.repo, "dependent.ts"),
        `
          import { defineExtension } from "laziergit"
          export default defineExtension({
            name: "dependent",
            needs: ["broken"],
            activate() { ;(globalThis as any).__laziergitDependentActivated = true },
          })
        `,
      ),
      writeFile(
        join(harness.repo, "survivor.ts"),
        `
          import { defineExtension } from "laziergit"
          export default defineExtension({
            name: "survivor",
            activate(ctx) {
              ;(globalThis as any).__laziergitSurvivorActivated = true
              ctx.events.on("survivor.tick" as any, () => { throw new Error("handler exploded") })
              ctx.events.on("survivor.tick" as any, () => { ;(globalThis as any).__laziergitEventTailRan = true })
              ctx.events.emit("survivor.tick" as any)
            },
          })
        `,
      ),
    ])

    await harness.kernel.start()
    await harness.kernel.events.drain()

    expect(testGlobals().__laziergitDependentActivated).toBe(false)
    expect(testGlobals().__laziergitSurvivorActivated).toBe(true)
    expect(testGlobals().__laziergitEventTailRan).toBe(true)
    expect(harness.kernel.getSnapshot().find((entry) => entry.name === "broken")?.message).toBe("activation exploded")
    expect(harness.kernel.getSnapshot().find((entry) => entry.name === "dependent")?.message).toBe(
      'Required extension "broken" failed',
    )
    expect(harness.kernel.diagnostics.getSnapshot().map((entry) => entry.phase)).toContain("event")
    errorSpy.mockRestore()
  })
})

describe("M1 debug Layout", () => {
  it("contains a thrown Pane without crashing the app", async () => {
    const harness = await createHarness()
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    const extensionPath = join(harness.repo, "toy.tsx")

    await writeFile(
      extensionPath,
      `
        /** @jsxImportSource @opentui/react */
        import { defineExtension } from "laziergit"
        export default defineExtension({
          name: "toy",
          activate(ctx) {
            function ToyPane() { throw new Error("toy render exploded") }
            ctx.panes.register({ id: "toy", title: "Toy", component: ToyPane })
          },
        })
      `,
    )

    harness.root = createRoot(harness.setup.renderer)
    act(() => harness.root?.render(<App kernel={harness.kernel} />))
    await act(async () => harness.kernel.start())
    await harness.setup.renderOnce()
    await harness.setup.renderOnce()
    expect(harness.setup.captureCharFrame()).toContain("Pane crashed")
    expect(harness.setup.captureCharFrame()).toContain("toy render exploded")
    expect(harness.setup.captureCharFrame()).toContain("M1 extension kernel")
    errorSpy.mockRestore()
  })

  it("hot reloads changed source under the real Bun runtime", () => {
    const fixture = join(import.meta.dir, "reload.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixture], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
  })
})
