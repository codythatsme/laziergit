import { expect, it, spyOn } from "bun:test"
import type { PluginContext, PluginErrorEvent, SlotRegistry } from "@opentui/core"
import type { ReactNode } from "react"

import { Diagnostics } from "./diagnostics"
import { PaneHost, type PaneSlots } from "./pane-host"

type Registry = SlotRegistry<ReactNode, PaneSlots, PluginContext>
type Plugin = Parameters<Registry["register"]>[0]
type PluginErrorListener = Parameters<Registry["onPluginError"]>[0]

function createRegistry() {
  const plugins = new Map<string, Plugin>()
  const errorListeners = new Set<PluginErrorListener>()
  const registry = {
    register(plugin: Plugin) {
      plugins.set(plugin.id, plugin)
      return () => plugins.delete(plugin.id)
    },
    onPluginError(listener: PluginErrorListener) {
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
    },
  } as unknown as Registry

  return {
    registry,
    get errorListenerCount() {
      return errorListeners.size
    },
    report(pluginId: string, error: Error) {
      const event: PluginErrorEvent = {
        pluginId,
        slot: pluginId.replace(/^pane:/, ""),
        phase: "render",
        source: "react",
        error,
        timestamp: Date.now(),
      }
      for (const listener of errorListeners) listener(event)
    },
  }
}

it("attributes delayed registry errors through the real Pane owner mapping", () => {
  const fake = createRegistry()
  const diagnostics = new Diagnostics()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const host = new PaneHost(fake.registry, diagnostics)

  const pane = host.register("owner", {
    id: "owner.deep.pane",
    title: "Owned Pane",
    component: () => null,
  })
  host.prepareReload(["owner"])
  pane.dispose()
  fake.report("pane:owner.deep.pane", new Error("render exploded after disposal"))

  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({
      extension: "owner",
      phase: "render",
      message: "render exploded after disposal",
    }),
  ])

  host.stop()
  host.stop()
  expect(fake.errorListenerCount).toBe(0)
  fake.report("pane:owner.deep.pane", new Error("ignored after stop"))
  expect(diagnostics.getSnapshot()).toHaveLength(1)
  errorSpy.mockRestore()
})

it("contains diagnostic reporter failures from the registry listener", () => {
  const fake = createRegistry()
  const diagnostics = {
    report() {
      throw new Error("diagnostic observer exploded")
    },
  } as unknown as Diagnostics
  const host = new PaneHost(fake.registry, diagnostics)
  host.register("owner", { id: "owner.pane", title: "Pane", component: () => null })

  expect(() => fake.report("pane:owner.pane", new Error("render exploded"))).not.toThrow()
  host.stop()
})

it("isolates snapshot and focus listener failures", () => {
  const fake = createRegistry()
  const host = new PaneHost(fake.registry)
  host.register("owner", { id: "owner.one", title: "One", component: () => null })
  host.register("owner", { id: "owner.two", title: "Two", component: () => null })

  let healthyCalls = 0
  host.subscribe(() => {
    throw new Error("snapshot listener exploded")
  })
  host.subscribe(() => {
    healthyCalls += 1
  })
  host.setFocusListener(() => {
    throw new Error("focus listener exploded")
  })

  expect(() => host.focus("owner.two")).not.toThrow()
  expect(host.focused).toBe("owner.two")
  expect(healthyCalls).toBe(1)
})
