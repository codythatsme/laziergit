import * as fs from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { isPathInside } from "../path-containment"
import { errorCode, normalizeError } from "./diagnostics"
import { importCopyContainerName, importCopyIgnoreName, type ExtensionCandidate } from "./discovery"

export type ProcessState = "live" | "dead" | "unknown"
export type ProcessStateProbe = (pid: number) => ProcessState

export interface ImportCopyCacheDiagnostic {
  readonly phase: "cache"
  readonly message: string
  readonly error: Error
}

export interface ImportCopyCacheOptions {
  readonly directories: readonly string[]
  readonly diagnose?: (diagnostic: ImportCopyCacheDiagnostic) => void
  readonly processState?: ProcessStateProbe
  readonly platform?: NodeJS.Platform
}

export interface ImportCopyLease {
  readonly entryPath: string
  readonly rootPath: string
  release(): Promise<void>
}

/** `<pid>-<generation>-<timestamp>-<sequence>-<extension>`, inside the cache container. */
const CACHE_NAME = /^(\d+)-(\d+)-(\d+)-(.+)$/

/** `*` matches the ignore file too, so the container hides itself with no outside cooperation. */
const CONTAINER_IGNORE_CONTENT = "*\n"

function defaultProcessState(pid: number): ProcessState {
  if (pid === process.pid) return "live"
  try {
    process.kill(pid, 0)
    return "live"
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "dead" : "unknown"
  }
}

function cacheOwnerPid(name: string): number | undefined {
  const match = CACHE_NAME.exec(name)
  if (!match) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

export function directoryLinkType(platform: NodeJS.Platform): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir"
}

async function linkPath(sourcePath: string, targetPath: string, platform: NodeJS.Platform): Promise<void> {
  const metadata = await fs.stat(sourcePath)
  await fs.symlink(sourcePath, targetPath, metadata.isDirectory() ? directoryLinkType(platform) : "file")
}

async function linkDirectoryEntries(
  sourcePath: string,
  targetPath: string,
  omitted: ReadonlySet<string>,
  platform: NodeJS.Platform,
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(sourcePath, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw error
  }

  await fs.mkdir(targetPath, { recursive: true })
  await Promise.all(
    entries
      .filter((entry) => !omitted.has(entry.name))
      .map((entry) => linkPath(join(sourcePath, entry.name), join(targetPath, entry.name), platform)),
  )
}

/**
 * Where a package laziergit itself depends on sits on disk. Resolved through its
 * `package.json` rather than its entry point, because the two need not share a directory and
 * a types-only package has no entry at all.
 */
export function hostPackageRoot(specifier: string): string {
  return dirname(fileURLToPath(import.meta.resolve(`${specifier}/package.json`)))
}

async function createNodeModulesOverlay(
  copyRoot: string,
  sourceRoot: string | undefined,
  platform: NodeJS.Platform,
): Promise<void> {
  const overlayPath = join(copyRoot, "node_modules")
  if (sourceRoot) {
    const sourceNodeModulesPath = join(sourceRoot, "node_modules")
    await linkDirectoryEntries(sourceNodeModulesPath, overlayPath, new Set(["@opentui", "react"]), platform)
    await linkDirectoryEntries(
      join(sourceNodeModulesPath, "@opentui"),
      join(overlayPath, "@opentui"),
      new Set(["core", "react"]),
      platform,
    )
  }

  await fs.mkdir(join(overlayPath, "@opentui"), { recursive: true })
  await Promise.all([
    linkPath(hostPackageRoot("react"), join(overlayPath, "react"), platform),
    linkPath(hostPackageRoot("@opentui/react"), join(overlayPath, "@opentui", "react"), platform),
    linkPath(hostPackageRoot("@opentui/core"), join(overlayPath, "@opentui", "core"), platform),
  ])
}

class ImportCopyLeaseImplementation implements ImportCopyLease {
  #releasePromise: Promise<void> | undefined

  constructor(
    readonly entryPath: string,
    readonly rootPath: string,
    private readonly releaseLease: (lease: ImportCopyLeaseImplementation) => Promise<void>,
  ) {}

  release(): Promise<void> {
    this.#releasePromise ??= this.releaseLease(this)
    return this.#releasePromise
  }
}

/**
 * Owns generation-unique import copies. A lone-file Extension copies only that file, so
 * helpers and assets require directory form. Copies remain live until their lease is released.
 */
export class ImportCopyCache {
  readonly #directories: readonly string[]
  readonly #diagnose: ((diagnostic: ImportCopyCacheDiagnostic) => void) | undefined
  readonly #processState: ProcessStateProbe
  readonly #platform: NodeJS.Platform
  readonly #leases = new Set<ImportCopyLeaseImplementation>()
  readonly #ownedPaths = new Set<string>()
  readonly #cleanupInFlight = new Map<string, Promise<void>>()
  #sequence = 0

  constructor(options: ImportCopyCacheOptions) {
    this.#directories = options.directories
    this.#diagnose = options.diagnose
    this.#processState = options.processState ?? defaultProcessState
    this.#platform = options.platform ?? process.platform
  }

  get activeLeaseCount(): number {
    return this.#leases.size
  }

  async sweepStale(): Promise<void> {
    for (const directory of this.#directories) {
      const container = join(directory, importCopyContainerName)
      let entries
      try {
        entries = await fs.readdir(container, { withFileTypes: true })
      } catch (error) {
        if (errorCode(error) !== "ENOENT") this.#report(`Failed to scan import-copy cache root ${container}`, error)
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const pid = cacheOwnerPid(entry.name)
        if (pid === undefined || pid === process.pid) continue

        let state: ProcessState = "unknown"
        try {
          state = this.#processState(pid)
        } catch (error) {
          this.#report(`Failed to determine owner of import copy ${join(container, entry.name)}`, error)
        }
        if (state !== "dead") continue

        const path = join(container, entry.name)
        try {
          await fs.rm(path, { recursive: true })
        } catch (error) {
          this.#report(`Failed to remove stale import copy ${path}`, error)
        }
      }
    }
  }

