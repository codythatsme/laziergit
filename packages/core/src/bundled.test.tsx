import { describe, expect, it } from "bun:test"
import { symlink } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createHarness, installHarnessLifecycle } from "./test-harness"

installHarnessLifecycle()

/** The same directory `main.tsx` hands the kernel as the bundled scope. */
const bundledExtensionDirectory = resolve(import.meta.dir, "..", "..", "..", "extensions")

/** The roster, in the order PLAN.md builds them. */
const bundledExtensions = ["status", "files", "branches", "commits", "stash", "diff", "commit-flow", "sync"] as const

/** Every bundled Extension that owns a Pane, and where its hint asks to be placed. */
const bundledPanes = {
  status: { column: 0, order: 10 },
  files: { column: 0, order: 20 },
  branches: { column: 0, order: 30 },
  commits: { column: 0, order: 40 },
  stash: { column: 0, order: 50 },
  diff: { column: 1, order: 10 },
  "commit-flow": { column: 1, order: 20, tabWith: "diff" },
} as const

/**
 * Loads the real `extensions/` directory rather than a copy: symlinking each Extension into
 * the harness's bundled scope is the only way to exercise the shipped files themselves —
 * their real `package.json` main resolution, their real imports — while keeping the
 * generation-unique import copies inside the harness's temp directory, where they are cleaned
 * up with it. (Discovery keeps the logical linked path and follows the canonical target, §0.)
 */
async function linkBundledExtensions(bundled: string): Promise<void> {
  await Promise.all(
    bundledExtensions.map((name) => symlink(join(bundledExtensionDirectory, name), join(bundled, name))),
  )
}

describe("bundled extensions", () => {
  it("all eight load and activate from the bundled scope", async () => {
    const harness = await createHarness({ git: true })
    await linkBundledExtensions(harness.bundled)

    await harness.kernel.start()

    const snapshot = harness.kernel.getSnapshot()
    // Sets, because discovery order is the filesystem's business, not the roster's.
    expect(new Set(snapshot.map((entry) => entry.name))).toEqual(new Set(bundledExtensions))
    // Named individually rather than counted, so a failure says which one broke and why.
    for (const entry of snapshot)
      expect([entry.name, entry.state, entry.message]).toEqual([entry.name, "active", undefined])
    expect(snapshot.every((entry) => entry.scope === "bundled")).toBe(true)
  })

  it("registers every pane on the roster with its placement hint", async () => {
    const harness = await createHarness({ git: true })
    await linkBundledExtensions(harness.bundled)

    await harness.kernel.start()

    const panes = harness.kernel.panes.getSnapshot()
    expect(Object.fromEntries(panes.map((pane) => [pane.id, pane.placement]))).toEqual(bundledPanes)
  })
})
