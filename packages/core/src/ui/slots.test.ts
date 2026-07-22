import { expect, it, spyOn } from "bun:test"

import { Diagnostics } from "../extension/diagnostics"
import { createFakeSlotRegistry } from "../test-harness"
import { SlotOwners } from "./slots"

it("reports a render failure against the Extension that registered the plugin", () => {
  const fake = createFakeSlotRegistry()
  const diagnostics = new Diagnostics()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const owners = new SlotOwners()
  const dispose = owners.watch(fake.registry, diagnostics)

  owners.claim("pane:files.tree", "files")
  owners.claim("statusline:ci-status", "ci-status")
  fake.report("pane:files.tree", new Error("pane render exploded"))
  fake.report("statusline:ci-status", new Error("segment render exploded"))

  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ extension: "files", phase: "render", message: "pane render exploded" }),
    expect.objectContaining({ extension: "ci-status", phase: "render", message: "segment render exploded" }),
  ])

  dispose()
  expect(fake.errorListenerCount).toBe(0)
  errorSpy.mockRestore()
})

it("stays silent about a plugin nobody claims, rather than blaming the wrong Extension", () => {
  const fake = createFakeSlotRegistry()
  const diagnostics = new Diagnostics()
  const owners = new SlotOwners()
  owners.watch(fake.registry, diagnostics)

  owners.claim("pane:files.tree", "files")
  owners.release("pane:files.tree", "files")
  fake.report("pane:files.tree", new Error("render exploded after disposal"))

  expect(diagnostics.getSnapshot()).toEqual([])
})

it("keeps a claim a later owner took over until that owner releases it", () => {
  const owners = new SlotOwners()

  owners.claim("pane:shared", "first")
  owners.claim("pane:shared", "second")
  owners.release("pane:shared", "first")
  expect(owners.ownerOf("pane:shared")).toBe("second")

  owners.release("pane:shared", "second")
  expect(owners.ownerOf("pane:shared")).toBeUndefined()
})

it("contains a diagnostic reporter that throws while attributing a failure", () => {
  const fake = createFakeSlotRegistry()
  const diagnostics = {
    report() {
      throw new Error("diagnostic observer exploded")
    },
  }
  const owners = new SlotOwners()
  owners.watch(fake.registry, diagnostics as unknown as Diagnostics)
  owners.claim("pane:files.tree", "files")

  expect(() => fake.report("pane:files.tree", new Error("render exploded"))).not.toThrow()
})
