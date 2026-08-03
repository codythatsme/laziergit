import { createHash } from "node:crypto"

export type AuthorColor = `#${string}`

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const initialsCache = new Map<string, string>()
const colorCache = new Map<string, AuthorColor>()

function limitCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("")
}

/** The two-cell author label lazygit uses in its compact commit list. */
export function authorInitials(authorName: string): string {
  const cached = initialsCache.get(authorName)
  if (cached !== undefined) return cached
  if (authorName.length === 0) return ""

  const firstGrapheme = [...graphemes.segment(authorName)][0]?.segment ?? ""
  let initials: string
  if (Bun.stringWidth(firstGrapheme) > 1) {
    initials = firstGrapheme
  } else {
    const parts = authorName.split(" ")
    initials =
      parts.length === 1
        ? limitCodePoints(authorName, 2)
        : limitCodePoints(parts[0] ?? "", 1) + limitCodePoints(parts[1] ?? "", 1)
  }

  initialsCache.set(authorName, initials)
  return initials
}

function randomFraction(bytes: Uint8Array): number {
  let sum = 0
  for (const byte of bytes) sum = (sum + byte) % 100
  return sum / 100
}

function hueChannel(lower: number, upper: number, hue: number): number {
  let wrapped = hue
  if (wrapped < 0) wrapped += 1
  if (wrapped > 1) wrapped -= 1

  if (6 * wrapped < 1) return lower + (upper - lower) * 6 * wrapped
  if (2 * wrapped < 1) return upper
  if (3 * wrapped < 2) return lower + (upper - lower) * (2 / 3 - wrapped) * 6
  return lower
}

function hsl(hue: number, saturation: number, lightness: number): readonly [number, number, number] {
  if (saturation === 0) return [lightness, lightness, lightness]

  const upper = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const lower = 2 * lightness - upper
  const normalizedHue = hue / 360
  return [
    hueChannel(lower, upper, normalizedHue + 1 / 3),
    hueChannel(lower, upper, normalizedHue),
    hueChannel(lower, upper, normalizedHue - 1 / 3),
  ]
}

/** The stable MD5/HSL truecolor lazygit assigns to an author name. */
export function authorColor(authorName: string): AuthorColor {
  const cached = colorCache.get(authorName)
  if (cached !== undefined) return cached

  const hash = createHash("md5").update(authorName).digest()
  const hue = randomFraction(hash.subarray(0, 4)) * 360
  const saturation = 0.6 + 0.4 * randomFraction(hash.subarray(4, 8))
  const lightness = 0.4 + 0.2 * randomFraction(hash.subarray(8, 12))
  const color = `#${hsl(hue, saturation, lightness)
    .map((channel) =>
      Math.trunc(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}` as AuthorColor

  colorCache.set(authorName, color)
  return color
}
