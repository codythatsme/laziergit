import { expect, it } from "bun:test"
import type { TerminalColors } from "@opentui/core"

import { findThemePreset } from "../extension/theme"
import { createSystemTheme } from "./system"

function terminalColors(overrides: Partial<TerminalColors> = {}): TerminalColors {
  return {
    palette: [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ],
    defaultForeground: "#eeeeee",
    defaultBackground: "#111111",
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: "#333333",
    highlightForeground: null,
    ...overrides,
  }
}

function fallback(name: "nocturne" | "daybreak") {
  const theme = findThemePreset(name)
  if (!theme) throw new Error(`Missing ${name}`)
  return theme.tokens
}

it("maps the terminal defaults and dark ANSI semantic slots", () => {
  const theme = createSystemTheme(terminalColors(), "dark", fallback("nocturne"))

  expect(theme.background).toBe("#111111")
  expect(theme.text).toBe("#eeeeee")
  expect(theme.accent).toBe("#ff00ff")
  expect(theme.success).toBe("#00ff00")
  expect(theme.danger).toBe("#ff0000")
  expect(theme.diffAdded).toBe(theme.success)
  expect(theme.diffRemoved).toBe(theme.danger)
})

it("uses the ordinary ANSI slots in light mode and falls back for absent colors", () => {
  const colors = terminalColors({
    palette: terminalColors().palette.map((entry, index) => (index === 5 ? "#5f005f" : entry)),
    defaultForeground: null,
    defaultBackground: null,
    highlightBackground: null,
  })
  const base = fallback("daybreak")
  const theme = createSystemTheme(colors, "light", base)

  expect(theme.background).toBe(base.background)
  expect(theme.text).toBe(base.text)
  expect(theme.accent).toBe("#5f005f")
  expect(theme.selection).not.toBe("")
})
