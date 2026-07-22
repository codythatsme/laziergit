import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import * as laziergitRuntime from "laziergit"

import { App } from "./app"
import { ExtensionKernel } from "./extension/kernel"

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
      // laziergit owns focus policy: a click must not move focus out from under a popup.
      autoFocus: false,
      onDestroy() {
        rendererDestroyed = true
        resolveRendererDestroyed()
      },
    })
    const activeRenderer = renderer
    kernel = new ExtensionKernel({
      repoRoot: process.cwd(),
      renderer: activeRenderer,
      onQuit: () => {
        void (async () => {
          try {
            await kernel?.stop()
          } finally {
            activeRenderer.destroy()
          }
        })()
      },
    })

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
