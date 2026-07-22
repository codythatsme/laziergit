import { createCliRenderer, type PluginContext } from "@opentui/core"
import { createReactSlotRegistry, createRoot } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import * as laziergitRuntime from "laziergit"

import { App } from "./app"
import { ExtensionKernel } from "./extension/kernel"
import type { PaneSlots } from "./extension/pane-host"

export async function main() {
  ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined
  let kernel: ExtensionKernel | undefined
  let rendererDestroyed = false
  let resolveRendererDestroyed: () => void = () => undefined
  const rendererDestruction = new Promise<void>((resolve) => {
    resolveRendererDestroyed = resolve
  })

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      onDestroy() {
        rendererDestroyed = true
        resolveRendererDestroyed()
      },
    })
    const registry = createReactSlotRegistry<PaneSlots, PluginContext>(renderer, {})
    kernel = new ExtensionKernel({ repoRoot: process.cwd(), registry })

    createRoot(renderer).render(<App kernel={kernel} />)
    await kernel.start()
    await rendererDestruction
  } finally {
    try {
      await kernel?.stop()
    } finally {
      if (renderer && !rendererDestroyed) renderer.destroy()
      if (renderer) await rendererDestruction
    }
  }
}

if (import.meta.main) {
  await main()
}
