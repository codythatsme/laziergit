import type { Theme } from "laziergit"

import { defaultTheme } from "../extension/theme"

export const themeScopePrecedence = ["builtin", "global", "repo"] as const

export type ThemeSourceScope = (typeof themeScopePrecedence)[number]
export type ThemeAppearance = "dark" | "light"
export type ThemeTokenName = keyof Theme

export const themeTokenNames = Object.freeze(Object.keys(defaultTheme) as ThemeTokenName[])

const themeTokenNameSet = new Set<string>(themeTokenNames)
const themeNamePattern = /^[a-z0-9][a-z0-9._-]*$/
const paletteNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/
const hexColorPattern = /^#[0-9a-fA-F]{6}$/
const themeDocumentKeys = new Set(["$schema", "name", "description", "appearance", "extends", "palette", "tokens"])

export interface ThemePresetInput {
  readonly name: string
  readonly description: string
  readonly tokens: Theme
  readonly appearance?: ThemeAppearance
}

export interface ThemeDefinition {
  readonly name: string
  readonly description?: string
  readonly appearance?: ThemeAppearance
  readonly extends?: string
  readonly palette: Readonly<Record<string, string>>
  readonly tokens: Readonly<Partial<Record<ThemeTokenName, string>>>
}

export interface ThemeDocumentSource {
  readonly scope: Exclude<ThemeSourceScope, "builtin">
  readonly path: string
  readonly text: string
}

export type ThemeDiagnosticSeverity = "warning" | "error"

export type ThemeDiagnosticCode =
  | "invalid-json"
  | "invalid-document"
  | "unknown-property"
  | "invalid-name"
  | "invalid-description"
  | "invalid-appearance"
  | "invalid-extends"
  | "invalid-palette"
  | "unknown-token"
  | "invalid-token-value"
  | "theme-shadowed"
  | "missing-parent"
  | "invalid-parent"
  | "inheritance-cycle"
  | "unknown-palette-reference"
  | "incomplete-theme"
  | "read-failed"

export interface ThemeDiagnostic {
  readonly severity: ThemeDiagnosticSeverity
  readonly code: ThemeDiagnosticCode
  readonly message: string
  readonly scope: ThemeSourceScope
  readonly path: string
  readonly themeName?: string
  readonly property?: string
}

export interface ThemeParseResult {
  readonly definition?: ThemeDefinition
  readonly diagnostics: readonly ThemeDiagnostic[]
}

export interface ResolvedTheme {
  readonly name: string
  readonly description: string
  readonly appearance?: ThemeAppearance
  readonly tokens: Theme
  readonly scope: ThemeSourceScope
  readonly path: string
}

export class ThemeCatalog {
  readonly diagnostics: readonly ThemeDiagnostic[]
  readonly #themes: ReadonlyMap<string, ResolvedTheme>
  readonly #listedThemes: readonly ResolvedTheme[]

  constructor(themes: ReadonlyMap<string, ResolvedTheme>, diagnostics: readonly ThemeDiagnostic[]) {
    this.#themes = new Map(themes)
    this.#listedThemes = Object.freeze([...themes.values()].sort(compareResolvedThemes))
    this.diagnostics = Object.freeze([...diagnostics])
  }

  get(name: string): ResolvedTheme | undefined {
    return this.#themes.get(name)
  }

  has(name: string): boolean {
    return this.#themes.has(name)
  }

  list(): readonly ResolvedTheme[] {
    return this.#listedThemes
  }
}

/**
 * Keeps a live custom theme stable while its source is temporarily invalid. A deleted file has
 * no diagnostic and therefore disappears normally; only a path that was read and rejected may
 * borrow its last resolved value.
 */
export function retainLastValidThemes(previous: ThemeCatalog, current: ThemeCatalog): ThemeCatalog {
  const invalidPaths = new Set(
    current.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.path),
  )
  if (invalidPaths.size === 0) return current

  const retained = new Map(current.list().map((entry) => [entry.name, entry]))
  for (const entry of previous.list()) {
    if (entry.scope !== "builtin" && invalidPaths.has(entry.path)) retained.set(entry.name, entry)
  }
  return new ThemeCatalog(retained, current.diagnostics)
}

function compareResolvedThemes(left: ResolvedTheme, right: ResolvedTheme): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function diagnostic(
  source: Pick<ThemeDocumentSource, "scope" | "path">,
  code: ThemeDiagnosticCode,
  message: string,
  options: {
    readonly severity?: ThemeDiagnosticSeverity
    readonly themeName?: string
    readonly property?: string
  } = {},
): ThemeDiagnostic {
  return {
    severity: options.severity ?? "error",
    code,
    message,
    scope: source.scope,
    path: source.path,
    ...(options.themeName === undefined ? {} : { themeName: options.themeName }),
    ...(options.property === undefined ? {} : { property: options.property }),
  }
}

