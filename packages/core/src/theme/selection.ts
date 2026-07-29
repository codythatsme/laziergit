import type { Theme } from "laziergit"

export interface AutomaticThemeSelection {
  readonly dark: string
  readonly light: string
}

export type ThemeSelection = string | AutomaticThemeSelection

/** The validated selection and inline token patch retained so appearance changes can re-resolve it. */
export interface ThemeConfiguration {
  readonly selection: ThemeSelection
  readonly overrides: Readonly<Partial<Theme>>
}
