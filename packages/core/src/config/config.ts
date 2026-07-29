import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ConfigSchema, ConfigValue, Theme } from "laziergit"

import { errorCode } from "../extension/diagnostics"
import { defaultTheme, defaultThemePreset, themePresets } from "../extension/theme"
import {
  buildThemeCatalog,
  type ThemeAppearance,
  type ThemeCatalog,
  type ThemeConfiguration,
  type ThemeSelection,
} from "../theme"
import { parseJsonc } from "./jsonc"

/** One cell of the Layout: a single Pane id, or a tab group sharing one cell. */
export type LayoutCell = readonly string[]

export interface LayoutColumn {
  /** Relative share of the screen width against the other columns. */
  readonly weight: number
  readonly cells: readonly LayoutCell[]
}

export interface LayoutConfig {
  readonly columns: readonly LayoutColumn[]
  /**
   * The Pane focused when laziergit starts, or null to take the first cell. Reading order and
   * working order are not the same question: a Layout puts first what you want to read first.
   */
  readonly focus: string | null
}

export interface StatuslineConfig {
  /** Segment ids pinned to the left edge, in order. Unlisted segments keep their own placement. */
  readonly left: readonly string[]
  readonly right: readonly string[]
  readonly hidden: ReadonlySet<string>
}

export interface GitConfig {
  /**
   * How often to look for changes made outside laziergit. Each tick reads a cheap fingerprint
   * and only refreshes when it differs.
   */
  readonly refreshIntervalMs: number
  /** How much of HEAD's history the store holds. Page deeper with `ctx.git.raw(["log", ...])`. */
  readonly commitLimit: number
}

export interface CoreConfig {
  /** `null` when the user declared no Layout — placement hints then decide everything. */
  readonly layout: LayoutConfig | null
  /** Command id → the keys bound to it. An empty array unbinds the Command's defaults. */
  readonly keybindings: ReadonlyMap<string, readonly string[]>
  readonly theme: Theme
  /** Retained independently from the resolved Theme so terminal appearance can change in place. */
  readonly themeConfiguration: ThemeConfiguration
  readonly statusline: StatuslineConfig
  /** The key `<leader>` expands to in a {@link KeySpec}. */
  readonly leader: string
  readonly git: GitConfig
}

/** A rejected config value. Every problem degrades one setting to its default; none block startup. */
export interface ConfigProblem {
  /** Dotted path into the merged document, e.g. `layout.columns[0]`. */
  readonly path: string
  readonly message: string
}

export interface LoadedConfig {
  readonly core: CoreConfig
  /** Raw per-extension sections, validated later against each Extension's own schema. */
  readonly extensions: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  readonly problems: readonly ConfigProblem[]
}

export interface ConfigFiles {
  readonly global: string
  readonly repo: string
}

export const defaultLeader = "space"

/** Exported so the published JSON Schema advertises the same numbers the reader defaults to. */
export const defaultGitConfig: GitConfig = Object.freeze({ refreshIntervalMs: 2000, commitLimit: 200 })

export const gitConfigLimits = Object.freeze({
  refreshIntervalMs: Object.freeze({ min: 250, max: 60_000 }),
  commitLimit: Object.freeze({ min: 1, max: 5000 }),
})

export function defaultConfigFiles(repoRoot: string): ConfigFiles {
  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return {
    global: join(configRoot, "laziergit", "config.jsonc"),
    repo: join(repoRoot, ".laziergit", "config.jsonc"),
  }
}

