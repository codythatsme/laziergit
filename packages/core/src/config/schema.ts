import type { ConfigOption, ConfigSchema } from "laziergit"

import { defaultTheme, defaultThemePreset, themePresets } from "../extension/theme"
import { themeTokenNames, type ThemeAppearance } from "../theme/catalog"
import { defaultGitConfig, defaultLeader, gitConfigLimits } from "./config"

/** What an Extension contributes to the published schema: its name and its declared options. */
export interface SchemaContribution {
  readonly name: string
  readonly description?: string
  readonly config?: ConfigSchema
}

type JsonSchema = Record<string, unknown>

/** The catalog fields needed to publish theme names without coupling schema code to discovery. */
export interface ThemeSchemaEntry {
  readonly name: string
  readonly description?: string
  readonly appearance?: ThemeAppearance
}

/**
 * Both a catalog and its `list()` result are accepted so schema publication can use whichever
 * form its caller already has.
 */
export type ThemeSchemaSource = readonly ThemeSchemaEntry[] | { readonly list: () => readonly ThemeSchemaEntry[] }

const systemTheme: ThemeSchemaEntry = {
  name: "system",
  description: "Use the terminal's detected palette and light/dark appearance",
}

function hasThemeList(source: ThemeSchemaSource): source is { readonly list: () => readonly ThemeSchemaEntry[] } {
  return "list" in source && typeof source.list === "function"
}

function listedThemes(source: ThemeSchemaSource | undefined): readonly ThemeSchemaEntry[] {
  const entries = source === undefined ? themePresets : hasThemeList(source) ? source.list() : source
  const unique = new Map<string, ThemeSchemaEntry>()
  for (const entry of entries) unique.set(entry.name, entry)
  return [...unique.values()]
}

function configThemes(source: ThemeSchemaSource | undefined): readonly ThemeSchemaEntry[] {
  const entries = listedThemes(source)
  return entries.some((entry) => entry.name === systemTheme.name) ? entries : [...entries, systemTheme]
}

function optionSchema(option: ConfigOption): JsonSchema {
  const shared = {
    ...(option.description === undefined ? {} : { description: option.description }),
    default: option.default,
  }

  // Narrowing on `kind` is what reaches `min`/`max`/`values` — they live on the variants
  // that have them, so there is no absent-constraint case left to invent a fallback for.
  switch (option.kind) {
    case "string":
      return { type: "string", ...shared }
    case "boolean":
      return { type: "boolean", ...shared }
    case "number":
      return {
        type: "number",
        ...(option.min === undefined ? {} : { minimum: option.min }),
        ...(option.max === undefined ? {} : { maximum: option.max }),
        ...shared,
      }
    case "enum":
      return { type: "string", enum: [...option.values], ...shared }
    case "string-array":
      return { type: "array", items: { type: "string" }, ...shared }
  }
}

function extensionSchema(contribution: SchemaContribution): JsonSchema {
  const properties: JsonSchema = {}
  for (const [key, option] of Object.entries(contribution.config ?? {})) properties[key] = optionSchema(option)
  return {
    type: "object",
    ...(contribution.description === undefined ? {} : { description: contribution.description }),
    properties,
    additionalProperties: false,
  }
}

const paneIdSchema: JsonSchema = {
  oneOf: [
    { type: "string", description: "A Pane id" },
    { type: "array", items: { type: "string" }, minItems: 1, description: "Pane ids sharing one cell as tabs" },
  ],
}

const columnSchema: JsonSchema = {
  oneOf: [
    { type: "array", items: paneIdSchema, description: "Cells stacked top to bottom" },
    {
      type: "object",
      properties: {
        weight: { type: "number", exclusiveMinimum: 0, default: 1, description: "Share of the screen width" },
        cells: { type: "array", items: paneIdSchema },
      },
      required: ["cells"],
      additionalProperties: false,
    },
  ],
}

const keysSchema: JsonSchema = {
  oneOf: [
    { type: "string" },
    { type: "array", items: { type: "string" } },
    { type: "null", description: "Unbind the Command" },
  ],
}

function presetVariantSchema(entries: readonly ThemeSchemaEntry[]): JsonSchema {
  const names = entries.map((entry) => entry.name)
  // A missing appearance means the theme author intentionally left it usable in either slot.
  // `system` is a complete automatic selection, not one half of an explicit pair.
  const darkNames = entries
    .filter((entry) => entry.name !== systemTheme.name && entry.appearance !== "light")
    .map((entry) => entry.name)
  const lightNames = entries
    .filter((entry) => entry.name !== systemTheme.name && entry.appearance !== "dark")
    .map((entry) => entry.name)

  return {
    default: defaultThemePreset,
    description: [
      "The palette every token override is applied on top of.",
      "Use one name for a fixed theme, or dark/light names to follow the terminal appearance.",
      ...entries.map((entry) => `• ${entry.name}${entry.description === undefined ? "" : ` — ${entry.description}`}`),
    ].join("\n"),
    oneOf: [
      { type: "string", enum: names },
      {
        type: "object",
        properties: {
          dark: { type: "string", enum: darkNames },
          light: { type: "string", enum: lightNames },
        },
        required: ["dark", "light"],
        additionalProperties: false,
      },
    ],
  }
}

