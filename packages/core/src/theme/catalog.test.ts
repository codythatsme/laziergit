import { describe, expect, it } from "bun:test"

import { defaultTheme, themePresets } from "../extension/theme"
import {
  buildThemeCatalog,
  parseThemeDocument,
  retainLastValidThemes,
  themeScopePrecedence,
  themeTokenNames,
  type ThemeDocumentSource,
} from "./catalog"

function source(
  path: string,
  document: Readonly<Record<string, unknown>>,
  scope: ThemeDocumentSource["scope"] = "global",
): ThemeDocumentSource {
  return { scope, path, text: JSON.stringify(document) }
}

describe("parseThemeDocument", () => {
  it("accepts inheritance, appearance, palette colors and palette references", () => {
    const parsed = parseThemeDocument(
      JSON.stringify({
        $schema: "./theme.schema.json",
        name: "rose-pine",
        description: "Muted rose",
        appearance: "dark",
        extends: "nocturne",
        palette: { base: "#191724", rose: "#EBBCBA" },
        tokens: { background: "base", accent: "rose", danger: "#ff0000" },
      }),
      { scope: "global", path: "/themes/rose-pine.json" },
    )

    expect(parsed.diagnostics).toEqual([])
    expect(parsed.definition).toEqual({
      name: "rose-pine",
      description: "Muted rose",
      appearance: "dark",
      extends: "nocturne",
      palette: { base: "#191724", rose: "#EBBCBA" },
      tokens: { background: "base", accent: "rose", danger: "#ff0000" },
    })
  })

  it("rejects misspelled tokens, shorthand colors and unknown appearances", () => {
    const parsed = parseThemeDocument(
      JSON.stringify({
        name: "broken",
        appearance: "automatic",
        tokens: { acent: "#ffffff", accent: "#fff" },
      }),
      { scope: "repo", path: "/repo/broken.json" },
    )

    expect(parsed.definition).toBeUndefined()
    expect(parsed.diagnostics.map((entry) => [entry.code, entry.property])).toEqual([
      ["invalid-appearance", "appearance"],
      ["unknown-token", "tokens.acent"],
      ["invalid-token-value", "tokens.accent"],
    ])
  })

  it("reserves system for the generated terminal palette", () => {
    const parsed = parseThemeDocument(JSON.stringify({ name: "system", extends: "nocturne" }), {
      scope: "global",
      path: "/themes/system.json",
    })

    expect(parsed.definition).toBeUndefined()
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-name", property: "name", message: expect.stringContaining("reserved") }),
    ])
  })

  it("allows transparency only for the canvas background", () => {
    const accepted = parseThemeDocument(
      JSON.stringify({
        name: "native-canvas",
        extends: "daybreak",
        tokens: { background: "transparent" },
      }),
      { scope: "global", path: "/themes/native-canvas.json" },
    )
    const rejected = parseThemeDocument(
      JSON.stringify({
        name: "transparent-panel",
        extends: "daybreak",
        tokens: { backgroundPanel: "transparent" },
      }),
      { scope: "global", path: "/themes/transparent-panel.json" },
    )

    expect(accepted.diagnostics).toEqual([])
    expect(accepted.definition?.tokens.background).toBe("transparent")
    expect(rejected.definition).toBeUndefined()
    expect(rejected.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-token-value", property: "tokens.backgroundPanel" }),
    ])
  })

  it("publishes the exact token vocabulary of the default public Theme", () => {
    expect([...themeTokenNames] as string[]).toEqual(Object.keys(defaultTheme))
  })
})

