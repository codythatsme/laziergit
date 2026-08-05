import type { KeyHandler, TerminalCapabilities } from "@opentui/core"

export const modifyOtherKeysLevelTwo = "\u001b[>4;2m"

const coreGraphics = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
const combinedSessionState = 0
const commandMask = 1n << 20n
const optionMask = 1n << 19n

export type MacModifier = "command" | "option"

export interface MacModifierReader {
  isPressed(modifier: MacModifier): boolean
  close(): void
}

const unavailableModifierReader: MacModifierReader = {
  isPressed: () => false,
  close: () => undefined,
}

/**
 * Warp and a few other macOS terminals can reduce a terminal-owned modified Backspace chord to
 * an ordinary DEL byte. CoreGraphics still knows which physical modifier is held when that byte
 * arrives, so local macOS sessions can recover the information the terminal omitted. Remote
 * sessions get no such fallback: their keyboard belongs to another machine.
 */
export async function createMacModifierReader(
  platform: NodeJS.Platform = process.platform,
): Promise<MacModifierReader> {
  if (platform !== "darwin") return unavailableModifierReader

  try {
    const { dlopen, FFIType } = await import("bun:ffi")
    const library = dlopen(coreGraphics, {
      CGEventSourceFlagsState: {
        args: [FFIType.i32],
        returns: FFIType.u64,
      },
    })
    let closed = false

    return {
      isPressed(modifier) {
        if (closed) return false
        const flags = BigInt(library.symbols.CGEventSourceFlagsState(combinedSessionState))
        const mask = modifier === "command" ? commandMask : optionMask
        return (flags & mask) !== 0n
      },
      close() {
        if (closed) return
        closed = true
        library.close()
      },
    }
  } catch {
    return unavailableModifierReader
  }
}

/**
 * Consumes only a plain Backspace whose missing macOS modifier can be recovered natively.
 * Command wins if both modifiers are held so its broader line deletion remains reachable.
 */
export function recoverModifiedBackspace(
  sequence: string,
  modifiers: MacModifierReader,
  keyInput: KeyHandler | undefined,
): boolean {
  if (sequence !== "\u007f" || keyInput === undefined) return false

  const command = modifiers.isPressed("command")
  const option = !command && modifiers.isPressed("option")
  if (!command && !option) return false

  keyInput.processParsedKey({
    name: "backspace",
    ctrl: false,
    meta: option,
    shift: false,
    option,
    super: command,
    hyper: false,
    sequence,
    number: false,
    raw: sequence,
    eventType: "press",
    source: "raw",
  })
  return true
}

/**
 * OpenTUI enables xterm modifyOtherKeys level 1 while detecting Kitty support; level 2 makes
 * terminals report modified special keys more consistently. OpenTUI still owns cleanup and will
 * reset the mode on shutdown (or before enabling Kitty).
 */
export function enableLegacyModifiedKeys(
  capabilities: TerminalCapabilities | null,
  write: (sequence: string) => unknown,
): boolean {
  if (capabilities?.kitty_keyboard === true) return false
  write(modifyOtherKeysLevelTwo)
  return true
}
