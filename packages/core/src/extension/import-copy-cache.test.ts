import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { discoverExtensions, importCopyContainerName, type ExtensionCandidate } from "./discovery"
import { ImportCopyCache, type ImportCopyCacheDiagnostic } from "./import-copy-cache"

const temporaryRoots: string[] = []

async function createTemporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "laziergit-import-copy-"))
  temporaryRoots.push(root)
  return root
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function candidateNamed(root: string, name: string): Promise<ExtensionCandidate> {
  const result = await discoverExtensions(root, "repo")
  const candidate = result.candidates.find((current) => basename(current.rootPath) === name)
  if (!candidate) throw new Error(`Missing candidate ${name}`)
  return candidate
}

async function writeDirectoryExtension(root: string, name: string): Promise<string> {
  const extensionRoot = join(root, name)
  await fs.mkdir(join(extensionRoot, "src"), { recursive: true })
  await fs.writeFile(join(extensionRoot, "package.json"), JSON.stringify({ main: "src/main.ts" }))
  await fs.writeFile(join(extensionRoot, "src", "main.ts"), 'import "./helper"')
  await fs.writeFile(join(extensionRoot, "src", "helper.ts"), "export const helper = 1")
  await fs.writeFile(join(extensionRoot, "asset.txt"), "asset")
  return extensionRoot
}

