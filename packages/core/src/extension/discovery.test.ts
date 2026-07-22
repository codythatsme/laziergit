import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { discoverExtensions, extensionTreeFingerprint } from "./discovery"

const temporaryRoots: string[] = []

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "laziergit-discovery-"))
  temporaryRoots.push(root)
  return root
}

async function writeDirectoryExtension(root: string, name: string, main = "index.ts"): Promise<string> {
  const path = join(root, name)
  await mkdir(join(path, "src"), { recursive: true })
  await writeFile(join(path, "package.json"), JSON.stringify({ main }))
  const entryPath = join(path, main)
  await mkdir(join(entryPath, ".."), { recursive: true })
  await writeFile(entryPath, "export default {}")
  return path
}

function directoryLinkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir"
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("discoverExtensions", () => {
  it("returns deterministic candidates while isolating malformed siblings", async () => {
    const root = await createTemporaryRoot()
    await Promise.all([
      writeFile(join(root, "z.ts"), "export default {}"),
      writeFile(join(root, "a.ts"), "export default {}"),
      writeFile(join(root, "notes.txt"), "ignored"),
      writeFile(join(root, ".hidden.ts"), "ignored"),
      writeDirectoryExtension(root, "good", "src/main.ts"),
    ])

    await mkdir(join(root, "escape"))
    await writeFile(join(root, "escape", "package.json"), JSON.stringify({ main: "../outside.ts" }))
    await mkdir(join(root, "malformed"))
    await writeFile(join(root, "malformed", "package.json"), "{")
    await mkdir(join(root, "missing"))
    await writeFile(join(root, "missing", "package.json"), JSON.stringify({ main: "missing.ts" }))
    await mkdir(join(root, "excluded", "node_modules", "pkg"), { recursive: true })
    await writeFile(join(root, "excluded", "package.json"), JSON.stringify({ main: "node_modules/pkg/index.ts" }))
    await writeFile(join(root, "excluded", "node_modules", "pkg", "index.ts"), "export default {}")
    await mkdir(join(root, "node_modules"))
    await writeFile(join(root, "node_modules", "package.json"), JSON.stringify({ main: "index.ts" }))
    await writeFile(join(root, "node_modules", "index.ts"), "export default {}")

    const result = await discoverExtensions(root, "global")

    expect(result.candidates.map((candidate) => basename(candidate.rootPath))).toEqual(["a.ts", "good", "z.ts"])
    expect(result.failures.map((failure) => basename(failure.path))).toEqual([
      "escape",
      "excluded",
      "malformed",
      "missing",
    ])

    const good = result.candidates[1]
    expect(good?.entryPath).toBe(join(root, "good", "src", "main.ts"))
    expect(good?.sourceRootPath).toBe(await realpath(join(root, "good")))
    expect(good?.sourceEntryPath).toBe(await realpath(join(root, "good", "src", "main.ts")))
  })

  it("contains a root failure without affecting another root", async () => {
    const root = await createTemporaryRoot()
    const invalidRoot = join(root, "not-a-directory")
    const validRoot = join(root, "extensions")
    await writeFile(invalidRoot, "file")
    await mkdir(validRoot)
    await writeFile(join(validRoot, "survivor.ts"), "export default {}")

    const [failed, valid, missing] = await Promise.all([
      discoverExtensions(invalidRoot, "global"),
      discoverExtensions(validRoot, "repo"),
      discoverExtensions(join(root, "missing"), "global"),
    ])

    expect(failed.candidates).toEqual([])
    expect(failed.failures).toEqual([
      expect.objectContaining({ path: invalidRoot, rootPath: invalidRoot, scope: "global" }),
    ])
    expect(valid.candidates).toEqual([
      expect.objectContaining({ rootPath: join(validRoot, "survivor.ts"), scope: "repo" }),
    ])
    expect(valid.failures).toEqual([])
    expect(missing).toEqual({ candidates: [], failures: [] })
  })

  it("keeps linked identities logical and copy sources canonical", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    const sources = join(root, "sources")
    await Promise.all([mkdir(extensions), mkdir(sources)])

    const fileSource = join(sources, "file-source.ts")
    await writeFile(fileSource, "export default {}")
    await symlink(fileSource, join(extensions, "linked.ts"), "file")

    const directorySource = await writeDirectoryExtension(sources, "directory-source", "src/main.ts")
    await symlink(directorySource, join(extensions, "linked-directory"), directoryLinkType())

    await symlink(join(sources, "missing.ts"), join(extensions, "broken.ts"), "file")

    const outsideEntry = join(sources, "outside.ts")
    await writeFile(outsideEntry, "export default {}")
    const escapingRoot = join(extensions, "escaping")
    await mkdir(escapingRoot)
    await writeFile(join(escapingRoot, "package.json"), JSON.stringify({ main: "entry.ts" }))
    await symlink(outsideEntry, join(escapingRoot, "entry.ts"), "file")

    const result = await discoverExtensions(extensions, "repo")

    expect(result.candidates).toEqual([
      {
        entryPath: join(extensions, "linked-directory", "src", "main.ts"),
        rootPath: join(extensions, "linked-directory"),
        sourceEntryPath: await realpath(join(directorySource, "src", "main.ts")),
        sourceRootPath: await realpath(directorySource),
        scope: "repo",
      },
      {
        entryPath: join(extensions, "linked.ts"),
        rootPath: join(extensions, "linked.ts"),
        sourceEntryPath: await realpath(fileSource),
        sourceRootPath: await realpath(fileSource),
        scope: "repo",
      },
    ])
    expect(result.failures.map((failure) => basename(failure.path))).toEqual(["broken.ts", "escaping"])
  })
})