export const emptyConfig: LoadedConfig = Object.freeze({
  core: Object.freeze({
    layout: null,
    keybindings: new Map<string, readonly string[]>(),
    theme: defaultTheme,
    themeConfiguration: Object.freeze({
      selection: defaultThemePreset,
      overrides: Object.freeze({}),
    }),
    statusline: Object.freeze({ left: Object.freeze([]), right: Object.freeze([]), hidden: new Set<string>() }),
    leader: defaultLeader,
    git: defaultGitConfig,
  }),
  extensions: new Map<string, Readonly<Record<string, unknown>>>(),
  problems: Object.freeze([]),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

const builtinThemeCatalog = buildThemeCatalog(themePresets, [])
const hexColorPattern = /^#[0-9a-fA-F]{6}$/

export interface ConfigThemeOptions {
  readonly catalog?: ThemeCatalog
  readonly appearance?: ThemeAppearance
  readonly systemTheme?: Theme
}

class ProblemLog {
  readonly #problems: ConfigProblem[] = []

  get problems(): readonly ConfigProblem[] {
    return this.#problems
  }

  reject(path: string, message: string): undefined {
    this.#problems.push({ path, message })
    return undefined
  }
}

/**
 * Repo settings win over global ones, key by key. Objects merge so a repo file can
 * override a single Extension option; arrays replace so a repo Layout is never a
 * confusing concatenation of two Layouts.
 */
function mergeConfigValues(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override
  // A null prototype keeps a `"__proto__"` key inert here too: assigning it on an
  // ordinary object would run the setter and reparent the merged document.
  const merged: Record<string, unknown> = Object.assign(Object.create(null), base)
  for (const [key, value] of Object.entries(override)) {
    merged[key] = Object.hasOwn(merged, key) ? mergeConfigValues(merged[key], value) : value
  }
  return merged
}

function readLayoutCell(value: unknown, path: string, log: ProblemLog): LayoutCell | undefined {
  if (typeof value === "string") return [value]
  if (isStringArray(value)) {
    if (value.length === 0) return log.reject(path, "A tab group needs at least one Pane id")
    return [...value]
  }
  return log.reject(path, "A Layout cell must be a Pane id or an array of Pane ids")
}

const layoutColumnKeys = new Set(["weight", "cells"])

function readLayoutColumn(value: unknown, path: string, log: ProblemLog): LayoutColumn | undefined {
  const source = Array.isArray(value) ? { cells: value } : value
  if (!isRecord(source)) return log.reject(path, "A Layout column must be an array of cells or an object")

  for (const key of Object.keys(source)) {
    if (!layoutColumnKeys.has(key)) log.reject(`${path}.${key}`, "Unknown Layout column setting")
  }

  const rawCells = source.cells
  if (!Array.isArray(rawCells)) return log.reject(`${path}.cells`, "A Layout column must declare an array of cells")

  const cells: LayoutCell[] = []
  for (const [index, rawCell] of rawCells.entries()) {
    const cell = readLayoutCell(rawCell, `${path}.cells[${index}]`, log)
    if (cell) cells.push(cell)
  }
  if (cells.length === 0) return log.reject(path, "A Layout column needs at least one cell")

  let weight = 1
  if (source.weight !== undefined) {
    if (typeof source.weight === "number" && Number.isFinite(source.weight) && source.weight > 0) {
      weight = source.weight
    } else {
      log.reject(`${path}.weight`, "Column weight must be a number greater than zero")
    }
  }
  return { weight, cells }
}

const layoutKeys = new Set(["columns", "focus"])

function readLayout(value: unknown, log: ProblemLog): LayoutConfig | null {
  if (value === undefined) return null
  if (!isRecord(value)) {
    log.reject("layout", "layout must be an object with a columns array")
    return null
  }

  // Reported before anything is read: a misspelled `columns` leaves a Layout that is valid and
  // empty, which is indistinguishable from having declared no Layout at all.
  for (const key of Object.keys(value)) {
    if (!layoutKeys.has(key)) log.reject(`layout.${key}`, "Unknown Layout setting")
  }

  const columns: LayoutColumn[] = []
  if (Array.isArray(value.columns)) {
    for (const [index, rawColumn] of value.columns.entries()) {
      const column = readLayoutColumn(rawColumn, `layout.columns[${index}]`, log)
      if (column) columns.push(column)
    }
  } else if (value.columns !== undefined) {
    log.reject("layout.columns", "layout.columns must be an array of columns")
  }

  let focus: string | null = null
  if (value.focus !== undefined) {
    if (typeof value.focus === "string" && value.focus.trim().length > 0) focus = value.focus
    else log.reject("layout.focus", "layout.focus must be the id of a Pane to start focused")
  }

  // A `focus` on its own is still a Layout: hints place the Panes, this says where to start.
  return columns.length === 0 && focus === null ? null : { columns, focus }
}

function readKeybindings(value: unknown, log: ProblemLog): ReadonlyMap<string, readonly string[]> {
  const keybindings = new Map<string, readonly string[]>()
  if (value === undefined) return keybindings
  if (!isRecord(value)) {
    log.reject("keybindings", "keybindings must be an object mapping Command ids to keys")
    return keybindings
  }

  for (const [id, binding] of Object.entries(value)) {
    if (binding === null) {
      keybindings.set(id, [])
    } else if (typeof binding === "string") {
      keybindings.set(id, [binding])
    } else if (isStringArray(binding)) {
      keybindings.set(id, [...binding])
    } else {
      log.reject(`keybindings.${id}`, "A keybinding must be a key string, an array of key strings, or null")
    }
  }
  return keybindings
}

function knownThemeNames(catalog: ThemeCatalog): readonly string[] {
  return [...catalog.list().map((entry) => entry.name), "system"].toSorted()
}

function readThemeName(value: unknown, path: string, fallback: string, catalog: ThemeCatalog, log: ProblemLog): string {
  if (typeof value === "string" && (value === "system" || catalog.has(value))) return value
  log.reject(path, `Unknown theme preset — pick one of: ${knownThemeNames(catalog).join(", ")}`)
  return fallback
}

function readThemeSelection(value: unknown, catalog: ThemeCatalog, log: ProblemLog): ThemeSelection {
  if (typeof value === "string") return readThemeName(value, "theme.preset", defaultThemePreset, catalog, log)
  if (!isRecord(value)) {
    log.reject("theme.preset", "theme.preset must be a theme name or an object with dark and light theme names")
    return defaultThemePreset
  }

  for (const key of Object.keys(value)) {
    if (key !== "dark" && key !== "light") log.reject(`theme.preset.${key}`, "Unknown automatic theme setting")
  }
  return Object.freeze({
    dark: readThemeName(value.dark, "theme.preset.dark", defaultThemePreset, catalog, log),
    light: readThemeName(value.light, "theme.preset.light", "daybreak", catalog, log),
  })
}

export function resolveThemeConfiguration(configuration: ThemeConfiguration, options: ConfigThemeOptions = {}): Theme {
  const catalog = options.catalog ?? builtinThemeCatalog
  const appearance = options.appearance ?? "dark"
  const selectedName =
    typeof configuration.selection === "string" ? configuration.selection : configuration.selection[appearance]
  const fallbackName = appearance === "light" ? "daybreak" : defaultThemePreset
  const base =
    selectedName === "system"
      ? (options.systemTheme ?? catalog.get(fallbackName)?.tokens ?? defaultTheme)
      : (catalog.get(selectedName)?.tokens ?? catalog.get(fallbackName)?.tokens ?? defaultTheme)
  return Object.freeze({ ...base, ...configuration.overrides })
}

function readTheme(
  value: unknown,
  log: ProblemLog,
  options: ConfigThemeOptions,
): Pick<CoreConfig, "theme" | "themeConfiguration"> {
  const catalog = options.catalog ?? builtinThemeCatalog
  if (value === undefined) {
    return {
      theme: resolveThemeConfiguration(emptyConfig.core.themeConfiguration, options),
      themeConfiguration: emptyConfig.core.themeConfiguration,
    }
  }
  if (!isRecord(value)) {
    log.reject("theme", 'theme must be an object — a "preset" name, color tokens, or both')
    return {
      theme: resolveThemeConfiguration(emptyConfig.core.themeConfiguration, options),
      themeConfiguration: emptyConfig.core.themeConfiguration,
    }
  }

  const { preset, ...tokens } = value
  const selection = preset === undefined ? defaultThemePreset : readThemeSelection(preset, catalog, log)

  const overrides: Record<string, string> = {}
  for (const [token, color] of Object.entries(tokens)) {
    if (!Object.hasOwn(defaultTheme, token)) {
      log.reject(`theme.${token}`, "Unknown theme token")
      continue
    }
    if (typeof color !== "string" || !hexColorPattern.test(color)) {
      log.reject(`theme.${token}`, "A theme token must use #RRGGBB")
      continue
    }
    overrides[token] = color.toLowerCase()
  }
  const themeConfiguration = Object.freeze({
    selection,
    overrides: Object.freeze(overrides),
  })
  return {
    theme: resolveThemeConfiguration(themeConfiguration, options),
    themeConfiguration,
  }
}

function readStatusline(value: unknown, log: ProblemLog): StatuslineConfig {
  if (value === undefined) return emptyConfig.core.statusline
  if (!isRecord(value)) {
    log.reject("statusline", "statusline must be an object with left, right, and hidden arrays")
    return emptyConfig.core.statusline
  }

  // Keyed off the default section rather than a second list of names: a new statusline
  // setting cannot ship without a default, so it can never be missed here.
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(emptyConfig.core.statusline, key)) log.reject(`statusline.${key}`, "Unknown statusline setting")
  }

  const readIds = (key: "left" | "right" | "hidden"): readonly string[] => {
    const ids = value[key]
    if (ids === undefined) return []
    if (!isStringArray(ids)) {
      log.reject(`statusline.${key}`, `statusline.${key} must be an array of segment ids`)
      return []
    }
    return ids
  }

  return {
    left: [...readIds("left")],
    right: [...readIds("right")],
    hidden: new Set(readIds("hidden")),
  }
}

