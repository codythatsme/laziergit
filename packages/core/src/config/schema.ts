import type { ConfigOption, ConfigSchema } from "laziergit"

import { defaultTheme, defaultThemePreset, themePresets } from "../extension/theme"
import { defaultGitConfig, defaultLeader, gitConfigLimits } from "./config"

/** What an Extension contributes to the published schema: its name and its declared options. */
export interface SchemaContribution {
  readonly name: string
  readonly description?: string
  readonly config?: ConfigSchema
}

type JsonSchema = Record<string, unknown>

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

function themeSchema(): JsonSchema {
  const properties: JsonSchema = {
    preset: {
      type: "string",
      enum: themePresets.map((entry) => entry.name),
      default: defaultThemePreset,
      // One line per preset, so the editor's completion list explains the choice rather than
      // making the user try each one and look.
      description: [
        "The palette every token override is applied on top of.",
        ...themePresets.map((entry) => `• ${entry.name} — ${entry.description}`),
      ].join("\n"),
    },
  }
  for (const [token, color] of Object.entries(defaultTheme)) {
    properties[token] = { type: "string", default: color }
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
export function buildConfigSchema(contributions: readonly SchemaContribution[]): JsonSchema {
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
      theme: themeSchema(),
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
