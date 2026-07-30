import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { errorCode, normalizeError } from "../extension/diagnostics"
import {
  buildThemeCatalog,
  type ThemeCatalog,
  type ThemeDiagnostic,
  type ThemeDocumentSource,
  type ThemePresetInput,
} from "./catalog"

export interface ThemeDiscoveryResult {
  readonly sources: readonly ThemeDocumentSource[]
  readonly diagnostics: readonly ThemeDiagnostic[]
}

export function defaultThemeDirectory(): string {
  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(configRoot, "laziergit", "themes")
}

function compareNames(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function readFailure(path: string, error: unknown): ThemeDiagnostic {
  return {
    severity: "error",
    code: "read-failed",
    message: `Could not read theme file: ${normalizeError(error).message}`,
    scope: "global",
    path,
  }
}

export async function discoverThemeDocuments(directory: string): Promise<ThemeDiscoveryResult> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { sources: [], diagnostics: [] }
    return { sources: [], diagnostics: [readFailure(directory, error)] }
  }

  const sources: ThemeDocumentSource[] = []
  const diagnostics: ThemeDiagnostic[] = []
  for (const entry of entries.sort(compareNames)) {
    if (entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue
    const path = join(directory, entry.name)
    try {
      const text = await readFile(path, "utf8")
      sources.push({ scope: "global", path, text })
    } catch (error) {
      diagnostics.push(readFailure(path, error))
    }
  }
  return { sources, diagnostics }
}

export interface LoadThemeCatalogOptions {
  readonly presets: readonly ThemePresetInput[]
  readonly directory: string
}

export async function loadThemeCatalog(options: LoadThemeCatalogOptions): Promise<ThemeCatalog> {
  const discovered = await discoverThemeDocuments(options.directory)
  return buildThemeCatalog(options.presets, discovered.sources, discovered.diagnostics)
}

/**
 * Hashes the logical files and their contents so a watcher notices same-size edits and
 * same-name replacements without depending on filesystem timestamp precision.
 */
export async function themeFilesFingerprint(directory: string): Promise<string> {
  const discovered = await discoverThemeDocuments(directory)
  const hash = createHash("sha256")
  for (const source of discovered.sources) {
    hash.update(source.path)
    hash.update("\0")
    hash.update(source.text)
    hash.update("\0")
  }
  for (const entry of discovered.diagnostics) {
    hash.update(entry.path)
    hash.update("\0")
    hash.update(entry.code)
    hash.update("\0")
    hash.update(entry.message)
    hash.update("\0")
  }
  return hash.digest("hex")
}
