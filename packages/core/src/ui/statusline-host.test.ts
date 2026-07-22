import { expect, it } from "bun:test"
import type { StatusSegmentSpec } from "laziergit"

import type { StatuslineConfig } from "../config/config"
import { createFakeSlotRegistry } from "../test-harness"
import { segmentSlotName, SlotOwners } from "./slots"
import { StatuslineHost, type StatusSegment } from "./statusline-host"

function createRegistry() {
  return createFakeSlotRegistry()
}

function spec(id: string, placement: Omit<StatusSegmentSpec, "id" | "component"> = {}): StatusSegmentSpec {
  return { id, component: () => null, ...placement }
}

function config(overrides: Partial<StatuslineConfig> = {}): StatuslineConfig {
  return { left: [], right: [], hidden: new Set<string>(), ...overrides }
}

function ids(segments: readonly StatusSegment[]): readonly string[] {
  return segments.map((segment) => segment.id)
}

it("refuses a segment id outside the owning Extension's scope", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())

  expect(() => host.register("owner", spec("other.segment"))).toThrow(
    'Extension "owner" cannot register id "other.segment"; expected "owner" or "owner.*"',
  )
  expect(() => host.register("owner", spec("ownership.segment"))).toThrow()
  expect(() => host.register("owner", spec("owner"))).not.toThrow()
  expect(() => host.register("owner", spec("owner.deep.segment"))).not.toThrow()
})

it("refuses a second segment claiming a registered id", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())
  host.register("owner", spec("owner.clock"))

  expect(() => host.register("owner", spec("owner.clock"))).toThrow(
    'Status segment "owner.clock" is already registered',
  )
  expect(ids(host.getSnapshot().left)).toEqual(["owner.clock"])
})

it("registers each segment as its own slot plugin and retires it on disposal", () => {
  const fake = createRegistry()
  const host = new StatuslineHost(fake.registry, new SlotOwners())

  const segment = host.register("owner", spec("owner.clock"))
  expect(fake.pluginIds).toEqual([segmentSlotName("owner.clock")])
  expect(fake.slotsOf(segmentSlotName("owner.clock"))).toEqual([segmentSlotName("owner.clock")])

  segment.dispose()
  segment.dispose()
  expect(fake.pluginIds).toEqual([])
  expect(host.getSnapshot()).toEqual({ left: [], right: [] })
})

it("places an unconfigured segment on the left at priority 100", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())
  host.register("owner", spec("owner.clock"))

  expect(host.getSnapshot()).toEqual({
    left: [{ id: "owner.clock", owner: "owner", align: "left", priority: 100 }],
    right: [],
  })
})

it("orders unlisted segments by priority, then by id", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())
  host.register("owner", spec("owner.late", { priority: 200 }))
  host.register("owner", spec("owner.b"))
  host.register("owner", spec("owner.a"))
  host.register("owner", spec("owner.early", { priority: 10 }))
  host.register("owner", spec("owner.tail", { align: "right", priority: 5 }))

  expect(ids(host.getSnapshot().left)).toEqual(["owner.early", "owner.a", "owner.b", "owner.late"])
  expect(ids(host.getSnapshot().right)).toEqual(["owner.tail"])
})

it("puts configured ids first in the written order, overriding the segment's own align", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())
  host.register("owner", spec("owner.branch", { align: "right", priority: 1 }))
  host.register("owner", spec("owner.clock", { align: "right" }))
  host.register("owner", spec("owner.ahead", { priority: 1 }))
  host.register("owner", spec("owner.dirty", { align: "right", priority: 50 }))

  host.setConfig(config({ left: ["owner.clock", "owner.branch"], right: ["owner.dirty"] }))

  expect(ids(host.getSnapshot().left)).toEqual(["owner.clock", "owner.branch", "owner.ahead"])
  expect(ids(host.getSnapshot().right)).toEqual(["owner.dirty"])
})

it("hides a segment from both sides even when the same id is listed", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())
  host.register("owner", spec("owner.clock"))
  host.register("owner", spec("owner.noisy", { align: "right" }))
  host.register("owner", spec("owner.pinned"))

  host.setConfig(
    config({ left: ["owner.pinned"], right: ["owner.noisy"], hidden: new Set(["owner.noisy", "owner.pinned"]) }),
  )

  expect(host.getSnapshot()).toEqual({
    left: [{ id: "owner.clock", owner: "owner", align: "left", priority: 100 }],
    right: [],
  })
})

it("skips configured ids that no segment has registered", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())
  host.register("owner", spec("owner.clock"))

  host.setConfig(config({ left: ["owner.missing", "owner.clock"], right: ["other.absent"] }))

  expect(ids(host.getSnapshot().left)).toEqual(["owner.clock"])
  expect(ids(host.getSnapshot().right)).toEqual([])
})

it("republishes the snapshot on every change without letting a throwing subscriber poison registration", () => {
  const host = new StatuslineHost(createRegistry().registry, new SlotOwners())
  let healthyCalls = 0
  host.subscribe(() => {
    throw new Error("snapshot listener exploded")
  })
  const unsubscribe = host.subscribe(() => {
    healthyCalls += 1
  })

  expect(() => host.register("owner", spec("owner.clock"))).not.toThrow()
  expect(healthyCalls).toBe(1)

  host.setConfig(config({ hidden: new Set(["owner.clock"]) }))
  expect(healthyCalls).toBe(2)
  expect(host.getSnapshot()).toEqual({ left: [], right: [] })

  unsubscribe()
  host.register("owner", spec("owner.other"))
  expect(healthyCalls).toBe(2)
})
