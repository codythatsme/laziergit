import { constants, type Dirent, type Stats } from "node:fs"
import { access, lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"

export type ExtensionSourceScope = "global" | "repo"

export interface ExtensionCandidate {
  /** Logical path inside the configured extension directory, used for identity and status. */
  readonly entryPath: string
  /** Logical top-level file or directory inside the configured extension directory. */
  readonly rootPath: string
  /** Canonical entry point used as the import-copy source. */
  readonly sourceEntryPath: string
  /** Canonical file or directory used as the import-copy source. */
  readonly sourceRootPath: string
  readonly scope: ExtensionSourceScope
}

export interface ExtensionDiscoveryFailure {
  /** Logical root or top-level entry that failed discovery. */
  readonly path: string
  readonly rootPath: string
  readonly scope: ExtensionSourceScope
  readonly error: Error
}

export interface ExtensionDiscoveryResult {
  readonly candidates: readonly ExtensionCandidate[]
  readonly failures: readonly ExtensionDiscoveryFailure[]
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

function compareNames(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  return new Error(String(error))
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === "string" ? code : undefined
}

function isExtensionFile(name: string): boolean {
  return !name.startsWith(".") && !name.endsWith(".d.ts") && (name.endsWith(".ts") || name.endsWith(".tsx"))
}

function isExcludedTreeEntry(name: string): boolean {
  return name === "node_modules" || name.startsWith(".laziergit-cache-")
}

function isPathInside(rootPath: string, childPath: string): boolean {
  const childRelativePath = relative(rootPath, childPath)
  return (
    childRelativePath === "" ||
    (!isAbsolute(childRelativePath) && childRelativePath !== ".." && !childRelativePath.startsWith(`..${sep}`))
  )
}

function crossesExcludedTreeEntry(rootPath: string, childPath: string): boolean {
  return relative(rootPath, childPath).split(sep).some(isExcludedTreeEntry)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

function manifestEntryPath(rootPath: string, main: string): string {
  if (main.length === 0 || main.includes("\0") || isAbsolute(main)) {
    throw new TypeError(`Directory extension main must be a non-empty relative path: ${rootPath}`)
  }

  const entryPath = resolve(rootPath, main)
  if (!isPathInside(rootPath, entryPath)) {
    throw new TypeError(`Directory extension entry must be inside ${rootPath}`)
  }
  return entryPath
}

async function resolveDirectoryEntry(rootPath: string): Promise<string | undefined> {
  const manifestPath = join(rootPath, "package.json")
  const hasManifest = await pathExists(manifestPath)
  let manifestMain: string | undefined

  if (hasManifest) {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`Extension manifest must contain a JSON object: ${manifestPath}`)
    }
    if ("main" in parsed) {
      const main = (parsed as { readonly main?: unknown }).main
      if (typeof main !== "string") {
        throw new TypeError(`Extension manifest main must be a string: ${manifestPath}`)
      }
      manifestMain = main
    }
  }

  if (manifestMain !== undefined) return manifestEntryPath(rootPath, manifestMain)

  const tsEntry = join(rootPath, "index.ts")
  if (await pathExists(tsEntry)) return tsEntry
  const tsxEntry = join(rootPath, "index.tsx")
  if (await pathExists(tsxEntry)) return tsxEntry

  if (hasManifest) throw new TypeError(`Directory extension has no entry point: ${rootPath}`)
  return undefined
}

async function directoryCandidate(
  rootPath: string,
  scope: ExtensionSourceScope,
): Promise<ExtensionCandidate | undefined> {
  const sourceRootPath = await realpath(rootPath)
  const rootMetadata = await stat(sourceRootPath)
  if (!rootMetadata.isDirectory()) throw new TypeError(`Extension root is not a directory: ${rootPath}`)

  const entryPath = await resolveDirectoryEntry(rootPath)
  if (!entryPath) return undefined
  if (crossesExcludedTreeEntry(rootPath, entryPath)) {
    throw new TypeError(`Directory extension entry cannot be inside an excluded path: ${entryPath}`)
  }
  if (!isExtensionFile(basename(entryPath))) {
    throw new TypeError(`Extension entry must be a .ts or .tsx file: ${entryPath}`)
  }

  const sourceEntryPath = await realpath(entryPath)
  if (!isPathInside(sourceRootPath, sourceEntryPath)) {
    throw new TypeError(`Directory extension entry must stay inside ${rootPath}`)
  }

  const entryMetadata = await stat(sourceEntryPath)
  if (!entryMetadata.isFile()) throw new TypeError(`Extension entry is not a file: ${entryPath}`)
  await access(sourceEntryPath, constants.R_OK)

  return { entryPath, rootPath, sourceEntryPath, sourceRootPath, scope }
}

async function fileCandidate(entryPath: string, scope: ExtensionSourceScope): Promise<ExtensionCandidate> {
  const sourceEntryPath = await realpath(entryPath)
  const metadata = await stat(sourceEntryPath)
  if (!metadata.isFile()) throw new TypeError(`Extension entry is not a file: ${entryPath}`)
  await access(sourceEntryPath, constants.R_OK)
  return {
    entryPath,
    rootPath: entryPath,
    sourceEntryPath,
    sourceRootPath: sourceEntryPath,
    scope,
  }
}

async function linkedCandidate(
  path: string,
  name: string,
  scope: ExtensionSourceScope,
): Promise<ExtensionCandidate | undefined> {
  const sourcePath = await realpath(path)
  const metadata = await stat(sourcePath)
  if (metadata.isDirectory()) return directoryCandidate(path, scope)
  if (metadata.isFile()) return isExtensionFile(name) ? fileCandidate(path, scope) : undefined
  throw new TypeError(`Extension link target is not a file or directory: ${path}`)
}

export async function discoverExtensions(
  directory: string,
  scope: ExtensionSourceScope,
): Promise<ExtensionDiscoveryResult> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { candidates: [], failures: [] }
    return {
      candidates: [],
      failures: [{ path: directory, rootPath: directory, scope, error: normalizeError(error) }],
    }
  }

  const candidates: ExtensionCandidate[] = []
  const failures: ExtensionDiscoveryFailure[] = []

  for (const entry of entries.sort(compareNames)) {
    if (entry.name.startsWith(".") || isExcludedTreeEntry(entry.name)) continue
    const path = join(directory, entry.name)

    try {
      let candidate: ExtensionCandidate | undefined
      if (entry.isSymbolicLink()) candidate = await linkedCandidate(path, entry.name, scope)
      else if (entry.isFile() && isExtensionFile(entry.name)) candidate = await fileCandidate(path, scope)
      else if (entry.isDirectory()) candidate = await directoryCandidate(path, scope)
      else if (isExtensionFile(entry.name)) throw new TypeError(`Extension entry is not a regular file: ${path}`)

      if (candidate) candidates.push(candidate)
    } catch (error) {
      failures.push({ path, rootPath: path, scope, error: normalizeError(error) })
    }
  }

  return { candidates, failures }
}