  async acquire(candidate: ExtensionCandidate, generation: number): Promise<ImportCopyLease> {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError(`Import-copy generation must be a non-negative safe integer: ${generation}`)
    }

    const copyRoot = this.#copyRoot(candidate, generation)
    this.#ownedPaths.add(copyRoot)

    try {
      // The container is created on demand rather than at startup, so an Extension directory
      // nobody has loaded from stays exactly as its owner left it.
      const container = dirname(copyRoot)
      await fs.mkdir(container, { recursive: true })
      await this.#writeContainerIgnore(container)
      let entryPath: string
      if (candidate.rootPath === candidate.entryPath) {
        await fs.mkdir(copyRoot)
        entryPath = join(copyRoot, basename(candidate.sourceEntryPath))
        await fs.copyFile(candidate.sourceEntryPath, entryPath)
        await createNodeModulesOverlay(copyRoot, undefined, this.#platform)
      } else {
        const entryRelativePath = relative(candidate.sourceRootPath, candidate.sourceEntryPath)
        if (entryRelativePath === "" || !isPathInside(candidate.sourceRootPath, candidate.sourceEntryPath)) {
          throw new TypeError(`Directory extension entry must be inside ${candidate.sourceRootPath}`)
        }

        await fs.cp(candidate.sourceRootPath, copyRoot, {
          recursive: true,
          filter: (sourcePath) => {
            if (sourcePath === candidate.sourceRootPath) return true
            const name = basename(sourcePath)
            return name !== "node_modules" && !name.startsWith(importCopyContainerName)
          },
        })
        await createNodeModulesOverlay(copyRoot, candidate.sourceRootPath, this.#platform)
        entryPath = join(copyRoot, entryRelativePath)
      }

      const lease = new ImportCopyLeaseImplementation(entryPath, copyRoot, (current) => this.#release(current))
      this.#leases.add(lease)
      return lease
    } catch (error) {
      await this.#cleanupPath(copyRoot)
      throw error
    }
  }

  async releaseAll(): Promise<void> {
    const leases = [...this.#leases]
    const leasePaths = new Set(leases.map((lease) => lease.rootPath))
    await Promise.all(leases.map((lease) => lease.release()))

    const orphanedPaths = [...this.#ownedPaths].filter((path) => !leasePaths.has(path))
    await Promise.all(orphanedPaths.map((path) => this.#cleanupPath(path)))

    // Best-effort, and only while empty: another laziergit may still be holding copies in
    // the same container, and `rmdir` refusing a non-empty directory is how we ask.
    await Promise.all(
      this.#directories.map(async (directory) => {
        const container = join(directory, importCopyContainerName)
        try {
          // Dropped only once it is alone: while another laziergit still holds copies here,
          // those copies are what the ignore file is for.
          const entries = await fs.readdir(container)
          if (entries.length === 1 && entries[0] === importCopyIgnoreName) {
            await fs.rm(join(container, importCopyIgnoreName))
          }
          await fs.rmdir(container)
        } catch {
          // A container that is missing, in use, or unwritable is not an error to report.
        }
      }),
    )
  }

  /**
   * Inside the Extension directory's cache container, not beside the Extension: a package
   * manager globbing `extensions/*` would read a sibling copy as a second workspace of the
   * same name. One level deeper costs nothing — module resolution still walks up to the same
   * `node_modules`.
   */
  #copyRoot(candidate: ExtensionCandidate, generation: number): string {
    this.#sequence += 1
    const name = `${process.pid}-${generation}-${Date.now()}-${this.#sequence}-${basename(candidate.rootPath)}`
    return join(dirname(candidate.rootPath), importCopyContainerName, name)
  }

  /**
   * The container is written into somebody else's working tree, so without this laziergit's
   * scratch copies would surface as untracked files there — and discarding them would delete a
   * copy out from under a running Extension. Rewritten on every acquire, which is idempotent
   * and free of a stat-then-write race.
   */
  async #writeContainerIgnore(container: string): Promise<void> {
    try {
      await fs.writeFile(join(container, importCopyIgnoreName), CONTAINER_IGNORE_CONTENT)
    } catch (error) {
      // A visible container is untidy, not fatal: the copy it holds still imports.
      this.#report(`Failed to ignore import-copy cache root ${container}`, error)
    }
  }

  async #release(lease: ImportCopyLeaseImplementation): Promise<void> {
    this.#leases.delete(lease)
    await this.#cleanupPath(lease.rootPath)
  }

  #cleanupPath(path: string): Promise<void> {
    const current = this.#cleanupInFlight.get(path)
    if (current) return current

    const cleanup = (async () => {
      try {
        await fs.rm(path, { recursive: true, force: true })
        this.#ownedPaths.delete(path)
      } catch (error) {
        this.#report(`Failed to clean import copy ${path}`, error)
      } finally {
        this.#cleanupInFlight.delete(path)
      }
    })()
    this.#cleanupInFlight.set(path, cleanup)
    return cleanup
  }

  #report(message: string, error: unknown): void {
    if (!this.#diagnose) return
    try {
      this.#diagnose({ phase: "cache", message, error: normalizeError(error) })
    } catch {
      // Diagnostics must never replace an import or cleanup failure.
    }
  }
}
