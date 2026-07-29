import { describe, expect, it } from "bun:test"
import type { Theme } from "laziergit"

import { defaultTheme, defaultThemePreset, findThemePreset, themePresets, ThemeStore } from "./theme"

function createTheme(overrides: Partial<Theme> = {}): Theme {
  return { ...defaultTheme, ...overrides }
}

/** sRGB → relative luminance, per WCAG. */
function luminance(hex: string): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const h = hex.replace("#", "")
  return (
    0.2126 * channel(Number.parseInt(h.slice(0, 2), 16)) +
    0.7152 * channel(Number.parseInt(h.slice(2, 4), 16)) +
    0.0722 * channel(Number.parseInt(h.slice(4, 6), 16))
  )
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * What each pair has to clear. `text` and the selected row are held to AAA because they are
 * the whole screen for eight hours. `textMuted` is held to AA against *both* grounds it is
 * drawn on: it renders every empty state in the app plus the gutter beside every unselected
 * row, so treating it as decorative grey makes the app's explanations its least readable text.
 */
const contrastFloors: readonly (readonly [keyof Theme, keyof Theme, number])[] = [
  ["text", "background", 7],
  ["text", "selection", 7],
  ["text", "backgroundPanel", 7],
  ["textMuted", "background", 4.5],
  ["textMuted", "selection", 4.5],
  ["accent", "background", 4.5],
  ["success", "background", 4.5],
  ["warning", "background", 4.5],
  ["danger", "background", 4.5],
  ["info", "background", 4.5],
  ["diffAdded", "background", 4.5],
  ["diffRemoved", "background", 4.5],
  // An unfocused frame still has to frame something, and the focused one has to win clearly.
  ["border", "background", 1.5],
  ["borderFocused", "background", 2.5],
]

describe("theme presets", () => {
  it("registers the default preset and gives every preset a distinct name", () => {
    expect(findThemePreset(defaultThemePreset)?.tokens).toBe(defaultTheme)
    const names = themePresets.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect(findThemePreset("no-such-preset")).toBeUndefined()
  })

  it("spells every token of every preset as a six-digit hex color", () => {
    for (const entry of themePresets) {
      for (const [token, color] of Object.entries(entry.tokens)) {
        expect(`${entry.name}.${token}=${color}`).toMatch(/=#[0-9a-f]{6}$/)
      }
      // A preset is a complete base, not a patch: a missing token would silently inherit a
      // colour from a palette the user did not choose.
      expect(Object.keys(entry.tokens).sort()).toEqual(Object.keys(defaultTheme).sort())
    }
  })

  it("keeps every preset above its contrast floors", () => {
    const failures: string[] = []
    for (const entry of themePresets) {
      for (const [foreground, background, floor] of contrastFloors) {
        const ratio = contrast(entry.tokens[foreground], entry.tokens[background])
        if (ratio < floor) {
          failures.push(`${entry.name}: ${foreground}/${background} = ${ratio.toFixed(2)}, needs ${floor}`)
        }
      }

      // Focus is read at a glance across four frames at once, so the focused border has to be
      // a step rather than a shade.
      const step =
        contrast(entry.tokens.borderFocused, entry.tokens.background) /
        contrast(entry.tokens.border, entry.tokens.background)
      if (step < 2) failures.push(`${entry.name}: focused border is only ${step.toFixed(2)}x the unfocused one`)

      // The files Pane draws the index column green immediately beside the working-tree column
      // red, so hue alone carries a meaning a red-green deficiency cannot read: the pair has
      // to differ in luminance too.
      const staged = luminance(entry.tokens.success)
      const unstaged = luminance(entry.tokens.danger)
      const separation = Math.abs(staged - unstaged) / Math.max(staged, unstaged)
      if (separation < 0.12) {
        failures.push(`${entry.name}: success/danger differ by only ${(separation * 100).toFixed(0)}% luminance`)
      }
    }
    expect(failures).toEqual([])
  })
})

describe("ThemeStore", () => {
  it("keeps a frozen copy of each supplied Theme", () => {
    const initial = { ...defaultTheme }
    const store = new ThemeStore(initial)
    const initialSnapshot = store.getSnapshot()

    expect(initialSnapshot).toEqual(initial)
    expect(initialSnapshot).not.toBe(initial)
    expect(Object.isFrozen(initialSnapshot)).toBe(true)

    initial.text = "#000000"
    expect(store.getSnapshot().text).toBe(defaultTheme.text)

    const replacement = { ...initial, accent: "#ffffff" }
    store.replace(replacement)
    const replacementSnapshot = store.getSnapshot()

    expect(replacementSnapshot).toEqual(replacement)
    expect(replacementSnapshot).not.toBe(replacement)
    expect(Object.isFrozen(replacementSnapshot)).toBe(true)

    replacement.accent = "#111111"
    expect(store.getSnapshot().accent).toBe("#ffffff")
  })

  it("does not notify when replacing with the identical source or snapshot", () => {
    const initial = createTheme()
    const store = new ThemeStore(initial)
    let notifications = 0
    store.subscribe(() => notifications++)

    store.replace(initial)
    store.replace(store.getSnapshot())

    expect(notifications).toBe(0)

    store.replace(createTheme())
    expect(notifications).toBe(1)
  })

  it("isolates listener failures and supports unsubscription", () => {
    const store = new ThemeStore()
    const calls: string[] = []
    const unsubscribe = store.subscribe(() => calls.push("unsubscribed"))
    unsubscribe()
    store.subscribe(() => {
      calls.push("throwing")
      throw new Error("listener exploded")
    })
    store.subscribe(() => calls.push("survivor"))

    expect(() => store.replace(createTheme({ accent: "#ffffff" }))).not.toThrow()
    expect(calls).toEqual(["throwing", "survivor"])
  })

  it("keeps Theme state isolated between store instances", () => {
    const first = new ThemeStore()
    const second = new ThemeStore()
    let secondNotifications = 0
    second.subscribe(() => secondNotifications++)

    expect(first.getSnapshot()).not.toBe(second.getSnapshot())
    first.replace(createTheme({ background: "#ffffff" }))

    expect(first.getSnapshot().background).toBe("#ffffff")
    expect(second.getSnapshot().background).toBe(defaultTheme.background)
    expect(secondNotifications).toBe(0)
  })
})
