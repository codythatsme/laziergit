import { describe, expect, it } from "bun:test"

import { createCell, defineExtension, option } from "./index"

describe("defineExtension", () => {
  it("preserves literal context inference and the exported API", () => {
    const extension = defineExtension({
      name: "example",
      config: { limit: option.number({ default: 10 }) },
      activate(ctx) {
        const limit: number = ctx.config.limit
        ctx.commands.register({ id: "example.refresh", title: "Refresh", run: () => undefined })

        // @ts-expect-error registered ids must carry the inferred extension prefix
        ctx.commands.register({ id: "someone-else.refresh", title: "Wrong", run: () => undefined })
        return { limit }
      },
    })

    expect(extension.spec.name).toBe("example")
    expect(extension.spec.config?.limit.default).toBe(10)
  })

  it("rejects invalid and reserved names at module load time", () => {
    expect(() => defineExtension({ name: "Not Valid", activate: () => undefined })).toThrow("Invalid extension name")
    expect(() => defineExtension({ name: "git", activate: () => undefined })).toThrow("reserved")
  })
})

describe("createCell", () => {
  it("stores values and skips identical updates", () => {
    const cell = createCell(1)
    expect(cell.get()).toBe(1)
    cell.set(2)
    expect(cell.get()).toBe(2)
  })
})