function readLeader(value: unknown, log: ProblemLog): string {
  if (value === undefined) return defaultLeader
  if (typeof value !== "string" || value.trim().length === 0) {
    log.reject("leader", "leader must be a non-empty key string")
    return defaultLeader
  }
  return value
}

function readGitSetting(
  value: unknown,
  key: keyof GitConfig,
  limits: { readonly min: number; readonly max: number },
  log: ProblemLog,
): number {
  const fallback = defaultGitConfig[key]
  if (value === undefined) return fallback
  const path = `git.${key}`
  if (typeof value !== "number" || !Number.isInteger(value))
    return log.reject(path, "Expected a whole number") ?? fallback
  if (value < limits.min) return log.reject(path, `Must be at least ${limits.min}`) ?? fallback
  if (value > limits.max) return log.reject(path, `Must be at most ${limits.max}`) ?? fallback
  return value
}

function readGit(value: unknown, log: ProblemLog): GitConfig {
  if (value === undefined) return defaultGitConfig
  if (!isRecord(value)) {
    log.reject("git", "git must be an object of git settings")
    return defaultGitConfig
  }

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaultGitConfig, key)) log.reject(`git.${key}`, "Unknown git setting")
  }

  // Each setting degrades on its own: an unusable interval must not also reset the commit window.
  return Object.freeze({
    refreshIntervalMs: readGitSetting(
      value.refreshIntervalMs,
      "refreshIntervalMs",
      gitConfigLimits.refreshIntervalMs,
      log,
    ),
    commitLimit: readGitSetting(value.commitLimit, "commitLimit", gitConfigLimits.commitLimit, log),
  })
}

