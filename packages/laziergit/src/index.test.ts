import { describe, expect, it } from "bun:test"
import type * as Effect from "effect/Effect"

import { createCell, createRowSource, defineExtension, option, toneColor, type Theme, type Tone } from "./index"
import type { ConfigSchema, ConfigValues } from "./types"

declare module "./types" {
  interface EventMap {
    "example.tick": void
    "someone-else.tick": { readonly value: number }
  }
}

describe("config schema", () => {
  it("correlates kind with default, and carries each variant's own constraints", () => {
    const schema = {
      limit: option.number({ default: 10, min: 1, max: 100 }),
      mode: option.enum(["unified", "split"], { default: "unified" }),
      names: option.stringArray({ default: [] }),
      title: option.string({ default: "" }),
      wrap: option.boolean({ default: true }),
    } satisfies ConfigSchema

    // @ts-expect-error a number option's default must be a number
    const mismatched = { limit: { kind: "number", default: "none" } } satisfies ConfigSchema
    void mismatched

    const values: ConfigValues<typeof schema> = {
      limit: 1,
      mode: "split",
      names: ["a"],
      title: "t",
      wrap: false,
    }
    expect(values.mode).toBe("split")

    // @ts-expect-error an enum value is one of its declared spellings, not any string
    const offEnum: ConfigValues<typeof schema>["mode"] = "sideways"
    void offEnum

    // `min`/`max` and `values` are reachable without a shadow type.
    expect(schema.limit.min).toBe(1)
    expect(schema.mode.values).toEqual(["unified", "split"])
  })

  it("refuses a default that its own bounds exclude, at definition time", () => {
    expect(() => option.number({ default: 0, min: 1, max: 10 })).toThrow("below min")
    expect(() => option.number({ default: 20, min: 1, max: 10 })).toThrow("above max")
    expect(() => option.number({ default: 5, min: 10, max: 1 })).toThrow("exceeds max")
    // Caught twice over: a compile error, and still a throw for an untypechecked Extension.
    // @ts-expect-error a default outside its declared values is also a compile error
    expect(() => option.enum(["a", "b"], { default: "c" })).toThrow("not one of its declared values")
  })
})

