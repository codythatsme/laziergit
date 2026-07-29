import type { TerminalColors, ThemeMode } from "@opentui/core"
import type { Theme } from "laziergit"

interface Rgb {
  readonly red: number
  readonly green: number
  readonly blue: number
}

const hexColor = /^#[0-9a-f]{6}$/i

function color(value: string | null | undefined, fallback: string): string {
  return value !== null && value !== undefined && hexColor.test(value) ? value.toLowerCase() : fallback
}

function rgb(value: string): Rgb {
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  }
}

function hex({ red, green, blue }: Rgb): string {
  const channel = (value: number): string => Math.round(value).toString(16).padStart(2, "0")
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

function mix(base: string, overlay: string, amount: number): string {
  const from = rgb(base)
  const to = rgb(overlay)
  return hex({
    red: from.red + (to.red - from.red) * amount,
    green: from.green + (to.green - from.green) * amount,
    blue: from.blue + (to.blue - from.blue) * amount,
  })
}

function luminance(value: string): number {
  const channel = (component: number): number => {
    const normalized = component / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const parsed = rgb(value)
  return 0.2126 * channel(parsed.red) + 0.7152 * channel(parsed.green) + 0.0722 * channel(parsed.blue)
}

function contrast(left: string, right: string): number {
  const a = luminance(left)
  const b = luminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function readable(candidate: string, background: string, toward: string, floor: number): string {
  if (contrast(candidate, background) >= floor) return candidate
  for (let percentage = 5; percentage <= 100; percentage += 5) {
    const adjusted = mix(candidate, toward, percentage / 100)
    if (contrast(adjusted, background) >= floor) return adjusted
  }
  return toward
}

function surface(background: string, foreground: string, amount: number, floor: number): string {
  for (let percentage = amount; percentage >= 0; percentage -= 0.01) {
    const candidate = mix(background, foreground, percentage)
    if (contrast(foreground, candidate) >= floor) return candidate
  }
  return background
}

/**
 * Builds the `system` theme from OSC palette data. Terminal colors are preferences rather
 * than trusted contrast pairs, so semantic slots are nudged toward the foreground only when
 * they would otherwise disappear against the detected background.
 */
export function createSystemTheme(colors: TerminalColors, mode: ThemeMode, fallback: Theme): Theme {
  const background = color(colors.defaultBackground, fallback.background)
  const text = readable(color(colors.defaultForeground, fallback.text), background, fallback.text, 7)
  const slots = mode === "light" ? [5, 2, 3, 1, 6] : [13, 10, 11, 9, 14]
  const semantic = slots.map((index, position) => {
    const defaults = [fallback.accent, fallback.success, fallback.warning, fallback.danger, fallback.info]
    return readable(color(colors.palette[index], defaults[position] ?? text), background, text, 4.5)
  })
  const [accent = text, success = text, warning = text, danger = text, info = text] = semantic
  const selectionCandidate = color(colors.highlightBackground, mix(background, accent, 0.2))
  const selection = contrast(text, selectionCandidate) >= 7 ? selectionCandidate : surface(background, accent, 0.2, 7)

  return Object.freeze({
    text,
    textMuted: readable(mix(text, background, 0.25), background, text, 4.5),
    accent,
    success,
    warning,
    danger,
    info,
    background,
    backgroundPanel: surface(background, text, 0.08, 7),
    border: mix(background, text, 0.3),
    borderFocused: accent,
    selection,
    diffAdded: success,
    diffRemoved: danger,
  })
}
