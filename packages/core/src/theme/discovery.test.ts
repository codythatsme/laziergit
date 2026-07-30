import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { themePresets } from "../extension/theme"
import { defaultThemeDirectory, discoverThemeDocuments, loadThemeCatalog, themeFilesFingerprint } from "./discovery"

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "laziergit-themes-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("theme discovery", () => {
  it("reads visible JSON files in name order and contains sibling failures", async () => {
    const root = await temporaryRoot()
    await Promise.all([
      writeFile(join(root, "z.json"), "{}"),
      writeFile(join(root, "a.json"), "{}"),
      writeFile(join(root, "notes.txt"), "ignored"),
      writeFile(join(root, ".hidden.json"), "ignored"),
      mkdir(join(root, "directory.json")),
    ])

    const discovered = await discoverThemeDocuments(root)

    expect(discovered.sources.map((entry) => entry.path)).toEqual([join(root, "a.json"), join(root, "z.json")])
    expect(discovered.diagnostics).toEqual([
      expect.objectContaining({ code: "read-failed", path: join(root, "directory.json") }),
    ])
  })

  it("treats a missing directory as an empty scope", async () => {
    const root = await temporaryRoot()
    expect(await discoverThemeDocuments(join(root, "missing"))).toEqual({
      sources: [],
      diagnostics: [],
    })
  })

  it("loads global definitions into the catalog", async () => {
    const root = await temporaryRoot()
    const global = join(root, "global")
    await mkdir(global)
    await writeFile(
      join(global, "custom.json"),
      JSON.stringify({ name: "custom", extends: "nocturne", tokens: { accent: "#111111" } }),
    )

    const catalog = await loadThemeCatalog({ presets: themePresets, directory: global })

    expect(catalog.get("custom")).toEqual(
      expect.objectContaining({ scope: "global", tokens: expect.objectContaining({ accent: "#111111" }) }),
    )
  })

  it("fingerprints file contents", async () => {
    const root = await temporaryRoot()
    const global = join(root, "global")
    await mkdir(global)
    const path = join(global, "theme.json")
    await writeFile(path, "one")
    const before = await themeFilesFingerprint(global)
    await writeFile(path, "two")
    expect(await themeFilesFingerprint(global)).not.toBe(before)
  })
})

describe("defaultThemeDirectory", () => {
  it("uses the XDG config root", () => {
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = "/config"
    try {
      expect(defaultThemeDirectory()).toBe(join("/config", "laziergit", "themes"))
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })
})
