import { expect, it } from "bun:test"

import { createFakeSlotRegistry } from "../test-harness"
import { SlotOwners } from "../ui/slots"
import { PaneHost } from "./pane-host"

function createHost() {
  const fake = createFakeSlotRegistry()
  const owners = new SlotOwners()
  return { fake, owners, host: new PaneHost(fake.registry, owners) }
}

it("registers a Pane under its id and claims the plugin for its Extension", () => {
  const { fake, owners, host } = createHost()

  const pane = host.register("owner", { id: "owner.deep.pane", title: "Owned Pane", component: () => null })

  expect(fake.pluginIds).toEqual(["pane:owner.deep.pane"])
  expect(fake.slotsOf("pane:owner.deep.pane")).toEqual(["owner.deep.pane"])
  expect(owners.ownerOf("pane:owner.deep.pane")).toBe("owner")
  expect(host.isLive("owner.deep.pane")).toBe(true)

  pane.dispose()
  pane.dispose()
  expect(fake.pluginIds).toEqual([])
  expect(host.isLive("owner.deep.pane")).toBe(false)
})

it("refuses an id outside the owning Extension's scope, and a second live registration", () => {
  const { host } = createHost()

  expect(() => host.register("owner", { id: "other.pane", title: "Pane", component: () => null })).toThrow(
    'Extension "owner" cannot register id "other.pane"; expected "owner" or "owner.*"',
  )
  host.register("owner", { id: "owner.pane", title: "Pane", component: () => null })
  expect(() => host.register("owner", { id: "owner.pane", title: "Pane", component: () => null })).toThrow(
    'Pane "owner.pane" is already registered',
  )
})

it("holds a reloading Extension's Pane in place instead of collapsing its cell", () => {
  const { host } = createHost()
  const pane = host.register("owner", { id: "owner.pane", title: "Pane", component: () => null })

  host.prepareReload(["owner"])
  pane.dispose()
  expect(host.getSnapshot()).toEqual([
    expect.objectContaining({ id: "owner.pane", owner: "owner", state: "reloading" }),
  ])
  expect(host.isLive("owner.pane")).toBe(false)

  host.register("owner", { id: "owner.pane", title: "Pane", component: () => null })
  host.finishReload(["owner"])
  expect(host.isLive("owner.pane")).toBe(true)
})

it("drops a Pane the reloading Extension never registered again", () => {
  const { host } = createHost()
  const pane = host.register("owner", { id: "owner.pane", title: "Pane", component: () => null })

  host.prepareReload(["owner"])
  pane.dispose()
  host.finishReload(["owner"])

  expect(host.getSnapshot()).toEqual([])
})

it("leaves no plugin claim behind when registration fails", () => {
  const { fake, owners, host } = createHost()
  fake.registry.register({ id: "pane:owner.pane", slots: {} })

  expect(() => host.register("owner", { id: "owner.pane", title: "Pane", component: () => null })).toThrow()
  expect(owners.ownerOf("pane:owner.pane")).toBeUndefined()
})

it("isolates snapshot listener failures", () => {
  const { host } = createHost()
  host.register("owner", { id: "owner.one", title: "One", component: () => null })

  let healthyCalls = 0
  host.subscribe(() => {
    throw new Error("snapshot listener exploded")
  })
  host.subscribe(() => {
    healthyCalls += 1
  })

  expect(() => host.register("owner", { id: "owner.two", title: "Two", component: () => null })).not.toThrow()
  expect(healthyCalls).toBe(1)
  expect(host.isLive("owner.two")).toBe(true)
  expect(host.isLive("owner.missing")).toBe(false)
})
