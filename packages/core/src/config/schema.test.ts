import { describe, expect, it } from "bun:test"

import { themePresets } from "../extension/theme"
import { themeTokenNames } from "../theme/catalog"
import { buildConfigSchema, buildThemeDocumentSchema, type ThemeSchemaEntry, type ThemeSchemaSource } from "./schema"

interface StringChoiceSchema {
  readonly type: "string"
  readonly enum: readonly string[]
}

interface PresetSchema {
  readonly default: string
  readonly description: string
  readonly oneOf: readonly [
    StringChoiceSchema,
    {
      readonly type: "object"
      readonly properties: {
        readonly dark: StringChoiceSchema
        readonly light: StringChoiceSchema
      }
      readonly required: readonly string[]
      readonly additionalProperties: false
    },
  ]
}

function configPresetSchema(themes?: ThemeSchemaSource): PresetSchema {
  const schema = buildConfigSchema([], themes)
  return (
    schema.properties as {
      readonly theme: {
        readonly properties: { readonly preset: PresetSchema }
      }
    }
  ).theme.properties.preset
}

describe("buildConfigSchema themes", () => {
  it("publishes built-ins plus system when no live catalog is supplied", () => {
    const preset = configPresetSchema()
    const [fixed, automatic] = preset.oneOf

    expect(fixed.enum).toEqual([...themePresets.map((entry) => entry.name), "system"])
    expect(automatic.properties.dark.enum).toContain("nocturne")
    expect(automatic.properties.dark.enum).not.toContain("daybreak")
    expect(automatic.properties.light.enum).toContain("daybreak")
    expect(automatic.properties.light.enum).not.toContain("nocturne")
    expect(automatic.properties.dark.enum).not.toContain("system")
    expect(automatic.properties.light.enum).not.toContain("system")
    expect(automatic.required).toEqual(["dark", "light"])
    expect(preset.description).toContain("dark/light names")
  })

  it("accepts either a live catalog or its list and preserves appearance-aware completions", () => {
    const entries: readonly ThemeSchemaEntry[] = [
      { name: "custom-dark", description: "Dark custom", appearance: "dark" },
      { name: "custom-light", description: "Light custom", appearance: "light" },
      { name: "flexible", description: "No declared appearance" },
    ]
    const catalog = { list: () => entries }

    for (const source of [entries, catalog] as const) {
      const [fixed, automatic] = configPresetSchema(source).oneOf
      expect(fixed.enum).toEqual(["custom-dark", "custom-light", "flexible", "system"])
      expect(automatic.properties.dark.enum).toEqual(["custom-dark", "flexible"])
      expect(automatic.properties.light.enum).toEqual(["custom-light", "flexible"])
    }
  })
})

describe("buildThemeDocumentSchema", () => {
  it("publishes the parser's document fields, token vocabulary and color formats", () => {
    const schema = buildThemeDocumentSchema([{ name: "parent", appearance: "dark" }])
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const tokenSchema = properties.tokens as {
      readonly properties: Record<string, { readonly oneOf: readonly Record<string, unknown>[] }>
      readonly additionalProperties: false
    }

    expect(Object.keys(properties)).toEqual([
      "$schema",
      "name",
      "description",
      "appearance",
      "extends",
      "palette",
      "tokens",
    ])
    expect(schema.additionalProperties).toBeFalse()
    expect(properties.extends?.enum).toEqual(["parent"])
    expect(Object.keys(tokenSchema.properties)).toEqual([...themeTokenNames])
    expect(tokenSchema.additionalProperties).toBeFalse()
    expect(tokenSchema.properties.accent?.oneOf).toEqual([
      { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      {
        type: "string",
        pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
        description: "A key declared in this document's palette or inherited from its parent",
      },
    ])
    expect(properties.palette?.propertyNames).toEqual({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$" })
    expect(properties.palette?.additionalProperties).toEqual({
      type: "string",
      pattern: "^#[0-9a-fA-F]{6}$",
    })
  })

  it("requires all semantic tokens only when a theme has no parent", () => {
    const schema = buildThemeDocumentSchema()
    const condition = (schema.allOf as readonly Record<string, unknown>[])[0]
    expect(schema.required).toEqual(["name"])
    expect(condition?.if).toEqual({ not: { required: ["extends"] } })
    expect(condition?.["then"]).toEqual({
      required: ["tokens"],
      properties: {
        tokens: { required: [...themeTokenNames] },
      },
    })
  })
})