describe("buildThemeCatalog", () => {
  it("resolves a transparent canvas as a direct background value", () => {
    const catalog = buildThemeCatalog(themePresets, [
      source("/global/native-canvas.json", {
        name: "native-canvas",
        extends: "daybreak",
        tokens: { background: "transparent" },
      }),
    ])

    expect(catalog.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
    expect(catalog.get("native-canvas")?.tokens.background).toBe("transparent")
  })

  it("inherits palette, appearance and tokens before applying a child override", () => {
    const catalog = buildThemeCatalog(themePresets, [
      source("/global/a-parent.json", {
        name: "parent",
        appearance: "dark",
        extends: "nocturne",
        palette: { rose: "#ebbcba" },
        tokens: { accent: "rose" },
      }),
      source(
        "/repo/child.json",
        {
          name: "child",
          description: "Child theme",
          extends: "parent",
          tokens: { borderFocused: "rose" },
        },
        "repo",
      ),
    ])

    expect(catalog.get("child")).toEqual({
      name: "child",
      description: "Child theme",
      appearance: "dark",
      scope: "repo",
      path: "/repo/child.json",
      tokens: {
        ...defaultTheme,
        accent: "#ebbcba",
        borderFocused: "#ebbcba",
      },
    })
  })

  it("resolves precedence independent of source input order", () => {
    const catalog = buildThemeCatalog(themePresets, [
      source(
        "/repo/shared.json",
        {
          name: "shared",
          extends: "nocturne",
          tokens: { accent: "#333333" },
        },
        "repo",
      ),
      source("/global/z-shared.json", {
        name: "shared",
        extends: "nocturne",
        tokens: { accent: "#222222" },
      }),
      source("/global/a-shared.json", {
        name: "shared",
        extends: "nocturne",
        tokens: { accent: "#111111" },
      }),
    ])

    expect(themeScopePrecedence).toEqual(["builtin", "global", "repo"])
    expect(catalog.get("shared")).toEqual(
      expect.objectContaining({
        scope: "repo",
        path: "/repo/shared.json",
        tokens: expect.objectContaining({ accent: "#333333" }),
      }),
    )
    expect(catalog.diagnostics.filter((entry) => entry.code === "theme-shadowed")).toHaveLength(2)
  })

  it("allows a custom theme to extend the lower-precedence theme it shadows", () => {
    const catalog = buildThemeCatalog(themePresets, [
      source("/global/nocturne.json", {
        name: "nocturne",
        extends: "nocturne",
        tokens: { accent: "#123456" },
      }),
    ])

    expect(catalog.get("nocturne")).toEqual(
      expect.objectContaining({
        scope: "global",
        tokens: { ...defaultTheme, accent: "#123456" },
      }),
    )
  })

  it("keeps a valid lower-precedence theme when a shadowing document is rejected", () => {
    const catalog = buildThemeCatalog(themePresets, [
      {
        scope: "repo",
        path: "/repo/nocturne.json",
        text: JSON.stringify({ name: "nocturne", tokens: { accent: "#fff" } }),
      },
    ])

    expect(catalog.get("nocturne")).toEqual(expect.objectContaining({ scope: "builtin", tokens: defaultTheme }))
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-token-value", path: "/repo/nocturne.json" }),
    ])
  })

  it("isolates missing parents, cycles, palette misses and incomplete themes", () => {
    const catalog = buildThemeCatalog(themePresets, [
      source("/global/a.json", { name: "a", extends: "b" }),
      source("/global/b.json", { name: "b", extends: "a" }),
      source("/global/missing.json", { name: "missing", extends: "absent" }),
      source("/global/palette.json", {
        name: "palette-miss",
        extends: "nocturne",
        tokens: { accent: "notDefined" },
      }),
      source("/global/incomplete.json", { name: "incomplete", tokens: { accent: "#123456" } }),
    ])

    expect(catalog.has("a")).toBeFalse()
    expect(catalog.has("b")).toBeFalse()
    expect(catalog.has("missing")).toBeFalse()
    expect(catalog.has("palette-miss")).toBeFalse()
    expect(catalog.has("incomplete")).toBeFalse()
    expect(catalog.has("nocturne")).toBeTrue()
    expect(new Set(catalog.diagnostics.map((entry) => entry.code))).toEqual(
      new Set([
        "inheritance-cycle",
        "invalid-parent",
        "missing-parent",
        "unknown-palette-reference",
        "incomplete-theme",
      ]),
    )
  })

  it("lists successfully resolved themes by name", () => {
    const catalog = buildThemeCatalog(themePresets, [
      source("/global/zeta.json", { name: "zeta", extends: "nocturne" }),
      source("/global/alpha.json", { name: "alpha", extends: "nocturne" }),
    ])

    const names = catalog.list().map((theme) => theme.name)
    expect(names).toEqual(names.toSorted())
  })

  it("retains the last valid custom value for a rejected edit, but not a deletion", () => {
    const path = "/global/custom.json"
    const previous = buildThemeCatalog(themePresets, [
      source(path, { name: "custom", extends: "nocturne", tokens: { accent: "#123456" } }),
    ])
    const invalid = buildThemeCatalog(themePresets, [
      { scope: "global", path, text: `{ "name": "custom", "tokens": }` },
    ])
    const retained = retainLastValidThemes(previous, invalid)

    expect(invalid.get("custom")).toBeUndefined()
    expect(retained.get("custom")?.tokens.accent).toBe("#123456")
    expect(retainLastValidThemes(previous, buildThemeCatalog(themePresets, [])).get("custom")).toBeUndefined()
  })
})