function themeSchema(themes: ThemeSchemaSource | undefined): JsonSchema {
  const properties: JsonSchema = {
    preset: presetVariantSchema(configThemes(themes)),
  }
  for (const [token, color] of Object.entries(defaultTheme)) {
    properties[token] =
      token === "background"
        ? {
            oneOf: [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, { const: "transparent" }],
            default: color,
          }
        : { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: color }
  }
  return { type: "object", properties, additionalProperties: false }
}

function segmentIdsSchema(description: string): JsonSchema {
  return { type: "array", items: { type: "string" }, description }
}

/**
 * Builds the JSON Schema for config.jsonc, including one section per loaded Extension.
 * Published to disk on every reload so editors autocomplete whatever is installed right now.
 */
export function buildConfigSchema(
  contributions: readonly SchemaContribution[],
  themes?: ThemeSchemaSource,
): JsonSchema {
  const extensions: JsonSchema = {}
  for (const contribution of [...contributions].sort((left, right) => left.name.localeCompare(right.name))) {
    extensions[contribution.name] = extensionSchema(contribution)
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "laziergit configuration",
    type: "object",
    properties: {
      $schema: { type: "string" },
      mouse: {
        type: "boolean",
        default: true,
        description: "Capture mouse events for clicking, scrolling, and text selection",
      },
      layout: {
        type: "object",
        description: "Columns of Panes. Panes left out fall back to their Extension's placement hint.",
        properties: {
          columns: { type: "array", items: columnSchema },
          focus: { type: "string", description: "Pane id to focus at startup; defaults to the first cell" },
        },
        additionalProperties: false,
      },
      keybindings: {
        type: "object",
        description: "Command id to key spec. Overrides the Command's default keys; null unbinds it.",
        additionalProperties: keysSchema,
      },
      theme: themeSchema(themes),
      statusline: {
        type: "object",
        properties: {
          left: segmentIdsSchema("Segment ids pinned left, in order"),
          right: segmentIdsSchema("Segment ids pinned right, in order"),
          hidden: segmentIdsSchema("Segment ids to hide"),
        },
        additionalProperties: false,
      },
      leader: { type: "string", default: defaultLeader, description: "The key <leader> expands to" },
      git: {
        type: "object",
        properties: {
          refreshIntervalMs: {
            type: "integer",
            minimum: gitConfigLimits.refreshIntervalMs.min,
            maximum: gitConfigLimits.refreshIntervalMs.max,
            default: defaultGitConfig.refreshIntervalMs,
            description: "How often to look for changes made outside laziergit",
          },
          commitLimit: {
            type: "integer",
            minimum: gitConfigLimits.commitLimit.min,
            maximum: gitConfigLimits.commitLimit.max,
            default: defaultGitConfig.commitLimit,
            description: "How much of HEAD's history the git store holds",
          },
        },
        additionalProperties: false,
      },
      extensions: {
        type: "object",
        properties: extensions,
        additionalProperties: { type: "object" },
      },
    },
    additionalProperties: false,
  }
}

/**
 * Builds the strict schema shared by global and repository theme documents.
 *
 * A root theme must provide every token. An extending theme may override any subset because
 * completeness is checked after inheritance. Token values accept either a full hex color or a
 * palette key; JSON Schema cannot enumerate palette keys because they are local to each document.
 */
export function buildThemeDocumentSchema(themes?: ThemeSchemaSource): JsonSchema {
  const entries = listedThemes(themes)
  const knownNames = entries.map((entry) => entry.name)
  const tokenValueSchema: JsonSchema = {
    oneOf: [
      { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      {
        type: "string",
        pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
        description: "A key declared in this document's palette or inherited from its parent",
      },
    ],
  }
  const tokenProperties: JsonSchema = {}
  for (const token of themeTokenNames) {
    tokenProperties[token] =
      token === "background"
        ? {
            oneOf: [
              ...(tokenValueSchema.oneOf as readonly JsonSchema[]),
              { const: "transparent", description: "Preserve the terminal's native background" },
            ],
          }
        : tokenValueSchema
  }

  const rootCompleteness: JsonSchema = {
    if: { not: { required: ["extends"] } },
  }
  Reflect.set(rootCompleteness, "then", {
    required: ["tokens"],
    properties: {
      tokens: { required: [...themeTokenNames] },
    },
  })

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "laziergit theme",
    type: "object",
    properties: {
      $schema: { type: "string" },
      name: {
        type: "string",
        pattern: "^(?!system$)[a-z0-9][a-z0-9._-]*$",
        description: "Theme name used by theme.preset",
      },
      description: { type: "string", pattern: "\\S" },
      appearance: { type: "string", enum: ["dark", "light"] },
      extends: {
        type: "string",
        ...(knownNames.length === 0 ? { pattern: "^[a-z0-9][a-z0-9._-]*$" } : { enum: knownNames }),
        description: "A built-in or discovered theme to inherit before applying this document",
      },
      palette: {
        type: "object",
        propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_-]*$" },
        additionalProperties: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      },
      tokens: {
        type: "object",
        properties: tokenProperties,
        additionalProperties: false,
      },
    },
    required: ["name"],
    additionalProperties: false,
    allOf: [rootCompleteness],
  }
}
