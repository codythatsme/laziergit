import type { Theme } from "laziergit"

type DiffTheme = Pick<Theme, "text" | "textMuted" | "background" | "selection" | "diffAdded" | "diffRemoved">

export interface DiffThemeProps {
  readonly fg: string
  readonly lineNumberFg: string
  readonly lineNumberBg: string
  readonly addedBg: string
  readonly removedBg: string
  readonly contextBg: string
  readonly addedSignColor: string
  readonly removedSignColor: string
  readonly addedLineNumberBg: string
  readonly removedLineNumberBg: string
  readonly selectionBg: string
  readonly selectionFg: string
}

interface Rgb {
  readonly red: number
  readonly green: number
  readonly blue: number
}

const hexColor = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i

function rgb(color: string): Rgb | null {
  if (!hexColor.test(color)) return null
  return {
    red: Number.parseInt(color.slice(1, 3), 16),
    green: Number.parseInt(color.slice(3, 5), 16),
    blue: Number.parseInt(color.slice(5, 7), 16),
  }
}

function hex({ red, green, blue }: Rgb): string {
  const channel = (value: number): string => Math.round(value).toString(16).padStart(2, "0")
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

function blend(background: Rgb, foreground: Rgb, amount: number): string {
  return hex({
    red: background.red + (foreground.red - background.red) * amount,
    green: background.green + (foreground.green - background.green) * amount,
    blue: background.blue + (foreground.blue - background.blue) * amount,
  })
}

function luminance(color: Rgb): number {
  const channel = (value: number): number => {
    const component = value / 255
    return component <= 0.03928 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * A restrained semantic tint for a changed line. The maximum is intentionally low: the
 * semantic token remains the sign colour, while this tint only makes the line shape scannable.
 * For custom themes, back off until normal text still clears WCAG AA.
 */
export function diffBackground(background: string, semantic: string, text: string): string {
  const base = rgb(background)
  const tone = rgb(semantic)
  const foreground = rgb(text)
  if (base === null || tone === null || foreground === null) return background

  for (let percentage = 16; percentage >= 1; percentage -= 1) {
    const candidate = blend(base, tone, percentage / 100)
    const parsed = rgb(candidate)
    if (parsed !== null && contrast(foreground, parsed) >= 4.5) return candidate
  }
  return background
}

/**
 * The public Theme's existing semantic colours translated to every colour seam exposed by
 * OpenTUI's `<diff>`. The gutter stays on the app background so the +/- signs retain the
 * contrast promised by their tokens; only the code cell receives the derived tint.
 */
export function diffThemeProps(theme: DiffTheme): DiffThemeProps {
  return {
    fg: theme.text,
    lineNumberFg: theme.textMuted,
    lineNumberBg: theme.background,
    addedBg: diffBackground(theme.background, theme.diffAdded, theme.text),
    removedBg: diffBackground(theme.background, theme.diffRemoved, theme.text),
    contextBg: theme.background,
    addedSignColor: theme.diffAdded,
    removedSignColor: theme.diffRemoved,
    addedLineNumberBg: theme.background,
    removedLineNumberBg: theme.background,
    selectionBg: theme.selection,
    selectionFg: theme.text,
  }
}
