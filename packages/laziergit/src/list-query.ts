/** ASCII smart case, matching lazygit: an uppercase query character makes that term exact-case. */
export function smartCaseIncludes(text: string, query: string): boolean {
  return /[A-Z]/.test(query) ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase())
}

function searchableText<T>(item: T, fields: (item: T) => string | readonly string[]): string {
  const value = fields(item)
  return typeof value === "string" ? value : value.join(" ")
}

/**
 * Source indices matching lazygit's default filter mode. Whitespace separates required
 * terms; terms may occur in any order and use smart-case substring matching.
 */
export function filterMatchIndices<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => string | readonly string[],
): readonly number[] {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return items.map((_item, index) => index)

  return items.flatMap((item, index) => {
    const text = searchableText(item, fields)
    return terms.every((term) => smartCaseIncludes(text, term)) ? [index] : []
  })
}

/** Source indices containing one smart-case search string, in source order. */
export function searchMatchIndices<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => string | readonly string[],
): readonly number[] {
  if (query.length === 0) return []
  return items.flatMap((item, index) => (smartCaseIncludes(searchableText(item, fields), query) ? [index] : []))
}