function readOptionalString(
  value: unknown,
  property: "description" | "extends",
  source: Pick<ThemeDocumentSource, "scope" | "path">,
  themeName: string | undefined,
  diagnostics: ThemeDiagnostic[],
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(
      diagnostic(
        source,
        property === "description" ? "invalid-description" : "invalid-extends",
        `${property} must be a non-empty string`,
        { themeName, property },
      ),
    )
    return undefined
  }

  const result = value.trim()
  if (property === "extends" && !themeNamePattern.test(result)) {
    diagnostics.push(
      diagnostic(
        source,
        "invalid-extends",
        `extends must name a theme using lowercase letters, digits, ".", "_" or "-"`,
        {
          themeName,
          property,
        },
      ),
    )
    return undefined
  }
  return result
}

function readPalette(
  value: unknown,
  source: Pick<ThemeDocumentSource, "scope" | "path">,
  themeName: string | undefined,
  diagnostics: ThemeDiagnostic[],
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({})
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(source, "invalid-palette", "palette must be an object mapping names to #RRGGBB colors", {
        themeName,
        property: "palette",
      }),
    )
    return Object.freeze({})
  }

  const palette: Record<string, string> = Object.create(null)
  for (const [name, color] of Object.entries(value)) {
    const property = `palette.${name}`
    if (!paletteNamePattern.test(name)) {
      diagnostics.push(
        diagnostic(source, "invalid-palette", `Palette key "${name}" is not a valid identifier`, {
          themeName,
          property,
        }),
      )
      continue
    }
    if (typeof color !== "string" || !hexColorPattern.test(color)) {
      diagnostics.push(
        diagnostic(source, "invalid-palette", `Palette color "${name}" must use #RRGGBB`, {
          themeName,
          property,
        }),
      )
      continue
    }
    palette[name] = color
  }
  return Object.freeze(palette)
}

function readTokens(
  value: unknown,
  source: Pick<ThemeDocumentSource, "scope" | "path">,
  themeName: string | undefined,
  diagnostics: ThemeDiagnostic[],
): Readonly<Partial<Record<ThemeTokenName, string>>> {
  if (value === undefined) return Object.freeze({})
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(source, "invalid-token-value", "tokens must be an object mapping token names to colors", {
        themeName,
        property: "tokens",
      }),
    )
    return Object.freeze({})
  }

  const tokens: Partial<Record<ThemeTokenName, string>> = Object.create(null)
  for (const [name, color] of Object.entries(value)) {
    const property = `tokens.${name}`
    if (!themeTokenNameSet.has(name)) {
      diagnostics.push(diagnostic(source, "unknown-token", `Unknown theme token "${name}"`, { themeName, property }))
      continue
    }
    if (
      typeof color !== "string" ||
      (!hexColorPattern.test(color) && (color.startsWith("#") || !paletteNamePattern.test(color)))
    ) {
      diagnostics.push(
        diagnostic(source, "invalid-token-value", `Theme token "${name}" must use #RRGGBB or name a palette color`, {
          themeName,
          property,
        }),
      )
      continue
    }
    tokens[name as ThemeTokenName] = color
  }
  return Object.freeze(tokens)
}

export function parseThemeDocument(
  text: string,
  source: Pick<ThemeDocumentSource, "scope" | "path">,
): ThemeParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      diagnostics: Object.freeze([diagnostic(source, "invalid-json", `Theme file is not valid JSON: ${detail}`)]),
    }
  }

  if (!isRecord(value)) {
    return {
      diagnostics: Object.freeze([diagnostic(source, "invalid-document", "A theme file must contain one JSON object")]),
    }
  }

  const diagnostics: ThemeDiagnostic[] = []
  const rawName = value.name
  let name: string | undefined
  if (typeof rawName !== "string" || !themeNamePattern.test(rawName) || rawName === "system") {
    diagnostics.push(
      diagnostic(
        source,
        "invalid-name",
        rawName === "system"
          ? `name "system" is reserved for the terminal palette theme`
          : `name must use lowercase letters, digits, ".", "_" or "-"`,
        { property: "name" },
      ),
    )
  } else {
    name = rawName
  }

  for (const key of Object.keys(value)) {
    if (!themeDocumentKeys.has(key)) {
      diagnostics.push(
        diagnostic(source, "unknown-property", `Unknown theme property "${key}"`, {
          themeName: name,
          property: key,
        }),
      )
    }
  }

  const description = readOptionalString(value.description, "description", source, name, diagnostics)
  const parent = readOptionalString(value.extends, "extends", source, name, diagnostics)

  let appearance: ThemeAppearance | undefined
  if (value.appearance !== undefined) {
    if (value.appearance === "dark" || value.appearance === "light") appearance = value.appearance
    else {
      diagnostics.push(
        diagnostic(source, "invalid-appearance", `appearance must be "dark" or "light"`, {
          themeName: name,
          property: "appearance",
        }),
      )
    }
  }

  const palette = readPalette(value.palette, source, name, diagnostics)
  const tokens = readTokens(value.tokens, source, name, diagnostics)

  if (name === undefined || diagnostics.some((entry) => entry.severity === "error")) {
    return { diagnostics: Object.freeze(diagnostics) }
  }

  return {
    definition: Object.freeze({
      name,
      ...(description === undefined ? {} : { description }),
      ...(appearance === undefined ? {} : { appearance }),
      ...(parent === undefined ? {} : { extends: parent }),
      palette,
      tokens,
    }),
    diagnostics: Object.freeze(diagnostics),
  }
}