function hostPackageRoot(specifier: string): string {
  return dirname(fileURLToPath(import.meta.resolve(specifier)))
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("ImportCopyCache leases", () => {
  it("keeps lone-file copies self-contained and releases them idempotently", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    await fs.mkdir(extensions)
    await fs.writeFile(join(extensions, "lone.ts"), 'import "./helper"')
    await fs.writeFile(join(extensions, "helper.ts"), "export const helper = 1")

    const cache = new ImportCopyCache({ directories: [extensions] })
    const lease = await cache.acquire(await candidateNamed(extensions, "lone.ts"), 1)

    expect(cache.activeLeaseCount).toBe(1)
    // Inside the container, never beside the Extension: an Extension directory is somebody
    // else's tree, and `extensions/*` is a Bun workspace glob in this repository.
    expect(dirname(lease.rootPath)).toBe(join(extensions, importCopyContainerName))
    expect((await fs.readdir(lease.rootPath)).sort()).toEqual(["lone.ts", "node_modules"].sort())
    expect(await pathExists(join(lease.rootPath, "helper.ts"))).toBe(false)
    expect(await pathExists(lease.rootPath)).toBe(true)

    const release = lease.release()
    expect(lease.release()).toBe(release)
    await release

    expect(cache.activeLeaseCount).toBe(0)
    expect(await pathExists(lease.rootPath)).toBe(false)
    await cache.releaseAll()
  })

  it("copies directory helpers and assets while overlaying local and host dependencies", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    await fs.mkdir(extensions)
    const sourceRoot = await writeDirectoryExtension(extensions, "directory")
    await fs.mkdir(join(sourceRoot, "node_modules", "local-dependency"), { recursive: true })
    await fs.writeFile(join(sourceRoot, "node_modules", "local-dependency", "index.js"), "export default 1")
    await fs.mkdir(join(sourceRoot, "node_modules", "@opentui", "react"), { recursive: true })
    await fs.writeFile(join(sourceRoot, "node_modules", "@opentui", "react", "local-only"), "wrong runtime")

    const cache = new ImportCopyCache({ directories: [extensions] })
    const lease = await cache.acquire(await candidateNamed(extensions, "directory"), 3)

    expect(await fs.readFile(join(lease.rootPath, "src", "helper.ts"), "utf8")).toContain("helper")
    expect(await fs.readFile(join(lease.rootPath, "asset.txt"), "utf8")).toBe("asset")
    expect(await fs.realpath(join(lease.rootPath, "node_modules", "local-dependency"))).toBe(
      await fs.realpath(join(sourceRoot, "node_modules", "local-dependency")),
    )
    expect(await fs.realpath(join(lease.rootPath, "node_modules", "react"))).toBe(
      await fs.realpath(hostPackageRoot("react")),
    )
    expect(await fs.realpath(join(lease.rootPath, "node_modules", "@opentui", "react"))).toBe(
      await fs.realpath(hostPackageRoot("@opentui/react")),
    )
    expect(await fs.realpath(join(lease.rootPath, "node_modules", "@opentui", "core"))).toBe(
      await fs.realpath(hostPackageRoot("@opentui/core")),
    )

    await cache.releaseAll()
    expect(await pathExists(lease.rootPath)).toBe(false)
  })

  it("hides the container from the host repository's status for as long as it exists", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    await fs.mkdir(extensions)
    await fs.writeFile(join(extensions, "ignored.ts"), "export default {}")

    const diagnostics: ImportCopyCacheDiagnostic[] = []
    const cache = new ImportCopyCache({ directories: [extensions], diagnose: (entry) => diagnostics.push(entry) })
    const lease = await cache.acquire(await candidateNamed(extensions, "ignored.ts"), 1)

    // `*` ignores the ignore file too, so the container needs nothing from the repository.
    expect(await fs.readFile(join(extensions, importCopyContainerName, ".gitignore"), "utf8")).toBe("*\n")
    expect(diagnostics).toEqual([])

    await cache.releaseAll()
    expect(await pathExists(lease.rootPath)).toBe(false)
    expect(await fs.readdir(extensions)).toEqual(["ignored.ts"])
  })

  it("cleans each lease independently and retries paths whose cleanup failed", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    await fs.mkdir(extensions)
    await Promise.all([
      fs.writeFile(join(extensions, "first.ts"), "export default {}"),
      fs.writeFile(join(extensions, "second.ts"), "export default {}"),
    ])

    const diagnostics: ImportCopyCacheDiagnostic[] = []
    const cache = new ImportCopyCache({ directories: [extensions], diagnose: (entry) => diagnostics.push(entry) })
    const first = await cache.acquire(await candidateNamed(extensions, "first.ts"), 1)
    const second = await cache.acquire(await candidateNamed(extensions, "second.ts"), 1)
    const originalRemove = fs.rm
    let failed = false
    const removeSpy = spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (!failed && path === first.rootPath) {
        failed = true
        throw Object.assign(new Error("cleanup denied"), { code: "EPERM" })
      }
      await originalRemove(path, options)
    })

    await cache.releaseAll()
    removeSpy.mockRestore()

    expect(cache.activeLeaseCount).toBe(0)
    expect(await pathExists(first.rootPath)).toBe(true)
    expect(await pathExists(second.rootPath)).toBe(false)
    expect(diagnostics).toEqual([
      expect.objectContaining({ phase: "cache", message: `Failed to clean import copy ${first.rootPath}` }),
    ])

    await cache.releaseAll()
    expect(await pathExists(first.rootPath)).toBe(false)
  })

  it("preserves a primary copy error when partial cleanup also fails", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    await fs.mkdir(extensions)
    await fs.writeFile(join(extensions, "broken.ts"), "export default {}")

    const diagnostics: ImportCopyCacheDiagnostic[] = []
    const cache = new ImportCopyCache({ directories: [extensions], diagnose: (entry) => diagnostics.push(entry) })
    const primaryError = new Error("overlay failed")
    const cleanupError = new Error("cleanup failed")
    const symlinkSpy = spyOn(fs, "symlink").mockImplementation(async () => {
      throw primaryError
    })
    const removeSpy = spyOn(fs, "rm").mockImplementation(async () => {
      throw cleanupError
    })

    let copyError: unknown
    try {
      await cache.acquire(await candidateNamed(extensions, "broken.ts"), 2)
    } catch (error) {
      copyError = error
    } finally {
      symlinkSpy.mockRestore()
      removeSpy.mockRestore()
    }

    expect(copyError).toBe(primaryError)
    expect(cache.activeLeaseCount).toBe(0)
    expect(diagnostics).toEqual([expect.objectContaining({ phase: "cache", error: cleanupError })])
    await cache.releaseAll()
    // Nothing of laziergit's is left in the Extension directory — not the failed copy, and
    // not the container it was written into.
    expect(await fs.readdir(extensions)).toEqual(["broken.ts"])
  })

  it("uses junctions for every directory overlay on Windows", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    await fs.mkdir(extensions)
    const sourceRoot = await writeDirectoryExtension(extensions, "windows-links")
    await fs.mkdir(join(sourceRoot, "node_modules", "local-dependency"), { recursive: true })

    const linkCalls: { readonly target: string; readonly type: string | null | undefined }[] = []
    const originalSymlink = fs.symlink
    const symlinkSpy = spyOn(fs, "symlink").mockImplementation(async (target, path, type) => {
      linkCalls.push({ target: String(target), type })
      await originalSymlink(target, path, type === "junction" && process.platform !== "win32" ? "dir" : type)
    })

    const cache = new ImportCopyCache({ directories: [extensions], platform: "win32" })
    const lease = await cache.acquire(await candidateNamed(extensions, "windows-links"), 1)
    symlinkSpy.mockRestore()

    expect(linkCalls.length).toBeGreaterThanOrEqual(4)
    expect(linkCalls.every((call) => call.type === "junction")).toBe(true)
    expect(linkCalls.every((call) => isAbsolute(call.target))).toBe(true)
    await lease.release()
  })
})

describe("ImportCopyCache startup sweep", () => {
  it("deletes only recognized directories whose embedded PID is confirmed dead", async () => {
    const root = await createTemporaryRoot()
    const container = join(root, importCopyContainerName)
    await fs.mkdir(container)
    const names = {
      dead: "410001-1-1000-dead",
      live: "410002-1-1000-live",
      uncertain: "410003-1-1000-uncertain",
      eperm: "410004-1-1000-eperm",
      current: `${process.pid}-1-1000-current`,
      malformed: "not-a-pid-1-1000-malformed",
    }
    await Promise.all(Object.values(names).map((name) => fs.mkdir(join(container, name))))
    const recognizedFile = "410001-1-1000-file"
    await fs.writeFile(join(container, recognizedFile), "keep")

    const cache = new ImportCopyCache({
      directories: [root],
      processState: (pid) => {
        if (pid === 410001) return "dead"
        if (pid === 410002) return "live"
        return "unknown"
      },
    })
    await cache.sweepStale()

    expect((await fs.readdir(container)).sort()).toEqual(
      [names.live, names.uncertain, names.eperm, names.current, names.malformed, recognizedFile].sort(),
    )
  })
})
