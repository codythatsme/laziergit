import type { Theme } from "laziergit"

function freezeTheme(theme: Theme): Theme {
  return Object.freeze({ ...theme })
}

/**
 * A named, complete set of tokens a user selects with `theme.preset`.
 *
 * A preset is a *base*, not a mode: `theme` merges a user's own token overrides on top of the
 * one they named, so picking a preset and then recolouring one token is the ordinary case
 * rather than an escape from the preset system.
 *
 * Every preset here is held to the contrast floors in `theme.test.ts`. That is not decoration:
 * `textMuted` carries every empty state in the app and the cursor gutter beside every
 * unselected row, so a preset that renders it as decorative grey has made the sentence telling
 * you your working tree is clean the least readable thing on the screen.
 */
export interface ThemePreset {
  /** What the user types as `theme.preset`. */
  readonly name: string
  /** One line, published into the config JSON Schema so editors describe the choice. */
  readonly description: string
  readonly tokens: Theme
}

function preset(name: string, description: string, tokens: Theme): ThemePreset {
  return Object.freeze({ name, description, tokens: freezeTheme(tokens) })
}

export const themePresets: readonly ThemePreset[] = Object.freeze([
  /**
   * The default. Violet-black, because git had already spent green, red, amber and cyan on
   * meaning — violet is the only hue left that can be loud without claiming to be a state.
   *
   * The three surfaces are deliberately three: `background` near-black, `backgroundPanel`
   * lifted enough that a popup reads as a card rather than a rectangle of the same paint, and
   * a `selection` bar you can find without hunting. The diff pair separates in luminance as
   * well as hue, so a patch stays readable where red and green are hard to tell apart.
   */
  preset("nocturne", "Violet-black night with three stacked surfaces — laziergit's default", {
    text: "#e9ebf7",
    textMuted: "#9da2be",
    accent: "#bca4ff",
    success: "#5cd79b",
    warning: "#f2b25c",
    danger: "#ff7a92",
    info: "#61d0f7",
    background: "#0b0b12",
    backgroundPanel: "#212639",
    border: "#333a55",
    borderFocused: "#a98bff",
    selection: "#2e3663",
    diffAdded: "#7bedb0",
    diffRemoved: "#f2708c",
    diffHunkHeader: "#8fa3e8",
  }),
  preset("midnight", "Cool blue-black — laziergit's original palette, kept", {
    text: "#c0caf5",
    textMuted: "#989fbd",
    accent: "#7aa2f7",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    info: "#7dcfff",
    background: "#0b0f14",
    backgroundPanel: "#161b22",
    border: "#3d4450",
    borderFocused: "#7aa2f7",
    selection: "#283457",
    diffAdded: "#9ece6a",
    diffRemoved: "#f7768e",
    diffHunkHeader: "#7dcfff",
  }),
  preset("ember", "Warm dark: umber neutrals under an apricot accent, for long sessions", {
    text: "#f4ece3",
    textMuted: "#b1a093",
    accent: "#f2ac6c",
    success: "#7fd48c",
    warning: "#e4c46b",
    danger: "#ff8585",
    info: "#79c7d9",
    background: "#12100d",
    backgroundPanel: "#2e2720",
    border: "#453b31",
    borderFocused: "#e89050",
    selection: "#43372a",
    diffAdded: "#9ae8a6",
    diffRemoved: "#f2807f",
    diffHunkHeader: "#93aec0",
  }),
  preset("daybreak", "Light: warm paper with deep ink-jewel semantics", {
    text: "#1a1922",
    textMuted: "#57555f",
    accent: "#6340d6",
    success: "#054a26",
    warning: "#75490a",
    danger: "#a8102a",
    info: "#0a5a79",
    background: "#fbfaf6",
    backgroundPanel: "#eae4d5",
    border: "#c5bfaf",
    borderFocused: "#4e2fb8",
    selection: "#d2c7f2",
    diffAdded: "#0e7046",
    diffRemoved: "#8a0820",
    diffHunkHeader: "#453f8c",
  }),
  preset("beacon", "High contrast: pure black, white body text, every semantic above 9:1", {
    text: "#ffffff",
    textMuted: "#c3c6d2",
    accent: "#dcc0ff",
    success: "#5bf0a0",
    warning: "#ffd24a",
    danger: "#ff9aab",
    info: "#7fe3ff",
    background: "#000000",
    backgroundPanel: "#232331",
    border: "#6e7488",
    borderFocused: "#f0e4ff",
    selection: "#3a3f6b",
    diffAdded: "#6bfaae",
    diffRemoved: "#ff7e97",
    diffHunkHeader: "#b4beee",
  }),
])

const presetsByName = new Map(themePresets.map((entry) => [entry.name, entry]))

export function findThemePreset(name: string): ThemePreset | undefined {
  return presetsByName.get(name)
}

export const defaultThemePreset = "nocturne"

export const defaultTheme: Theme = (() => {
  const found = findThemePreset(defaultThemePreset)
  // Unreachable by construction, but a missing default theme would render an unreadable
  // screen rather than fail, so it is worth saying out loud.
  if (!found) throw new Error(`The default theme preset "${defaultThemePreset}" is not registered`)
  return found.tokens
})()

export class ThemeStore {
  readonly #listeners = new Set<() => void>()
  #source: Theme
  #snapshot: Theme

  constructor(theme: Theme = defaultTheme) {
    this.#source = theme
    this.#snapshot = freezeTheme(theme)
  }

  getSnapshot = (): Theme => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  replace(theme: Theme): void {
    if (Object.is(theme, this.#source) || Object.is(theme, this.#snapshot)) return

    this.#source = theme
    this.#snapshot = freezeTheme(theme)
    const listeners = [...this.#listeners]
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // External-store listeners are independent; one observer cannot starve the rest.
      }
    }
  }
}