describe("defineExtension", () => {
  it("preserves literal context inference and narrows the Effect escape hatch", () => {
    const extension = defineExtension({
      name: "example",
      config: { limit: option.number({ default: 10 }) },
      activate(ctx) {
        const limit: number = ctx.config.limit
        ctx.commands.register({ id: "example.refresh", title: "Refresh", run: () => undefined })
        void ctx.effect.events.publish("example.tick")
        void ctx.effect.events.stream("someone-else.tick")

        const provided = undefined as unknown as Effect.Effect<number, Error, never>
        const result: Promise<number> = ctx.effect.runPromise(provided)
        void result

        const requiresService = undefined as unknown as Effect.Effect<number, never, { readonly service: true }>
        // @ts-expect-error runPromise accepts only fully provided Effects
        void ctx.effect.runPromise(requiresService)
        // @ts-expect-error an Extension may emit only its own events
        void ctx.effect.events.publish("someone-else.tick", { value: 1 })
        // @ts-expect-error raw ManagedRuntime access is not public
        void ctx.effect.runtime
        // @ts-expect-error service keys are not public
        void ctx.effect.keys

        // @ts-expect-error registered ids must carry the inferred extension prefix
        ctx.commands.register({ id: "someone-else.refresh", title: "Wrong", run: () => undefined })
        return { limit }
      },
    })

    expect(extension.spec.name).toBe("example")
    expect(extension.spec.config?.limit.default).toBe(10)
  })

  it("normalizes and deeply freezes definition data", () => {
    const source = {
      name: "example",
      description: "Example Extension",
      needs: ["provider"],
      config: {
        count: { kind: "number", default: 2, min: 1, max: 3 },
        mode: { kind: "enum", values: ["compact", "full"], default: "compact" },
        labels: { kind: "string-array", default: ["one"] },
      },
      activate: () => undefined,
    } as const

    const extension = defineExtension(source)
    ;(source.needs as unknown as string[]).push("later")
    ;(source.config.labels.default as unknown as string[]).push("two")

    expect(extension.spec.needs).toEqual(["provider"])
    expect(extension.spec.config?.labels.default).toEqual(["one"])
    expect(Object.isFrozen(extension)).toBe(true)
    expect(Object.isFrozen(extension.spec)).toBe(true)
    expect(Object.isFrozen(extension.spec.needs)).toBe(true)
    expect(Object.isFrozen(extension.spec.config)).toBe(true)
    expect(Object.isFrozen(extension.spec.config?.mode)).toBe(true)
    expect(Object.isFrozen(extension.spec.config?.mode.values)).toBe(true)
    expect(Object.isFrozen(extension.spec.config?.labels.default)).toBe(true)
  })

  it("rejects malformed definitions before module activation", () => {
    const activate = () => undefined
    const invalid: readonly [spec: unknown, message: string][] = [
      [{ name: "Not Valid", activate }, "Invalid extension name"],
      [{ name: "git", activate }, "reserved"],
      [{ name: "example", description: 42, activate }, "description must be a string"],
      [{ name: "example" }, "must provide activate(ctx)"],
      [{ name: "example", activate, deactivate: true }, "deactivate must be a function"],
      [{ name: "example", activate, needs: "provider" }, "needs must be an array"],
      [{ name: "example", activate, needs: ["Not Valid"] }, "Invalid need"],
      [{ name: "example", activate, needs: ["provider", "provider"] }, "duplicate"],
      [{ name: "example", activate, config: { value: { kind: "object", default: {} } } }, "invalid kind"],
      [{ name: "example", activate, config: { value: { kind: "string", default: 1 } } }, "must be a string"],
      [{ name: "example", activate, config: { value: { kind: "number", default: Number.NaN } } }, "finite"],
      [
        { name: "example", activate, config: { value: { kind: "number", default: 2, min: 3, max: 1 } } },
        "min must not exceed max",
      ],
      [{ name: "example", activate, config: { value: { kind: "number", default: 0, min: 1 } } }, "at least min"],
      [
        { name: "example", activate, config: { value: { kind: "enum", values: ["a", "a"], default: "a" } } },
        "values must be unique",
      ],
      [
        { name: "example", activate, config: { value: { kind: "enum", values: ["a"], default: "b" } } },
        "one of its declared values",
      ],
      [
        { name: "example", activate, config: { value: { kind: "string-array", default: ["ok", 1] } } },
        "array of strings",
      ],
    ]

    for (const [spec, message] of invalid) {
      expect(() => defineExtension(spec as never)).toThrow(message)
    }
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

/** Distinct per token, so a mapping that reached for the wrong one is visible. */
const theme: Theme = {
  text: "#text",
  textMuted: "#muted",
  accent: "#accent",
  success: "#success",
  warning: "#warning",
  danger: "#danger",
  info: "#info",
  background: "#background",
  backgroundPanel: "#panel",
  border: "#border",
  borderFocused: "#borderFocused",
  selection: "#selection",
  diffAdded: "#added",
  diffRemoved: "#removed",
}

describe("toneColor", () => {
  it("maps every tone to a theme token, and no tone to ordinary text", () => {
    // Both sides are mapped over Tone, so a new tone fails to compile until it is asserted.
    const resolved: { readonly [K in Tone]: string } = {
      neutral: toneColor(theme, "neutral"),
      info: toneColor(theme, "info"),
      success: toneColor(theme, "success"),
      warning: toneColor(theme, "warning"),
      danger: toneColor(theme, "danger"),
      muted: toneColor(theme, "muted"),
    }
    const expected: { readonly [K in Tone]: string } = {
      neutral: theme.text,
      info: theme.info,
      success: theme.success,
      warning: theme.warning,
      danger: theme.danger,
      muted: theme.textMuted,
    }

    expect(resolved).toEqual(expected)
    expect(toneColor(theme, undefined)).toBe(theme.text)
  })
})

describe("createRowSource", () => {
  it("reports the row the Pane last selected", () => {
    const host = createRowSource<{ name: string }>({ key: (row) => row.name })

    expect(host.api.selected()).toBeUndefined()
    host.setSelected({ name: "one" })
    expect(host.api.selected()).toEqual({ name: "one" })
    host.setSelected(undefined)
    expect(host.api.selected()).toBeUndefined()
  })

  it("keeps a decoration handle usable — as a no-op — after it is disposed", () => {
    const host = createRowSource<{ name: string }>({ key: (row) => row.name })
    let calls = 0
    const handle = host.api.decorateRows(() => {
      calls += 1
      return undefined
    })

    handle.dispose()
    expect(() => handle.refresh()).not.toThrow()
    expect(() => handle.dispose()).not.toThrow()
    expect(calls).toBe(0)
  })

  it("registers the same provider function twice as two providers", () => {
    const host = createRowSource<{ name: string }>({ key: (row) => row.name })
    const provider = () => undefined

    const first = host.api.decorateRows(provider)
    const second = host.api.decorateRows(provider)
    expect(first).not.toBe(second)
    expect(() => {
      first.dispose()
      second.dispose()
    }).not.toThrow()
  })
})
