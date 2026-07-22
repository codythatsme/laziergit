import { expect, it, spyOn } from "bun:test"

import { Diagnostics, normalizeError } from "./diagnostics"

it("publishes diagnostics despite throwing console and snapshot listeners", () => {
  const diagnostics = new Diagnostics()
  const calls: string[] = []
  const errorSpy = spyOn(console, "error").mockImplementation(() => {
    throw new Error("console observer exploded")
  })
  diagnostics.subscribe(() => {
    calls.push("broken")
    throw new Error("snapshot observer exploded")
  })
  diagnostics.subscribe(() => calls.push("healthy"))

  expect(() =>
    diagnostics.report({
      extension: "owner",
      phase: "event",
      message: "handler exploded",
      error: new Error("handler exploded"),
    }),
  ).not.toThrow()

  expect(calls).toEqual(["broken", "healthy"])
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({
      extension: "owner",
      phase: "event",
      message: "handler exploded",
    }),
  ])
  errorSpy.mockRestore()
})

it("normalizes values whose string conversion fails", () => {
  const error = normalizeError({
    toString() {
      throw new Error("conversion exploded")
    },
  })

  expect(error.message).toBe("Unknown error")
})
