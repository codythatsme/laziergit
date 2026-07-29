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

export const themeDirectoryScopes = ["global", "repo"] as const

export type ThemeDirectoryScope = (typeof themeDirectoryScopes)[number]
export type ThemeDirectories = { readonly [Scope in ThemeDirectoryScope]: string }

export interface ThemeDiscoveryResult {
  readonly sources: readonly ThemeDocumentSource[]
  readonly diagnostics: readonly ThemeDiagnostic[]
}

export function defaultThemeDirectories(repoRoot: string): ThemeDirectories {
  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return {
    global: join(configRoot, "laziergit", "themes"),
    repo: join(repoRoot, ".laziergit", "themes"),
  }
}

function compareNames(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function readFailure(path: string, scope: ThemeDirectoryScope, error: unknown): ThemeDiagnostic {
  return {
    severity: "error",
    code: "read-failed",
    message: `Could not read theme file: ${normalizeError(error).message}`,
    scope,
    path,
  }
}

export async function discoverThemeDocuments(
  directory: string,
  scope: ThemeDirectoryScope,
): Promise<ThemeDiscoveryResult> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { sources: [], diagnostics: [] }
    return { sources: [], diagnostics: [readFailure(directory, scope, error)] }
  }

  const sources: ThemeDocumentSource[] = []
  const diagnostics: ThemeDiagnostic[] = []
  for (const entry of entries.sort(compareNames)) {
    if (entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue
    const path = join(directory, entry.name)
    try {
      const text = await readFile(path, "utf8")
      sources.push({ scope, path, text })
    } catch (error) {
      diagnostics.push(readFailure(path, scope, error))
    }
  }
  return { sources, diagnostics }
}

export interface LoadThemeCatalogOptions {
  readonly presets: readonly ThemePresetInput[]
  readonly directories: ThemeDirectories
}

export async function loadThemeCatalog(options: LoadThemeCatalogOptions): Promise<ThemeCatalog> {
  const discovered = await Promise.all(
    themeDirectoryScopes.map((scope) => discoverThemeDocuments(options.directories[scope], scope)),
  )
  return buildThemeCatalog(
    options.presets,
    discovered.flatMap((result) => result.sources),
    discovered.flatMap((result) => result.diagnostics),
  )
}

/**
 * Hashes the logical files and their contents so a watcher notices same-size edits and
 * same-name replacements without depending on filesystem timestamp precision.
 */
export async function themeFilesFingerprint(directories: ThemeDirectories): Promise<string> {
  const discovered = await Promise.all(
    themeDirectoryScopes.map((scope) => discoverThemeDocuments(directories[scope], scope)),
  )
  const hash = createHash("sha256")
  for (const result of discovered) {
    for (const source of result.sources) {
      hash.update(source.scope)
      hash.update("\0")
      hash.update(source.path)
      hash.update("\0")
      hash.update(source.text)
      hash.update("\0")
    }
    for (const entry of result.diagnostics) {
      hash.update(entry.scope)
      hash.update("\0")
      hash.update(entry.path)
      hash.update("\0")
      hash.update(entry.code)
      hash.update("\0")
      hash.update(entry.message)
      hash.update("\0")
    }
  }
  return hash.digest("hex")
}
