import { describe, expect, it } from "bun:test"

import { assertExtensionDefinition, createExtensionDefinition } from "./index"

describe("Extension definition brand", () => {
  it("accepts only definitions created by the shared factory", () => {
    const definition = createExtensionDefinition({ name: "example", activate: () => undefined })

    expect(() => assertExtensionDefinition(definition)).not.toThrow()
    expect(() => assertExtensionDefinition({ spec: definition.spec })).toThrow(
      "Default export must be defineExtension({...})",
    )
    expect(() => assertExtensionDefinition({ ...definition })).toThrow("Default export must be defineExtension({...})")
  })
})