function metadataFingerprint(metadata: Stats): string {
  return `${metadata.mode}:${metadata.size}:${metadata.mtimeMs}`
}

function fingerprintError(error: unknown): string {
  return errorCode(error) ?? normalizeError(error).name
}

async function fingerprintDirectory(
  path: string,
  canonicalPath: string,
  ancestry: ReadonlySet<string>,
  output: string[],
): Promise<void> {
  if (ancestry.has(canonicalPath)) {
    output.push(`cycle:${path}:${canonicalPath}`)
    return
  }

  output.push(`directory:${path}:${canonicalPath}`)
  const nextAncestry = new Set(ancestry)
  nextAncestry.add(canonicalPath)

  let children: Dirent[]
  try {
    children = await readdir(path, { withFileTypes: true })
  } catch (error) {
    output.push(`directory-error:${path}:${fingerprintError(error)}`)
    return
  }

  for (const child of children.sort(compareNames)) {
    if (isExcludedTreeEntry(child.name)) continue
    await fingerprintPath(join(path, child.name), nextAncestry, output)
  }
}

async function fingerprintPath(path: string, ancestry: ReadonlySet<string>, output: string[]): Promise<void> {
  let metadata: Stats
  try {
    metadata = await lstat(path)
  } catch (error) {
    output.push(`path-error:${path}:${fingerprintError(error)}`)
    return
  }

  if (metadata.isSymbolicLink()) {
    let target: string
    try {
      target = await readlink(path)
    } catch (error) {
      output.push(`link-error:${path}:${fingerprintError(error)}`)
      return
    }
    output.push(`link:${path}:${target}:${metadataFingerprint(metadata)}`)

    let canonicalPath: string
    let targetMetadata: Stats
    try {
      canonicalPath = await realpath(path)
      targetMetadata = await stat(path)
    } catch (error) {
      output.push(`broken-link:${path}:${fingerprintError(error)}`)
      return
    }

    if (targetMetadata.isDirectory()) {
      await fingerprintDirectory(path, canonicalPath, ancestry, output)
    } else {
      output.push(`link-target:${path}:${canonicalPath}:${metadataFingerprint(targetMetadata)}`)
    }
    return
  }

  if (metadata.isDirectory()) {
    let canonicalPath: string
    try {
      canonicalPath = await realpath(path)
    } catch (error) {
      output.push(`directory-realpath-error:${path}:${fingerprintError(error)}`)
      return
    }
    await fingerprintDirectory(path, canonicalPath, ancestry, output)
    return
  }

  output.push(`entry:${path}:${metadataFingerprint(metadata)}`)
}

/**
 * Fingerprints logical extension trees while following linked targets. Broken links and
 * unreadable roots are represented in the result so repairing them triggers a reload.
 */
export async function extensionTreeFingerprint(directories: readonly string[]): Promise<string> {
  const output: string[] = []
  for (const directory of directories) await fingerprintPath(directory, new Set(), output)
  return output.join("\n")
}
