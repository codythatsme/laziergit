import type { Theme } from "laziergit"

function freezeTheme(theme: Theme): Theme {
  return Object.freeze({ ...theme })
}

export const defaultTheme: Theme = freezeTheme({
  text: "#c0caf5",
  textMuted: "#565f89",
  accent: "#7aa2f7",
  success: "#9ece6a",
  warning: "#e0af68",
  danger: "#f7768e",
  info: "#7dcfff",
  background: "#0b0f14",
  backgroundPanel: "#161b22",
  border: "#30363d",
  borderFocused: "#7aa2f7",
  selection: "#283457",
  diffAdded: "#9ece6a",
  diffRemoved: "#f7768e",
  diffHunkHeader: "#7dcfff",
})

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
