#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { ensureRuntimePluginSupport } from "@opentui/react/runtime-plugin-support/configure"
import { provideTerminalControl } from "@kitlangton/terminal-control-opentui"
import { resolve } from "node:path"
import * as laziergitRuntime from "laziergit"

import { App } from "./app"
import { defaultExtensionDirectories } from "./extension/discovery"
import { ExtensionKernel } from "./extension/kernel"
import { discoverRepository } from "./git/repository"

/**
 * Bundled Extensions ship next to core inside the installation, so they are located relative
 * to this module. Resolving from `process.cwd()` would look inside whichever repository
 * laziergit was launched in and find nothing.
 */
const bundledExtensionDirectory = resolve(import.meta.dir, "..", "..", "..", "extensions")

export async function main() {
  ensureRuntimePluginSupport({ additional: { laziergit: laziergitRuntime } })

  // Walking up from the cwd is what makes `laziergit` work from a subdirectory. Outside a
  // repository the cwd stands in: the app still starts, with an empty store and a diagnostic.
  const repository = await discoverRepository(process.cwd())
  const repoRoot = repository?.root ?? process.cwd()

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined
  let terminalControl: ReturnType<typeof provideTerminalControl> | undefined
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
        terminalControl?.close()
        rendererDestroyed = true
        resolveRendererDestroyed()
      },
    })
    const activeRenderer = renderer
    terminalControl = provideTerminalControl(activeRenderer, {
      application: { name: "laziergit", version: "0.0.0" },
    })
    kernel = new ExtensionKernel({
      repoRoot,
      renderer: activeRenderer,
      directories: defaultExtensionDirectories(repoRoot, bundledExtensionDirectory),
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
    if (!repository) {
      // Said in the app rather than on stdout, which the renderer owns by now.
      kernel.notifications.publish({
        extension: "app",
        message: `${repoRoot} is not a git repository`,
        level: "warning",
      })
    }
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
