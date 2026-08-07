import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { effectiveOperation, operationFingerprint, readOperation } from "./operation"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function gitDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "laziergit-operation-"))
  directories.push(directory)
  return directory
}

describe("operation detection", () => {
  it("detects merge, rebase, cherry-pick, and revert sentinels", async () => {
    const directory = await gitDir()
    await Promise.all([
      writeFile(join(directory, "MERGE_HEAD"), "merge\n"),
      mkdir(join(directory, "rebase-apply")),
      writeFile(join(directory, "CHERRY_PICK_HEAD"), "pick\n"),
      writeFile(join(directory, "REVERT_HEAD"), "revert\n"),
    ])

    expect(await readOperation(directory)).toEqual({
      merging: true,
      rebasing: true,
      cherryPicking: true,
      reverting: true,
      effective: "revert",
    })
  })

  it("does not mistake a stopped interactive-rebase pick for a nested cherry-pick", async () => {
    const directory = await gitDir()
    await mkdir(join(directory, "rebase-merge"))
    await Promise.all([
      writeFile(join(directory, "rebase-merge", "stopped-sha"), "abc123\n"),
      writeFile(join(directory, "CHERRY_PICK_HEAD"), "abc123\n"),
    ])
    expect(await readOperation(directory)).toMatchObject({ rebasing: true, cherryPicking: false, effective: "rebase" })

    await writeFile(join(directory, "CHERRY_PICK_HEAD"), "def456\n")
    expect(await readOperation(directory)).toMatchObject({
      rebasing: true,
      cherryPicking: true,
      effective: "cherryPick",
    })
  })

  it("uses stable effective priority and a compact poll fingerprint", () => {
    expect(effectiveOperation({ reverting: false, cherryPicking: true, merging: true, rebasing: true })).toBe(
      "cherryPick",
    )
    expect(
      operationFingerprint({
        reverting: false,
        cherryPicking: true,
        merging: false,
        rebasing: true,
        effective: "cherryPick",
      }),
    ).toBe("0110")
  })
})