describe("extensionTreeFingerprint", () => {
  it("follows linked targets, notices retargets and repairs, and stops ancestry cycles", async () => {
    const root = await createTemporaryRoot()
    const extensions = join(root, "extensions")
    const sourceA = join(root, "source-a")
    const sourceB = join(root, "source-b")
    await Promise.all([mkdir(extensions), mkdir(sourceA), mkdir(sourceB)])
    await Promise.all([writeFile(join(sourceA, "value.ts"), "one"), writeFile(join(sourceB, "value.ts"), "one")])
    await symlink(sourceA, join(sourceA, "loop"), directoryLinkType())
    await Promise.all([
      symlink(sourceA, join(extensions, "left"), directoryLinkType()),
      symlink(sourceA, join(extensions, "right"), directoryLinkType()),
    ])

    const initial = await extensionTreeFingerprint([extensions])
    expect(initial).toContain(join(extensions, "left", "value.ts"))
    expect(initial).toContain(join(extensions, "right", "value.ts"))
    expect(initial).toContain(`cycle:${join(extensions, "left", "loop")}`)

    await writeFile(join(sourceA, "value.ts"), "one changed")
    const changedTarget = await extensionTreeFingerprint([extensions])
    expect(changedTarget).not.toBe(initial)

    await mkdir(join(sourceA, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(sourceA, "node_modules", "pkg", "ignored.ts"), "ignored")
    await mkdir(join(sourceA, ".laziergit-cache-100-1-1-ignored"))
    await writeFile(join(sourceA, ".laziergit-cache-100-1-1-ignored", "ignored.ts"), "ignored")
    expect(await extensionTreeFingerprint([extensions])).toBe(changedTarget)

    await unlink(join(extensions, "left"))
    await symlink(sourceB, join(extensions, "left"), directoryLinkType())
    const retargeted = await extensionTreeFingerprint([extensions])
    expect(retargeted).not.toBe(changedTarget)

    await rm(sourceB, { recursive: true })
    const broken = await extensionTreeFingerprint([extensions])
    expect(broken).not.toBe(retargeted)
    expect(broken).toContain(`broken-link:${join(extensions, "left")}`)

    await mkdir(sourceB)
    await writeFile(join(sourceB, "value.ts"), "repaired")
    const repaired = await extensionTreeFingerprint([extensions])
    expect(repaired).not.toBe(broken)
  })
})
