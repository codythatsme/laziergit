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
import { createMacModifierReader, enableLegacyModifiedKeys, recoverModifiedBackspace } from "./terminal-keyboard"

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
  const macModifiers = await createMacModifierReader()
  let rendererDestroyed = false
  let resolveRendererDestroyed: () => void = () => undefined
  const rendererDestruction = new Promise<void>((resolve) => {
    resolveRendererDestroyed = resolve
  })

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      // OpenTUI's default Kitty negotiation omits event reporting, which Warp needs.
      useKittyKeyboard: { events: true },
      prependInputHandlers: [
        (sequence) =>
          renderer?.capabilities?.remote === true
            ? false
            : recoverModifiedBackspace(sequence, macModifiers, renderer?.keyInput),
      ],
      // laziergit owns focus policy: a click must not move focus out from under a popup.
      autoFocus: false,
      onDestroy() {
        macModifiers.close()
        terminalControl?.close()
        rendererDestroyed = true
        resolveRendererDestroyed()
      },
    })
    const activeRenderer = renderer
    // OpenTUI starts at modifyOtherKeys level 1; raise to level 2 until a Kitty response
    // arrives — if one does, OpenTUI disables this mode before pushing Kitty flags.
    enableLegacyModifiedKeys(activeRenderer.capabilities, (sequence) => process.stdout.write(sequence))
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
      macModifiers.close()
      if (renderer && !rendererDestroyed) renderer.destroy()
      if (renderer) await rendererDestruction
    }
  }
}

if (import.meta.main) {
  await main()
}
