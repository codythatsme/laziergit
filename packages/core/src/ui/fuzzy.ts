const consecutiveBonus = 8
const wordBoundaryBonus = 6
const gapPenalty = 1

/** Read against the lowercased haystack the match indices came from, not the original. */
function isBoundary(haystack: string, index: number): boolean {
  if (index === 0) return true
  const previous = haystack[index - 1]
  return previous === " " || previous === "." || previous === "-" || previous === "_" || previous === "/"
}

/**
 * Subsequence match with a score: consecutive characters and word starts beat scattered
 * hits, so "gws" ranks "GitHub Actions: refresh runs" the way a palette user expects.
 * Returns null when the query is not a subsequence at all.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0

  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  let score = 0
  let cursor = 0
  let previousIndex = -1

  for (const character of needle) {
    if (character === " ") continue
    const index = haystack.indexOf(character, cursor)
    if (index === -1) return null

    if (index === previousIndex + 1) score += consecutiveBonus
    else score -= Math.min(gapPenalty * (index - previousIndex - 1), consecutiveBonus)
    if (isBoundary(haystack, index)) score += wordBoundaryBonus

    previousIndex = index
    cursor = index + 1
  }
  return score
}

export interface FuzzyResult<T> {
  readonly item: T
  /** Position in the original list, so callers can resolve back to their own data. */
  readonly index: number
  readonly score: number
}

/** Filters and ranks; ties keep the original order, which keeps lists from jittering. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
): readonly FuzzyResult<T>[] {
  const results: FuzzyResult<T>[] = []
  for (const [index, item] of items.entries()) {
    const score = fuzzyScore(query, text(item))
    if (score !== null) results.push({ item, index, score })
  }
  return query.length === 0 ? results : [...results].sort((left, right) => right.score - left.score)
}
