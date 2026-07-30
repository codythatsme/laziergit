import { afterEach, expect, it } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJsonc } from "./jsonc"
import { setThemeSelection, writeThemeSelection } from "./theme-config-writer"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "laziergit-theme-config-"))
  temporaryDirectories.push(directory)
  return directory
}

it("preserves comments, trailing commas, and unrelated formatting", () => {
  const source = `{
  // Keep the selected theme near its token overrides.
  "theme": {
    "preset": "nocturne", // previewed in the picker
    "accent": "#aabbcc",
  },
  "git": { "commitLimit": 100, },
}
`

  expect(setThemeSelection(source, "daybreak")).toBe(source.replace('"nocturne"', '"daybreak"'))
})

it("adds a theme section to an existing JSONC document without disturbing its comments", () => {
  const source = `{
\t// Keep unrelated settings.
\t"git": {
\t\t"commitLimit": 100,
\t},
}
`
  const updated = setThemeSelection(source, "ember")

  expect(updated).toContain("// Keep unrelated settings.")
  expect(updated).toContain('"commitLimit": 100,')
  expect(updated).toContain('\n\t"theme": {')
  expect(parseJsonc(updated)).toEqual({
    git: { commitLimit: 100 },
    theme: { preset: "ember" },
  })
})

it("creates parent directories and atomically writes an automatic light/dark selection", async () => {
  const root = await temporaryDirectory()
  const path = join(root, "config", "config.jsonc")

  await writeThemeSelection(path, { dark: "nocturne", light: "daybreak" })

  const text = await readFile(path, "utf8")
  expect(parseJsonc(text)).toEqual({
    theme: { preset: { dark: "nocturne", light: "daybreak" } },
  })
  expect(await readdir(join(root, "config"))).toEqual(["config.jsonc"])
})

it("leaves a malformed config untouched", async () => {
  const root = await temporaryDirectory()
  const path = join(root, "config.jsonc")
  const malformed = `{ "theme": }`
  await writeFile(path, malformed)

  let rejection: unknown
  try {
    await writeThemeSelection(path, "daybreak")
  } catch (error) {
    rejection = error
  }

  expect(String(rejection)).toContain("where a value was expected")
  expect(await readFile(path, "utf8")).toBe(malformed)
  expect(await readdir(root)).toEqual(["config.jsonc"])
})