function readExtensionSections(
  value: unknown,
  log: ProblemLog,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const sections = new Map<string, Readonly<Record<string, unknown>>>()
  if (value === undefined) return sections
  if (!isRecord(value)) {
    log.reject("extensions", "extensions must be an object keyed by Extension name")
    return sections
  }

  for (const [name, section] of Object.entries(value)) {
    if (!isRecord(section)) {
      log.reject(`extensions.${name}`, "An Extension config section must be an object")
      continue
    }
    // The copy must not hand back the prototype the parser deliberately left off:
    // `resolveExtensionConfig` reads every declared option by name, so an option called
    // `toString` would find `Object.prototype`'s and reject it as a value nobody wrote.
    const isolated: Record<string, unknown> = Object.assign(Object.create(null), section)
    sections.set(name, Object.freeze(isolated))
  }
  return sections
}

const coreSectionKeys = new Set([
  "$schema",
  "layout",
  "keybindings",
  "theme",
  "statusline",
  "leader",
  "git",
  "extensions",
])

/** Splits one merged document into the core sections and the raw per-Extension sections. */
export function readConfig(document: unknown, themeOptions: ConfigThemeOptions = {}): LoadedConfig {
  const log = new ProblemLog()
  if (document === undefined) return emptyConfig
  if (!isRecord(document)) {
    log.reject("", "config.jsonc must contain a JSON object")
    return { ...emptyConfig, problems: log.problems }
  }

  for (const key of Object.keys(document)) {
    if (!coreSectionKeys.has(key)) log.reject(key, "Unknown config section")
  }

  // Read in schema order so diagnostics stay deterministic and match the document's conceptual
  // sections even though the returned object also carries Theme resolution metadata.
  const layout = readLayout(document.layout, log)
  const keybindings = readKeybindings(document.keybindings, log)
  const configuredTheme = readTheme(document.theme, log, themeOptions)
  const statusline = readStatusline(document.statusline, log)
  const leader = readLeader(document.leader, log)
  const git = readGit(document.git, log)
  const extensions = readExtensionSections(document.extensions, log)
  return {
    core: {
      layout,
      keybindings,
      ...configuredTheme,
      statusline,
      leader,
      git,
    },
    extensions,
    problems: log.problems,
  }
}

