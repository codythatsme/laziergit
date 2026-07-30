import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { CliRenderEvents } from "@opentui/core"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"
import { StaleContextError, type ExtensionContext, type PaneHandle } from "laziergit"

import { parseJsonc } from "../config/jsonc"
import { createHarness, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"
import { importCopyContainerName, importCopyIgnoreName } from "./discovery"
import { findThemePreset } from "./theme"
import type { ChoosePopup } from "../ui/popup-host"

installHarnessLifecycle()

afterEach(() => {
  const globals = testGlobals()
  delete globals.__laziergitLifecycle
  delete globals.__laziergitOldContext
  delete globals.__laziergitOldHandle
  delete globals.__laziergitDependentActivated
  delete globals.__laziergitSurvivorActivated
  delete globals.__laziergitEventTailRan
  delete globals.__laziergitApiLog
  delete globals.__laziergitCallableHandle
  delete globals.__laziergitVoidObserved
  delete globals.__laziergitWatcherActivations
  delete globals.__laziergitThemeMounts
  delete globals.__laziergitLayeredScope
})

function testGlobals() {
  return globalThis as typeof globalThis & {
    __laziergitLifecycle?: string[]
    __laziergitOldContext?: ExtensionContext
    __laziergitOldHandle?: PaneHandle
    __laziergitDependentActivated?: boolean
    __laziergitSurvivorActivated?: boolean
    __laziergitEventTailRan?: boolean
    __laziergitApiLog?: string[]
    __laziergitCallableHandle?: (() => void) & { dispose(): void }
    __laziergitVoidObserved?: boolean
    __laziergitWatcherActivations?: number
    __laziergitThemeMounts?: number
    __laziergitLayeredScope?: string
  }
}

/**
 * Live import copies, which live in each Extension directory's cache container. The
 * container's own `.gitignore` is bookkeeping rather than a copy, so it is filtered out —
 * these counts are assertions about how many generations are alive.
 */
async function cacheNames(harness: Harness): Promise<readonly string[]> {
  const names = await Promise.all(
    [harness.bundled, harness.global, harness.repo].map((directory) =>
      readdir(join(directory, importCopyContainerName)).catch(() => []),
    ),
  )
  return names
    .flat()
    .filter((name) => name !== importCopyIgnoreName)
    .sort()
}

async function runFixture(path: string, cwd: string, timeoutMs = 5_000): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, path], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`Fixture exceeded ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const exitCode = await Promise.race([child.exited, deadline])
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
    if (exitCode !== 0) {
      throw new Error(`Fixture exited ${exitCode}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`)
    }
    return { stdout: stdoutText, stderr: stderrText }
  } finally {
    if (timeout) clearTimeout(timeout)
    child.kill()
  }
}

function paneSource(body: string): string {
  return `
    /** @jsxImportSource @opentui/react */
    import { defineExtension } from "laziergit"
    export default defineExtension({
      name: "recoverable",
      activate(ctx) {
        ${body}
      },
    })
  `
}

function topChoice(harness: Harness): ChoosePopup {
  const popup = harness.kernel.popups.top
  if (popup?.kind !== "choose") throw new Error(`Expected a chooser, found ${popup?.kind ?? "nothing"}`)
  return popup
}

function themePreset(name: string) {
  const found = findThemePreset(name)
  if (!found) throw new Error(`Missing test theme "${name}"`)
  return found
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

  it("supports live void, callable, thenable, and callable Disposable Exported APIs", async () => {
    const harness = await createHarness()
    testGlobals().__laziergitApiLog = []
    testGlobals().__laziergitVoidObserved = false

    await Promise.all([
      writeFile(
        join(harness.repo, "void-provider.ts"),
        `
          import { defineExtension } from "laziergit"
          export default defineExtension({ name: "void-provider", activate() {} })
        `,
      ),
      writeFile(
        join(harness.repo, "api-provider.ts"),
        `
          import { defineExtension } from "laziergit"
          const log = (value: string) => (globalThis as any).__laziergitApiLog.push(value)
          export default defineExtension({
            name: "api-provider",
            activate() {
              return Object.assign(
                (value: string) => ({ then(resolve: (value: string) => void) { resolve("call:" + value) } }),
                {
                  method() { return { then(resolve: (value: string) => void) { resolve("method:thenable") } } },
                  handle() {
                    return Object.assign(
                      () => log("handle:call"),
                      { dispose() { log("handle:dispose") } },
                    )
                  },
                },
              )
            },
          })
        `,
      ),
      writeFile(
        join(harness.repo, "api-consumer.ts"),
        `
          import { defineExtension } from "laziergit"
          const log = (value: string) => (globalThis as any).__laziergitApiLog.push(value)
          export default defineExtension({
            name: "api-consumer",
            needs: ["void-provider", "api-provider"],
            async activate(ctx) {
              ;(globalThis as any).__laziergitVoidObserved = ctx.extensions.get("void-provider") === undefined
              const api = ctx.extensions.get("api-provider") as any
              log(await api("value"))
              log(await api.method())
              const handle = api.handle()
              ;(globalThis as any).__laziergitCallableHandle = handle
              handle()
            },
          })
        `,
      ),
    ])

    await harness.kernel.start()
    expect(harness.kernel.getExtensionApi("void-provider")).toEqual({ state: "live", api: undefined })
    expect(testGlobals().__laziergitVoidObserved).toBe(true)
    expect(testGlobals().__laziergitApiLog).toEqual(["call:value", "method:thenable", "handle:call"])
    const oldHandle = testGlobals().__laziergitCallableHandle

    await harness.kernel.reload()
    expect(() => oldHandle?.()).toThrow(StaleContextError)
    expect(() => oldHandle?.dispose()).not.toThrow()
    expect(testGlobals().__laziergitApiLog).toEqual([
      "call:value",
      "method:thenable",
      "handle:call",
      "handle:dispose",
      "call:value",
      "method:thenable",
      "handle:call",
    ])
  })

  it("isolates activation and event-handler failures", async () => {
    const harness = await createHarness()
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    testGlobals().__laziergitDependentActivated = false
    testGlobals().__laziergitSurvivorActivated = false
    testGlobals().__laziergitEventTailRan = false

    try {
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
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("attempts deactivate, scope cleanup, activation removal, and lease release independently", async () => {
    const harness = await createHarness()
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    testGlobals().__laziergitLifecycle = []

    try {
      await writeFile(
        join(harness.repo, "cleanup.ts"),
        `
          import { defineExtension } from "laziergit"
          const log = (value: string) => (globalThis as any).__laziergitLifecycle.push(value)
          export default defineExtension({
            name: "cleanup",
            activate(ctx) {
              ctx.onDispose(() => log("dispose:survivor"))
              ctx.onDispose(() => { log("dispose:failure"); throw new Error("dispose exploded") })
            },
            deactivate() { log("deactivate"); throw new Error("deactivate exploded") },
          })
        `,
      )

      await harness.kernel.start()
      expect(await cacheNames(harness)).toHaveLength(1)
      await harness.kernel.stop()

      expect(testGlobals().__laziergitLifecycle).toEqual(["deactivate", "dispose:failure", "dispose:survivor"])
      expect(await cacheNames(harness)).toEqual([])
      expect(harness.kernel.getExtensionApi("cleanup")).toEqual({ state: "missing" })
      expect(harness.kernel.diagnostics.getSnapshot().map((entry) => entry.phase)).toEqual(
        expect.arrayContaining(["deactivate", "dispose"]),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("keeps exactly one live cache generation across repeated reloads and removes it on stop", async () => {
    const harness = await createHarness()
    testGlobals().__laziergitLifecycle = []
    await writeFile(
      join(harness.repo, "repeat.ts"),
      `
        import { defineExtension } from "laziergit"
        const log = (value: string) => (globalThis as any).__laziergitLifecycle.push(value)
        export default defineExtension({
          name: "repeat",
          activate(ctx) { log("activate"); ctx.onDispose(() => log("dispose")) },
          deactivate() { log("deactivate") },
        })
      `,
    )

    await harness.kernel.start()
    expect(await cacheNames(harness)).toHaveLength(1)
    await harness.kernel.reload()
    expect(await cacheNames(harness)).toHaveLength(1)
    await harness.kernel.reload()
    expect(await cacheNames(harness)).toHaveLength(1)

    expect(testGlobals().__laziergitLifecycle).toEqual([
      "activate",
      "deactivate",
      "dispose",
      "activate",
      "deactivate",
      "dispose",
      "activate",
    ])

    await harness.kernel.stop()
    expect(await cacheNames(harness)).toEqual([])
    expect(testGlobals().__laziergitLifecycle).toEqual([
      "activate",
      "deactivate",
      "dispose",
      "activate",
      "deactivate",
      "dispose",
      "activate",
      "deactivate",
      "dispose",
    ])
  })

  it("memoizes stop and prevents watcher rearm after shutdown begins", async () => {
    const harness = await createHarness({ watch: true, debounceMs: 25 })
    const entry = join(harness.repo, "watched.ts")
    testGlobals().__laziergitWatcherActivations = 0
    const source = (version: string) => `
      import { defineExtension } from "laziergit"
      export default defineExtension({
        name: "watched",
        activate() {
          ;(globalThis as any).__laziergitWatcherActivations += 1
          ;(globalThis as any).__laziergitWatcherVersion = "${version}"
        },
      })
    `

    await writeFile(entry, source("first"))
    await harness.kernel.start()
    await writeFile(entry, source("second"))
    await Bun.sleep(30)

    const firstStop = harness.kernel.stop()
    const secondStop = harness.kernel.stop()
    expect(secondStop).toBe(firstStop)
    await firstStop
    const activationsAfterStop = testGlobals().__laziergitWatcherActivations

    await writeFile(entry, source("third"))
    await Bun.sleep(120)
    expect(testGlobals().__laziergitWatcherActivations).toBe(activationsAfterStop)
    expect(await cacheNames(harness)).toEqual([])
  })

  it("contains throwing kernel observers without poisoning reload", async () => {
    const harness = await createHarness()
    let healthyNotifications = 0
    harness.kernel.subscribe(() => {
      throw new Error("observer exploded")
    })
    harness.kernel.subscribe(() => {
      healthyNotifications += 1
    })
    await writeFile(
      join(harness.repo, "observer.ts"),
      `
        import { defineExtension } from "laziergit"
        export default defineExtension({ name: "observer", activate() {} })
      `,
    )

    await harness.kernel.start()
    await harness.kernel.reload()

    expect(healthyNotifications).toBeGreaterThan(0)
    expect(harness.kernel.getSnapshot()).toEqual([expect.objectContaining({ name: "observer", state: "active" })])
  })
})

describe("Extension discovery and import boundary", () => {
  it("reports malformed entries while valid siblings survive", async () => {
    const harness = await createHarness()
    await mkdir(join(harness.repo, "malformed"))
    await writeFile(join(harness.repo, "malformed", "package.json"), "{")
    await writeFile(
      join(harness.repo, "survivor.ts"),
      `
        import { defineExtension } from "laziergit"
        export default defineExtension({ name: "survivor", activate() {} })
      `,
    )

    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await harness.kernel.start()
    } finally {
      errorSpy.mockRestore()
    }

    expect(harness.kernel.getSnapshot()).toEqual([
      expect.objectContaining({ path: join(harness.repo, "malformed"), state: "failed" }),
      expect.objectContaining({ name: "survivor", state: "active" }),
    ])
    expect(await cacheNames(harness)).toHaveLength(1)
  })

  it("retains import-copy leases only for selected live activations", async () => {
    const harness = await createHarness()
    const source = (name: string, value: string) => `
      import { defineExtension } from "laziergit"
      export default defineExtension({
        name: "${name}",
        activate() { ;(globalThis as any).__selectedLease = "${value}" },
      })
    `
    await Promise.all([
      writeFile(join(harness.global, "shadow.ts"), source("shadow", "global")),
      writeFile(join(harness.repo, "shadow.ts"), source("shadow", "repo")),
      writeFile(join(harness.repo, "duplicate-a.ts"), source("duplicate", "first")),
      writeFile(join(harness.repo, "duplicate-b.ts"), source("duplicate", "second")),
    ])

    await harness.kernel.start()

    expect(harness.kernel.getSnapshot().filter((entry) => entry.state === "active")).toHaveLength(2)
    expect(harness.kernel.getSnapshot().filter((entry) => entry.state === "shadowed")).toHaveLength(1)
    expect(harness.kernel.getSnapshot().filter((entry) => entry.state === "failed")).toHaveLength(1)
    expect(await cacheNames(harness)).toHaveLength(2)
  })

  it("activates bundled Extensions and lets global, then repo, shadow them", async () => {
    const harness = await createHarness()
    const source = (scope: string) => `
      import { defineExtension } from "laziergit"
      export default defineExtension({
        name: "layered",
        activate() { ;(globalThis as any).__laziergitLayeredScope = "${scope}" },
      })
    `
    const shadowed = () =>
      harness.kernel
        .getSnapshot()
        .filter((entry) => entry.state === "shadowed")
        .map((entry) => `${entry.scope}: ${entry.message}`)

    await writeFile(join(harness.bundled, "layered.ts"), source("bundled"))
    await harness.kernel.start()

    expect(testGlobals().__laziergitLayeredScope).toBe("bundled")
    expect(harness.kernel.getSnapshot()).toEqual([
      expect.objectContaining({ name: "layered", scope: "bundled", state: "active" }),
    ])

    await writeFile(join(harness.global, "layered.ts"), source("global"))
    await harness.kernel.reload()

    expect(testGlobals().__laziergitLayeredScope).toBe("global")
    expect(shadowed()).toEqual([`bundled: Shadowed by global extension "layered"`])

    await writeFile(join(harness.repo, "layered.ts"), source("repo"))
    await harness.kernel.reload()

    expect(testGlobals().__laziergitLayeredScope).toBe("repo")
    expect(shadowed()).toEqual([
      `bundled: Shadowed by repo extension "layered"`,
      `global: Shadowed by repo extension "layered"`,
    ])
    // One live import copy: the two shadowed candidates released theirs.
    expect(await cacheNames(harness)).toHaveLength(1)
  })

  it("never creates the bundled directory, which belongs to the installation", async () => {
    const harness = await createHarness()
    await rm(harness.bundled, { recursive: true })
    await writeFile(
      join(harness.repo, "solo.ts"),
      `
        import { defineExtension } from "laziergit"
        export default defineExtension({ name: "solo", activate() {} })
      `,
    )

    await harness.kernel.start()

    expect(
      await stat(harness.bundled).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(harness.kernel.getSnapshot()).toEqual([expect.objectContaining({ name: "solo", state: "active" })])
  })

  it("rejects structurally valid objects that lack the shared brand", async () => {
    const harness = await createHarness()
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await writeFile(
        join(harness.repo, "forged.ts"),
        `
          export default {
            spec: {
              name: "forged",
              activate() {},
            },
          }
        `,
      )

      await harness.kernel.start()
      expect(harness.kernel.getSnapshot()).toEqual([
        expect.objectContaining({ state: "failed", message: "Default export must be defineExtension({...})" }),
      ])
      expect(await cacheNames(harness)).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("runs the Effect escape hatch against the live git service", async () => {
    const harness = await createHarness()
    await writeFile(
      join(harness.repo, "effect-user.ts"),
      `
        import { defineExtension } from "laziergit"
        export default defineExtension({
          name: "effect-user",
          async activate(ctx) {
            // The Effect face of the store, run through the only door core opens.
            const state = await ctx.effect.runPromise(ctx.effect.git.state)
            return { head: state.head.kind, clean: state.status.isClean }
          },
        })
      `,
    )

    await harness.kernel.start()
    expect(harness.kernel.getSnapshot()).toEqual([expect.objectContaining({ name: "effect-user", state: "active" })])
    // This harness makes no repository, and the Effect face reports that as such rather than
    // as an unborn HEAD — the same answer the Promise face gives.
    expect(harness.kernel.getExtensionApi("effect-user")).toEqual({
      state: "live",
      api: { head: "noRepository", clean: true },
    })
  })

  it("refuses to publish a core event through the Effect escape hatch", async () => {
    const harness = await createHarness()
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await writeFile(
        join(harness.repo, "spoofer.ts"),
        `
          import { defineExtension } from "laziergit"
          export default defineExtension({
            name: "spoofer",
            async activate(ctx) {
              // The Effect door must be the same gate as ctx.events.emit, not a way around it.
              await ctx.effect.runPromise(ctx.effect.events.publish("git.head.changed"))
            },
          })
        `,
      )

      await harness.kernel.start()
      expect(harness.kernel.getSnapshot()).toEqual([expect.objectContaining({ name: "spoofer", state: "failed" })])
      expect(harness.kernel.getSnapshot()[0]?.message).toContain("spoofer")
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("serialized reload recovery", () => {
  it("heals after an unexpected reload failure and always clears Pane reload state", async () => {
    const harness = await createHarness()
    const entry = join(harness.repo, "recoverable.tsx")
    await writeFile(
      entry,
      paneSource(`
        function RecoverablePane() { return <text>healthy</text> }
        ctx.panes.register({ id: "recoverable", title: "Recoverable", component: RecoverablePane })
      `),
    )
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)

    try {
      await harness.kernel.start()
      expect(harness.kernel.panes.getSnapshot()).toEqual([
        expect.objectContaining({ id: "recoverable", state: "active" }),
      ])

      const originalFinish = harness.kernel.panes.finishReload.bind(harness.kernel.panes)
      let failOnce = true
      harness.kernel.panes.finishReload = (owners) => {
        originalFinish(owners)
        if (failOnce) {
          failOnce = false
          throw new Error("unexpected reload failure")
        }
      }
      await harness.kernel.reload()
      harness.kernel.panes.finishReload = originalFinish

      expect(harness.kernel.diagnostics.getSnapshot()).toEqual([
        expect.objectContaining({ phase: "reload", message: "unexpected reload failure" }),
      ])

      await writeFile(entry, paneSource(`throw new Error("activation failed")`))
      await harness.kernel.reload()
      expect(harness.kernel.panes.getSnapshot()).toEqual([])
      expect(harness.kernel.getSnapshot()).toEqual([
        expect.objectContaining({ name: "recoverable", state: "failed", message: "activation failed" }),
      ])

      await writeFile(
        entry,
        paneSource(`
          function RecoverablePane() { return <text>recovered</text> }
          ctx.panes.register({ id: "recoverable", title: "Recoverable", component: RecoverablePane })
        `),
      )
      await harness.kernel.reload()
      expect(harness.kernel.panes.getSnapshot()).toEqual([
        expect.objectContaining({ id: "recoverable", state: "active" }),
      ])
      expect(harness.kernel.getSnapshot()).toEqual([expect.objectContaining({ name: "recoverable", state: "active" })])
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("Theme resources", () => {
  it("does not discover repository theme directories", async () => {
    const harness = await createHarness({ themes: true })
    const repositoryThemes = join(harness.directory, ".laziergit", "themes")
    await mkdir(repositoryThemes, { recursive: true })
    await writeFile(
      join(repositoryThemes, "repo-only.json"),
      JSON.stringify({
        name: "repo-only",
        extends: "nocturne",
        tokens: { accent: "#123456" },
      }),
    )

    await harness.kernel.start()

    const configSchema = JSON.parse(await readFile(join(harness.configDirectory, "config.schema.json"), "utf8")) as {
      properties: { theme: { properties: { preset: { oneOf: [{ enum: string[] }] } } } }
    }
    expect(configSchema.properties.theme.properties.preset.oneOf[0].enum).not.toContain("repo-only")
  })

  it("hot reloads a global theme without remounting its consumers", async () => {
    const harness = await createHarness({ watch: true, debounceMs: 20, pollMs: 10, themes: true })
    testGlobals().__laziergitThemeMounts = 0
    const themePath = join(harness.themeGlobal, "custom.json")
    await Promise.all([
      writeFile(
        themePath,
        JSON.stringify({
          name: "custom",
          appearance: "dark",
          extends: "nocturne",
          tokens: { accent: "#123456" },
        }),
      ),
      writeFile(harness.configFiles.global, `{ "theme": { "preset": "custom" } }`),
      writeFile(
        join(harness.repo, "theme-resource-pane.tsx"),
        `
          /** @jsxImportSource @opentui/react */
          import { defineExtension, useTheme } from "laziergit"
          import { useState } from "react"
          export default defineExtension({
            name: "theme-resource-pane",
            activate(ctx) {
              function Pane() {
                const theme = useTheme()
                const [mount] = useState(() => ++(globalThis as any).__laziergitThemeMounts)
                return <text>{theme.accent + ":mount:" + mount}</text>
              }
              ctx.panes.register({ id: "theme-resource-pane", title: "Theme", component: Pane })
            },
          })
        `,
      ),
    ])

    await renderApp(harness)
    expect(harness.setup.captureCharFrame()).toContain("#123456:mount:1")

    await act(async () => {
      await writeFile(
        themePath,
        JSON.stringify({
          name: "custom",
          appearance: "dark",
          extends: "nocturne",
          tokens: { accent: "#abcdef" },
        }),
      )
      await Bun.sleep(120)
    })
    await settle(harness)

    expect(harness.setup.captureCharFrame()).toContain("#abcdef:mount:1")
    expect(testGlobals().__laziergitThemeMounts).toBe(1)

    await act(async () => {
      await writeFile(themePath, `{ "name": "custom", "tokens": }`)
      await Bun.sleep(120)
    })
    await settle(harness)
    expect(harness.setup.captureCharFrame()).toContain("#abcdef:mount:1")
    expect(harness.kernel.diagnostics.getSnapshot().some((entry) => entry.message.includes(themePath))).toBeTrue()

    const configSchema = JSON.parse(await readFile(join(harness.configDirectory, "config.schema.json"), "utf8")) as {
      properties: { theme: { properties: { preset: { oneOf: [{ enum: string[] }] } } } }
    }
    expect(configSchema.properties.theme.properties.preset.oneOf[0].enum).toContain("custom")
    expect(await readFile(join(harness.configDirectory, "theme.schema.json"), "utf8")).toContain('"laziergit theme"')
  })

  it("follows terminal appearance for a dark/light pair without reloading config", async () => {
    const harness = await createHarness()
    await writeFile(
      harness.configFiles.global,
      `{ "theme": { "preset": { "dark": "nocturne", "light": "daybreak" } } }`,
    )
    await harness.kernel.start()

    expect(harness.kernel.theme.getSnapshot().background).toBe(themePreset("nocturne").tokens.background)
    harness.setup.renderer.emit(CliRenderEvents.THEME_MODE, "light")
    expect(harness.kernel.theme.getSnapshot().background).toBe(themePreset("daybreak").tokens.background)
    harness.setup.renderer.emit(CliRenderEvents.THEME_MODE, "dark")
    expect(harness.kernel.theme.getSnapshot().background).toBe(themePreset("nocturne").tokens.background)
  })

  it("shows names only, previews a picker choice, and persists it globally", async () => {
    const harness = await createHarness()
    await harness.kernel.start()
    const before = harness.kernel.theme.getSnapshot()

    const flow = harness.kernel.openThemePicker()
    const themes = topChoice(harness)
    expect(themes.choices.every((choice) => choice.hint === undefined)).toBeTrue()
    expect(themes.choices.some((choice) => choice.label.startsWith("Automatic"))).toBeFalse()
    const emberIndex = themes.choices.findIndex((choice) => choice.label === "ember")
    expect(emberIndex).toBeGreaterThanOrEqual(0)
    themes.highlight(emberIndex)
    expect(harness.kernel.theme.getSnapshot().accent).toBe(themePreset("ember").tokens.accent)
    themes.choose(emberIndex)
    await flow

    expect(parseJsonc(await readFile(harness.configFiles.global, "utf8"))).toEqual({
      theme: { preset: "ember" },
    })
    expect(await stat(harness.configFiles.repo).catch(() => undefined)).toBeUndefined()
    expect(harness.kernel.theme.getSnapshot().accent).toBe(themePreset("ember").tokens.accent)
    expect(harness.kernel.theme.getSnapshot()).not.toBe(before)
  })
})

describe("Application shell", () => {
  it("uses one root runtime provider and rerenders Theme consumers without remounting the Pane", async () => {
    const harness = await createHarness()
    testGlobals().__laziergitThemeMounts = 0
    await writeFile(
      join(harness.repo, "theme-pane.tsx"),
      `
        /** @jsxImportSource @opentui/react */
        import { defineExtension, useTheme } from "laziergit"
        import { useState } from "react"
        export default defineExtension({
          name: "theme-pane",
          activate(ctx) {
            function ThemePane() {
              const theme = useTheme()
              const [mount] = useState(() => ++(globalThis as any).__laziergitThemeMounts)
              return <text>{theme.accent + ":mount:" + mount}</text>
            }
            ctx.panes.register({ id: "theme-pane", title: "Theme", component: ThemePane })
          },
        })
      `,
    )

    await renderApp(harness)
    expect(harness.setup.captureCharFrame()).toContain(`${harness.kernel.theme.getSnapshot().accent}:mount:1`)
    expect(testGlobals().__laziergitThemeMounts).toBe(1)

    await act(async () => {
      harness.kernel.theme.replace({ ...harness.kernel.theme.getSnapshot(), accent: "#abcdef" })
    })
    await harness.setup.renderOnce()
    await harness.setup.renderOnce()

    expect(harness.setup.captureCharFrame()).toContain("#abcdef:mount:1")
    expect(testGlobals().__laziergitThemeMounts).toBe(1)
  })

  it("spells no core default with `mod+`, which a terminal is free to keep for itself", async () => {
    const harness = await createHarness()

    // `mod+` resolves to cmd wherever the keyboard protocol can *report* it, which says
    // nothing about whether the terminal will *deliver* it.
    const modBound = harness.kernel.commands
      .getSnapshot()
      // Every key, not any: a `mod+` spelling paired with a plain one is the sanctioned form,
      // and an unbound Command has nothing to lose.
      .filter((entry) => entry.keys.length > 0 && entry.keys.every((key) => /(^|[+,\s])mod\s*\+/i.test(key)))
      .map((entry) => `${entry.id}: ${entry.keys.join(" / ")}`)

    expect(modBound).toEqual([])
    expect(harness.kernel.commands.getSnapshot().find((entry) => entry.id === "app.palette")?.keys).toEqual([
      "ctrl+p",
      ":",
    ])
  })

  it("contains a thrown Pane without crashing the app", async () => {
    const harness = await createHarness()
    const errorMessages: string[] = []
    const errorSpy = spyOn(console, "error").mockImplementation((...args) => {
      errorMessages.push(args.map(String).join(" "))
    })
    const extensionPath = join(harness.repo, "toy.tsx")

    try {
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
              ctx.commands.register({ id: "toy.act", title: "Act", hint: "act", keys: "z", pane: "toy", run: () => undefined })
            },
          })
        `,
      )

      await renderApp(harness)
      expect(harness.setup.captureCharFrame()).toContain("Pane crashed")
      expect(harness.setup.captureCharFrame()).toContain("toy render exploded")
      // The rest of the shell is still drawing: the Pane's own hints are on the bottom row
      // even though the Pane above them threw.
      expect(harness.setup.captureCharFrame()).toContain("z act")
      expect(errorMessages.some((message) => message.includes("not wrapped in act"))).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("hot reloads changed source under the real Bun runtime", async () => {
    const fixture = join(import.meta.dir, "reload.fixture.ts")
    const result = await runFixture(fixture, join(import.meta.dir, "../.."))
    expect(result.stderr).toBe("")
  })
})
