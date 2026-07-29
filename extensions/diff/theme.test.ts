import { describe, expect, it } from "bun:test"
import type { Theme } from "laziergit"

import { diffBackground, diffThemeProps } from "./theme"

function luminance(hex: string): number {
  const channel = (value: number): number => {
    const component = value / 255
    return component <= 0.03928 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel(Number.parseInt(hex.slice(1, 3), 16)) +
    0.7152 * channel(Number.parseInt(hex.slice(3, 5), 16)) +
    0.0722 * channel(Number.parseInt(hex.slice(5, 7), 16))
  )
}

function contrast(first: string, second: string): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const dark = {
  text: "#e6e9ef",
  textMuted: "#aeb6c7",
  background: "#0b0e14",
  selection: "#26324a",
  diffAdded: "#7bedb0",
  diffRemoved: "#f2708c",
} satisfies Pick<Theme, "text" | "textMuted" | "background" | "selection" | "diffAdded" | "diffRemoved">

const light = {
  text: "#121725",
  textMuted: "#515d70",
  background: "#f6f7fb",
  selection: "#d9e2f5",
  diffAdded: "#0e7046",
  diffRemoved: "#8a0820",
} satisfies Pick<Theme, "text" | "textMuted" | "background" | "selection" | "diffAdded" | "diffRemoved">

describe("diffBackground", () => {
  it("tints both dark and light backgrounds toward the semantic colour", () => {
    expect(diffBackground(dark.background, dark.diffAdded, dark.text)).toBe("#1d322d")
    expect(diffBackground(light.background, light.diffAdded, light.text)).toBe("#d1e1de")
  })

  it("backs off rather than making normal text illegible", () => {
    const tinted = diffBackground("#ffffff", "#000000", "#666666")
    expect(contrast("#666666", tinted)).toBeGreaterThanOrEqual(4.5)
    expect(tinted).not.toBe("#d6d6d6")
  })

  it("leaves a non-hex background unchanged for a graceful fallback", () => {
    expect(diffBackground("transparent", "#00ff00", "#ffffff")).toBe("transparent")
    expect(diffBackground("#000000", "green", "#ffffff")).toBe("#000000")
  })
})

describe("diffThemeProps", () => {
  it.each([dark, light])("maps the semantic tokens to the complete diff colour surface", (theme) => {
    const props = diffThemeProps(theme)

    expect(props).toMatchObject({
      fg: theme.text,
      lineNumberFg: theme.textMuted,
      lineNumberBg: theme.background,
      contextBg: theme.background,
      addedSignColor: theme.diffAdded,
      removedSignColor: theme.diffRemoved,
      addedLineNumberBg: theme.background,
      removedLineNumberBg: theme.background,
      selectionBg: theme.selection,
      selectionFg: theme.text,
    })
    expect(contrast(theme.text, props.addedBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.text, props.removedBg)).toBeGreaterThanOrEqual(4.5)
  })
})