function readOptionValue(
  option: ConfigSchema[string],
  raw: unknown,
  path: string,
  log: ProblemLog,
): ConfigValue | undefined {
  switch (option.kind) {
    case "string":
      if (typeof raw === "string") return raw
      return log.reject(path, "Expected a string")
    case "boolean":
      if (typeof raw === "boolean") return raw
      return log.reject(path, "Expected a boolean")
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return log.reject(path, "Expected a number")
      if (option.min !== undefined && raw < option.min) return log.reject(path, `Must be at least ${option.min}`)
      if (option.max !== undefined && raw > option.max) return log.reject(path, `Must be at most ${option.max}`)
      return raw
    }
    case "enum": {
      if (typeof raw === "string" && option.values.includes(raw)) return raw
      return log.reject(path, `Expected one of ${option.values.map((value) => `"${value}"`).join(", ")}`)
    }
    case "string-array":
      if (isStringArray(raw)) return Object.freeze([...raw])
      return log.reject(path, "Expected an array of strings")
  }
}

export interface ExtensionConfigResult {
  readonly values: Readonly<Record<string, ConfigValue>>
  readonly problems: readonly ConfigProblem[]
}

/**
 * Applies one Extension's declared schema to its raw section. Every option is present
 * in the result: a rejected value falls back to its default with a problem recorded, so
 * bad config degrades an Extension instead of blocking activation.
 */
export function resolveExtensionConfig(
  name: string,
  schema: ConfigSchema | undefined,
  raw: Readonly<Record<string, unknown>> | undefined,
): ExtensionConfigResult {
  const log = new ProblemLog()
  const values: Record<string, ConfigValue> = {}

  for (const [key, option] of Object.entries(schema ?? {})) {
    const path = `extensions.${name}.${key}`
    const provided = raw?.[key]
    const value = provided === undefined ? undefined : readOptionValue(option, provided, path, log)
    const fallback = Array.isArray(option.default) ? Object.freeze([...option.default]) : option.default
    values[key] = value ?? fallback
  }

  for (const key of Object.keys(raw ?? {})) {
    if (!(schema && Object.hasOwn(schema, key))) log.reject(`extensions.${name}.${key}`, "Unknown option")
  }

  return { values: Object.freeze(values), problems: log.problems }
}

export interface ConfigDocument {
  readonly path: string
  /** Verbatim file text, or `null` when the file is absent or unreadable. */
  readonly text: string | null
  /** Why the file could not be read, when that is the reason `text` is null. */
  readonly unreadable?: string
}

/**
 * Reads both config files without parsing, so change detection never depends on validity.
 * Every failure is per file: an unreadable global config must not take the repo's down too.
 */
export async function readConfigDocuments(files: ConfigFiles): Promise<readonly ConfigDocument[]> {
  return Promise.all(
    [files.global, files.repo].map(async (path) => {
      try {
        return { path, text: await readFile(path, "utf8") }
      } catch (error) {
        const code = errorCode(error)
        if (code === "ENOENT" || code === "EISDIR") return { path, text: null }
        return { path, text: null, unreadable: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
}

/**
 * Parses and merges the documents in global → repo order. A file that fails to parse is
 * skipped with a problem recorded; the other file still applies.
 */
export function loadConfig(documents: readonly ConfigDocument[], themeOptions: ConfigThemeOptions = {}): LoadedConfig {
  const parseProblems: ConfigProblem[] = []
  let merged: unknown = undefined

  for (const document of documents) {
    if (document.unreadable !== undefined) parseProblems.push({ path: document.path, message: document.unreadable })
    if (document.text === null) continue
    try {
      const parsed = parseJsonc(document.text)
      // An empty or comments-only file contributes nothing rather than erasing the other.
      if (parsed === undefined) continue
      merged = merged === undefined ? parsed : mergeConfigValues(merged, parsed)
    } catch (error) {
      parseProblems.push({
        path: document.path,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const loaded = readConfig(merged, themeOptions)
  return parseProblems.length === 0 ? loaded : { ...loaded, problems: [...parseProblems, ...loaded.problems] }
}