interface ThemeCandidate {
  readonly definition: ThemeDefinition
  readonly scope: ThemeSourceScope
  readonly path: string
  readonly rank: number
  readonly order: number
}

interface InternallyResolvedTheme {
  readonly entry: ResolvedTheme
  readonly palette: Readonly<Record<string, string>>
}

function scopeRank(scope: ThemeSourceScope): number {
  return themeScopePrecedence.indexOf(scope)
}

function compareCandidates(left: ThemeCandidate, right: ThemeCandidate): number {
  if (left.rank !== right.rank) return left.rank - right.rank
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  return left.order - right.order
}

function presetCandidate(preset: ThemePresetInput, order: number): ThemeCandidate {
  return {
    definition: {
      name: preset.name,
      description: preset.description,
      ...(preset.appearance === undefined ? {} : { appearance: preset.appearance }),
      palette: Object.freeze({}),
      tokens: Object.freeze({ ...preset.tokens }),
    },
    scope: "builtin",
    path: `builtin:${preset.name}`,
    rank: scopeRank("builtin"),
    order,
  }
}

function freezeResolvedTheme(
  candidate: ThemeCandidate,
  description: string,
  appearance: ThemeAppearance | undefined,
  palette: Readonly<Record<string, string>>,
  tokens: Readonly<Record<ThemeTokenName, string>>,
): InternallyResolvedTheme {
  return Object.freeze({
    entry: Object.freeze({
      name: candidate.definition.name,
      description,
      ...(appearance === undefined ? {} : { appearance }),
      tokens: Object.freeze({ ...tokens }) as unknown as Theme,
      scope: candidate.scope,
      path: candidate.path,
    }),
    palette: Object.freeze({ ...palette }),
  })
}

