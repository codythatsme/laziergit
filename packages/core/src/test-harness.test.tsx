import { afterEach, expect, it } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createHarness, destroyHarness, installHarnessLifecycle, renderApp } from "./test-harness"

installHarnessLifecycle()

interface TeardownProbe {
  readonly log: string[]
  readonly deactivateStarted: () => void
  readonly releaseDeactivate: Promise<void>
}

const probeGlobal = globalThis as typeof globalThis & { __laziergitTeardownProbe?: TeardownProbe }

afterEach(() => {
  delete probeGlobal.__laziergitTeardownProbe
})

it("unmounts React before waiting for asynchronous kernel shutdown", async () => {
  const harness = await createHarness()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  probeGlobal.__laziergitTeardownProbe = {
    log: [],
    deactivateStarted: started.resolve,
    releaseDeactivate: release.promise,
  }
  await writeFile(
    join(harness.repo, "slow-shutdown.tsx"),
    `
      /** @jsxImportSource @opentui/react */
      import { defineExtension } from "laziergit"
      import { useEffect } from "react"

      const probe = (globalThis as any).__laziergitTeardownProbe
      export default defineExtension({
        name: "slow-shutdown",
        activate(ctx) {
          function SlowPane() {
            useEffect(() => {
              probe.log.push("mount")
              return () => probe.log.push("unmount")
            }, [])
            return <text content="slow shutdown" />
          }
          ctx.panes.register({ id: "slow-shutdown", title: "Slow shutdown", component: SlowPane })
        },
        async deactivate() {
          probe.log.push("deactivate")
          probe.deactivateStarted()
          await probe.releaseDeactivate
        },
      })
    `,
  )
  await renderApp(harness)
  expect(probeGlobal.__laziergitTeardownProbe.log).toEqual(["mount"])

  const cleanup = destroyHarness(harness)
  try {
    await started.promise
    expect(probeGlobal.__laziergitTeardownProbe.log).toEqual(["mount", "unmount", "deactivate"])
  } finally {
    release.resolve()
    await cleanup
  }
})
