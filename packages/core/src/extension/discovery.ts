import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type ExtensionSourceScope = "global" | "repo"

export interface ExtensionCandidate {
  readonly entryPath: string
  readonly rootPath: string
  readonly scope: ExtensionSourceScope
}

export interface ExtensionDirectories {
  readonly global: string
  readonly repo: string
}

export function defaultExtensionDirectories(repoRoot: string): ExtensionDirectories {
  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return {
    global: join(configRoot, "laziergit", "extensions"),
    repo: join(repoRoot, ".laziergit", "extensions"),
  }
}

function isExtensionFile(name: string): boolean {
  return !name.startsWith(".") && !name.endsWith(".d.ts") && (name.endsWith(".ts") || name.endsWith(".tsx"))
}

async function directoryEntry(path: string): Promise<string | undefined> {
  const manifestPath = join(path, "package.json")
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { main?: unknown }
    if (typeof manifest.main === "string") {
      return isAbsolute(manifest.main) ? manifest.main : resolve(dirname(manifestPath), manifest.main)
    }
  }

  const ts = join(path, "index.ts")
  if (existsSync(ts)) return ts
  const tsx = join(path, "index.tsx")
  if (existsSync(tsx)) return tsx
  return undefined
}

export async function discoverExtensions(
  directory: string,
  scope: ExtensionSourceScope,
): Promise<readonly ExtensionCandidate[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const candidates: ExtensionCandidate[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isFile() && isExtensionFile(entry.name)) {
      candidates.push({ entryPath: path, rootPath: path, scope })
      continue
    }
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue

    const entryPath = await directoryEntry(path)
    if (entryPath) candidates.push({ entryPath, rootPath: path, scope })
  }
  return candidates
}
