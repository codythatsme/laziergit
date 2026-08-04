import type { Theme } from "laziergit"

function freezeTheme(theme: Theme): Theme {
  return Object.freeze({ ...theme })
}

/**
 * A named, complete set of tokens a user selects with `theme.preset`. A preset is a base, not
 * a mode: `theme` merges a user's own token overrides on top of the one they named.
 *
 * Every preset here is held to the contrast floors in `theme.test.ts`.
 */
export interface ThemePreset {
  /** What the user types as `theme.preset`. */
  readonly name: string
  /** One line, published into the config JSON Schema so editors describe the choice. */
  readonly description: string
  /** Used by the picker and by automatic dark/light selections. */
  readonly appearance: "dark" | "light"
  readonly tokens: Theme
}

function preset(name: string, description: string, appearance: ThemePreset["appearance"], tokens: Theme): ThemePreset {
  return Object.freeze({ name, description, appearance, tokens: freezeTheme(tokens) })
}

export const themePresets: readonly ThemePreset[] = Object.freeze([
  /**
   * The default. The terminal owns the canvas, while violet marks focus and raised chrome:
   * `backgroundPanel` makes a popup read as a card, and `selection` produces a row you can
   * find without hunting. The diff pair separates in luminance as well as hue.
   */
  preset("nocturne", "Violet night on the terminal's native background — laziergit's default", "dark", {
    text: "#e9ebf7",
    textMuted: "#9da2be",
    accent: "#bca4ff",
    success: "#5cd79b",
    warning: "#f2b25c",
    danger: "#ff7a92",
    info: "#61d0f7",
    background: "transparent",
    backgroundPanel: "#212639",
    border: "#333a55",
    borderFocused: "#a98bff",
    selection: "#2e3663",
    diffAdded: "#7bedb0",
    diffRemoved: "#f2708c",
  }),
  preset("midnight", "Cool blue-black — laziergit's original palette, kept", "dark", {
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
  }),
  preset("ember", "Warm dark: umber neutrals under an apricot accent, for long sessions", "dark", {
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
  }),
  preset("daybreak", "Light: warm paper with deep ink-jewel semantics", "light", {
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
  }),
  preset("beacon", "High contrast: pure black, white body text, every semantic above 9:1", "dark", {
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
  }),
  preset("catppuccin-mocha", "Catppuccin Mocha: soft pastels over a deep lavender-black", "dark", {
    text: "#cdd6f4",
    textMuted: "#a6adc8",
    accent: "#cba6f7",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
    info: "#89dceb",
    background: "#1e1e2e",
    backgroundPanel: "#313244",
    border: "#585b70",
    borderFocused: "#cba6f7",
    selection: "#181825",
    diffAdded: "#a6e3a1",
    diffRemoved: "#f38ba8",
  }),
  preset("catppuccin-latte", "Catppuccin Latte: calm lavender accents on a pale surface", "light", {
    text: "#34364a",
    textMuted: "#4c4f69",
    accent: "#8839ef",
    success: "#145c0a",
    warning: "#75490a",
    danger: "#c42a4f",
    info: "#075a78",
    background: "#eff1f5",
    backgroundPanel: "#dce0e8",
    border: "#9ca0b0",
    borderFocused: "#8839ef",
    selection: "#c7cbd5",
    diffAdded: "#145c0a",
    diffRemoved: "#b60d32",
  }),
  preset("gruvbox-dark", "Gruvbox Dark: warm retro earth tones with bright semantics", "dark", {
    text: "#fbf1c7",
    textMuted: "#d5c4a1",
    accent: "#fabd2f",
    success: "#b8bb26",
    warning: "#fabd2f",
    danger: "#fb7061",
    info: "#83c9c5",
    background: "#282828",
    backgroundPanel: "#3c3836",
    border: "#665c54",
    borderFocused: "#fabd2f",
    selection: "#504945",
    diffAdded: "#b8bb26",
    diffRemoved: "#fb7061",
  }),
  preset("gruvbox-light", "Gruvbox Light: warm paper with grounded retro accents", "light", {
    text: "#282828",
    textMuted: "#504945",
    accent: "#8f3f71",
    success: "#326747",
    warning: "#7b4800",
    danger: "#9d0006",
    info: "#076678",
    background: "#fbf1c7",
    backgroundPanel: "#ebdbb2",
    border: "#bdae93",
    borderFocused: "#8f3f71",
    selection: "#d5c4a1",
    diffAdded: "#326747",
    diffRemoved: "#9d0006",
  }),
  preset("nord", "Nord: arctic blue-grey surfaces with frost accents", "dark", {
    text: "#eceff4",
    textMuted: "#bac2de",
    accent: "#88c0d0",
    success: "#a3d08f",
    warning: "#ebcb8b",
    danger: "#ed8790",
    info: "#81a1c1",
    background: "#2e3440",
    backgroundPanel: "#3b4252",
    border: "#4c566a",
    borderFocused: "#88c0d0",
    selection: "#2e3440",
    diffAdded: "#a3d08f",
    diffRemoved: "#ed8790",
  }),
  preset("solarized-dark", "Solarized Dark: low-glare blue-green with calibrated accents", "dark", {
    text: "#fdf6e3",
    textMuted: "#a6b3b3",
    accent: "#49c6bd",
    success: "#a8c85b",
    warning: "#e5b94c",
    danger: "#ff746b",
    info: "#5fcce0",
    background: "#002b36",
    backgroundPanel: "#073642",
    border: "#586e75",
    borderFocused: "#49c6bd",
    selection: "#164752",
    diffAdded: "#a8c85b",
    diffRemoved: "#ff746b",
  }),
  preset("solarized-light", "Solarized Light: warm ivory with deep cyan and amber semantics", "light", {
    text: "#073642",
    textMuted: "#435a61",
    accent: "#005f87",
    success: "#466c00",
    warning: "#7a5300",
    danger: "#a51d1d",
    info: "#006b85",
    background: "#fdf6e3",
    backgroundPanel: "#eee8d5",
    border: "#b8b09b",
    borderFocused: "#005f87",
    selection: "#d8d2bf",
    diffAdded: "#466c00",
    diffRemoved: "#a51d1d",
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
  // screen rather than fail.
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
