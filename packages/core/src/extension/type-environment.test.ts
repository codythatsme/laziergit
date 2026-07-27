import { describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { publishTypeEnvironment, type TypeEnvironmentDiagnostic } from "./type-environment"

async function inTemporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "laziergit-authoring-"))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("publishTypeEnvironment", () => {
  /**
   * An editor that cannot resolve an import has no API to offer, and the failure is silent:
   * the published tsconfig sets `skipLibCheck`, so a package missing from this overlay
   * degrades the author's types to `any` without announcing itself. `effect` is the one this
   * test was written for, since `ctx.effect` is declared in terms of `Effect.Effect`.
   */
  it("links every package an Extension may import, including effect for ctx.effect", async () => {
    await inTemporaryDirectory(async (directory) => {
      const diagnostics: TypeEnvironmentDiagnostic[] = []
      await publishTypeEnvironment({ directories: [directory], diagnose: (d) => diagnostics.push(d) })

      expect(diagnostics).toEqual([])
      const overlay = join(directory, "node_modules")
      const linked = await readdir(overlay)

      for (const specifier of ["laziergit", "react", "effect"]) {
        expect(linked).toContain(specifier)
      }
      // Scoped packages land under their scope directory rather than as a flat name.
      expect(await readdir(join(overlay, "@opentui"))).toContain("react")
      expect(await readdir(join(overlay, "@types"))).toContain("bun")

      // Linked, not copied: the author types against the code that will actually run theirs.
      const surface = await readFile(join(overlay, "laziergit", "package.json"), "utf8")
      expect(JSON.parse(surface).name).toBe("laziergit")
    })
  })

  it("writes an authoring tsconfig without overwriting one the author already has", async () => {
    await inTemporaryDirectory(async (directory) => {
      await publishTypeEnvironment({ directories: [directory] })
      const written = JSON.parse(await readFile(join(directory, "tsconfig.json"), "utf8"))

      expect(written.compilerOptions.jsxImportSource).toBe("@opentui/react")
      expect(written.compilerOptions.strict).toBe(true)

      const mine = '{ "compilerOptions": { "strict": false } }\n'
      await writeFile(join(directory, "tsconfig.json"), mine)
      await publishTypeEnvironment({ directories: [directory] })

      expect(await readFile(join(directory, "tsconfig.json"), "utf8")).toBe(mine)
    })
  })
})
