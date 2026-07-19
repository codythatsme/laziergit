import { createCliRenderer, type PluginContext } from "@opentui/core"
import { createReactSlotRegistry, createRoot } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import * as laziergitRuntime from "laziergit"

import { App } from "./app"
import { ExtensionKernel } from "./extension/kernel"
import type { PaneSlots } from "./extension/pane-host"

export async function main() {
  ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const registry = createReactSlotRegistry<PaneSlots, PluginContext>(renderer, {})
  const kernel = new ExtensionKernel({ repoRoot: process.cwd(), registry })
  registry.configure({
    onPluginError(failure) {
      kernel.diagnostics.report({
        extension: failure.pluginId.replace(/^pane:/, ""),
        phase: "render",
        message: failure.error.message,
        error: failure.error,
      })
    },
  })

  renderer.once("destroy", () => {
    void kernel.stop()
  })

  createRoot(renderer).render(<App kernel={kernel} />)
  await kernel.start()
}

if (import.meta.main) {
  await main()
}
