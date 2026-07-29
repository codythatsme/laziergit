import { describe, expect, it } from "bun:test"
import type { KeyHandler, TerminalCapabilities } from "@opentui/core"

import {
  createMacModifierReader,
  enableLegacyModifiedKeys,
  modifyOtherKeysLevelTwo,
  recoverModifiedBackspace,
  type MacModifier,
  type MacModifierReader,
} from "./terminal-keyboard"

function modifiers(...pressed: MacModifier[]): MacModifierReader {
  return {
    isPressed: (modifier) => pressed.includes(modifier),
    close: () => undefined,
  }
}

function input() {
  const events: Parameters<KeyHandler["processParsedKey"]>[0][] = []
  return {
    events,
    keyInput: {
      processParsedKey(event: Parameters<KeyHandler["processParsedKey"]>[0]) {
        events.push(event)
        return true
      },
    } as KeyHandler,
  }
}

describe("macOS modified Backspace recovery", () => {
  it("turns a terminal-stripped Option+Backspace into word deletion input", () => {
    const sink = input()

    expect(recoverModifiedBackspace("\u007f", modifiers("option"), sink.keyInput)).toBe(true)
    expect(sink.events).toEqual([
      expect.objectContaining({
        name: "backspace",
        meta: true,
        option: true,
        super: false,
      }),
    ])
  })

  it("turns a terminal-stripped Command+Backspace into line deletion input", () => {
    const sink = input()

    expect(recoverModifiedBackspace("\u007f", modifiers("command"), sink.keyInput)).toBe(true)
    expect(sink.events).toEqual([
      expect.objectContaining({
        name: "backspace",
        meta: false,
        option: false,
        super: true,
      }),
    ])
  })

  it("leaves ordinary and already-encoded input to OpenTUI", () => {
    const sink = input()

    expect(recoverModifiedBackspace("\u007f", modifiers(), sink.keyInput)).toBe(false)
    expect(recoverModifiedBackspace("\u001b\u007f", modifiers("option"), sink.keyInput)).toBe(false)
    expect(sink.events).toEqual([])
  })

  it("prefers Command's line deletion when both modifiers are held", () => {
    const sink = input()

    expect(recoverModifiedBackspace("\u007f", modifiers("option", "command"), sink.keyInput)).toBe(true)
    expect(sink.events[0]).toEqual(expect.objectContaining({ meta: false, option: false, super: true }))
  })

  it("has a no-op reader away from macOS", async () => {
    const reader = await createMacModifierReader("linux")

    expect(reader.isPressed("option")).toBe(false)
    expect(reader.isPressed("command")).toBe(false)
    expect(() => reader.close()).not.toThrow()
  })
})

describe("legacy modified-key reporting", () => {
  it("upgrades a non-Kitty terminal to the same level-2 fallback Pi uses", () => {
    const writes: string[] = []

    expect(enableLegacyModifiedKeys(null, (sequence) => writes.push(sequence))).toBe(true)
    expect(writes).toEqual([modifyOtherKeysLevelTwo])
  })

  it("does not mix modifyOtherKeys into an established Kitty session", () => {
    const writes: string[] = []
    const capabilities = { kitty_keyboard: true } as TerminalCapabilities

    expect(enableLegacyModifiedKeys(capabilities, (sequence) => writes.push(sequence))).toBe(false)
    expect(writes).toEqual([])
  })
})
