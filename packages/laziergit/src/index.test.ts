import { describe, expect, it } from "bun:test"
import type * as Effect from "effect/Effect"

import { createCell, defineExtension, option } from "./index"

declare module "./types" {
  interface EventMap {
    "example.tick": void
    "someone-else.tick": { readonly value: number }
  }
}

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