export function buildThemeCatalog(
  presets: readonly ThemePresetInput[],
  sources: readonly ThemeDocumentSource[],
  initialDiagnostics: readonly ThemeDiagnostic[] = [],
): ThemeCatalog {
  const diagnostics: ThemeDiagnostic[] = [...initialDiagnostics]
  const candidates: ThemeCandidate[] = presets.map(presetCandidate)
  let order = presets.length

  for (const source of sources) {
    const parsed = parseThemeDocument(source.text, source)
    diagnostics.push(...parsed.diagnostics)
    if (!parsed.definition) continue
    candidates.push({
      definition: parsed.definition,
      scope: source.scope,
      path: source.path,
      rank: scopeRank(source.scope),
      order,
    })
    order += 1
  }

  candidates.sort(compareCandidates)
  const candidatesByName = new Map<string, ThemeCandidate[]>()
  for (const candidate of candidates) {
    const earlier = candidatesByName.get(candidate.definition.name) ?? []
    const shadowed = earlier.at(-1)
    if (shadowed) {
      diagnostics.push({
        severity: "warning",
        code: "theme-shadowed",
        message: `Theme "${candidate.definition.name}" from ${candidate.path} shadows ${shadowed.path}`,
        scope: candidate.scope,
        path: candidate.path,
        themeName: candidate.definition.name,
      })
    }
    earlier.push(candidate)
    candidatesByName.set(candidate.definition.name, earlier)
  }

  const memo = new Map<string, InternallyResolvedTheme | null>()
  const resolving: string[] = []
  const reportedCycles = new Set<string>()

  function resolveCandidate(name: string, index: number): InternallyResolvedTheme | undefined {
    const key = `${name}\0${index}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached ?? undefined

    const cycleStart = resolving.indexOf(key)
    if (cycleStart >= 0) {
      const cycleKeys = [...resolving.slice(cycleStart), key]
      const cycleNames = cycleKeys.map((entry) => entry.slice(0, entry.indexOf("\0")))
      const cycleId = cycleKeys.join(">")
      if (!reportedCycles.has(cycleId)) {
        const cycleCandidate = candidatesByName.get(name)?.[index]
        if (cycleCandidate) {
          diagnostics.push({
            severity: "error",
            code: "inheritance-cycle",
            message: `Theme inheritance cycle: ${cycleNames.join(" -> ")}`,
            scope: cycleCandidate.scope,
            path: cycleCandidate.path,
            themeName: name,
            property: "extends",
          })
        }
        reportedCycles.add(cycleId)
      }
      return undefined
    }

    const candidate = candidatesByName.get(name)?.[index]
    if (!candidate) return undefined
    resolving.push(key)

    const definition = candidate.definition
    let parent: InternallyResolvedTheme | undefined
    if (definition.extends !== undefined) {
      const parentCandidates = candidatesByName.get(definition.extends)
      const parentIndex = definition.extends === name ? index - 1 : (parentCandidates?.length ?? 0) - 1
      if (!parentCandidates || parentIndex < 0) {
        diagnostics.push({
          severity: "error",
          code: "missing-parent",
          message: `Theme "${name}" extends missing theme "${definition.extends}"`,
          scope: candidate.scope,
          path: candidate.path,
          themeName: name,
          property: "extends",
        })
        resolving.pop()
        memo.set(key, null)
        return undefined
      }
      parent = resolveName(definition.extends, parentIndex)
      if (!parent) {
        diagnostics.push({
          severity: "error",
          code: "invalid-parent",
          message: `Theme "${name}" extends theme "${definition.extends}", which could not be resolved`,
          scope: candidate.scope,
          path: candidate.path,
          themeName: name,
          property: "extends",
        })
        resolving.pop()
        memo.set(key, null)
        return undefined
      }
    }

    const palette: Record<string, string> = Object.assign(Object.create(null), parent?.palette, definition.palette)
    const tokens: Partial<Record<ThemeTokenName, string>> = Object.assign(Object.create(null), parent?.entry.tokens)
    let invalidReference = false
    for (const tokenName of themeTokenNames) {
      const expression = definition.tokens[tokenName]
      if (expression === undefined) continue
      if (hexColorPattern.test(expression)) {
        tokens[tokenName] = expression
        continue
      }
      const referencedColor = palette[expression]
      if (referencedColor === undefined) {
        diagnostics.push({
          severity: "error",
          code: "unknown-palette-reference",
          message: `Theme token "${tokenName}" references missing palette color "${expression}"`,
          scope: candidate.scope,
          path: candidate.path,
          themeName: name,
          property: `tokens.${tokenName}`,
        })
        invalidReference = true
      } else {
        tokens[tokenName] = referencedColor
      }
    }

    const missingTokens = themeTokenNames.filter((tokenName) => tokens[tokenName] === undefined)
    if (missingTokens.length > 0) {
      diagnostics.push({
        severity: "error",
        code: "incomplete-theme",
        message: `Theme "${name}" is missing tokens: ${missingTokens.join(", ")}`,
        scope: candidate.scope,
        path: candidate.path,
        themeName: name,
        property: "tokens",
      })
    }

    resolving.pop()
    if (invalidReference || missingTokens.length > 0) {
      memo.set(key, null)
      return undefined
    }

    const resolved = freezeResolvedTheme(
      candidate,
      definition.description ?? parent?.entry.description ?? name,
      definition.appearance ?? parent?.entry.appearance,
      palette,
      tokens as Readonly<Record<ThemeTokenName, string>>,
    )
    memo.set(key, resolved)
    return resolved
  }

  function resolveName(name: string, maximumIndex?: number): InternallyResolvedTheme | undefined {
    const namedCandidates = candidatesByName.get(name)
    if (!namedCandidates) return undefined
    const startIndex = Math.min(maximumIndex ?? namedCandidates.length - 1, namedCandidates.length - 1)
    for (let index = startIndex; index >= 0; index -= 1) {
      const resolved = resolveCandidate(name, index)
      if (resolved) return resolved
    }
    return undefined
  }

  const resolvedThemes = new Map<string, ResolvedTheme>()
  for (const name of [...candidatesByName.keys()].sort()) {
    const resolved = resolveName(name)
    if (resolved) resolvedThemes.set(name, resolved.entry)
  }
  return new ThemeCatalog(resolvedThemes, diagnostics)
}
