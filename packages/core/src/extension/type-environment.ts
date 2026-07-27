import type { Stats } from "node:fs"
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { errorCode, normalizeError } from "./diagnostics"
import { importCopyContainerName } from "./discovery"
import { directoryLinkType, hostPackageRoot } from "./import-copy-cache"

export interface TypeEnvironmentDiagnostic {
  /** The file or link that could not be published; the reason it exists is in its path. */
  readonly path: string
  readonly error: Error
}

export interface TypeEnvironmentOptions {
  /** User-writable Extension directories only — the bundled one is laziergit's own install tree. */
  readonly directories: readonly string[]
  readonly diagnose?: (diagnostic: TypeEnvironmentDiagnostic) => void
  readonly platform?: NodeJS.Platform
}

/**
 * Everything an Extension may import, plus the type packages those imports need but do not
 * carry: `react` ships no declarations of its own, and `types: ["bun"]` below is a demand for
 * `@types/bun` by name. Resolved out of laziergit's own installation, so the author typechecks
 * against the exact code that will run their Extension rather than a version they installed.
 *
 * `effect` is here for one reason: `ctx.effect` (§1.12) is declared in terms of `Effect.Effect`
 * and `Stream.Stream`, and those names have to resolve somewhere for the door to be usable.
 * Without it the escape hatch typechecks only because the authoring tsconfig sets
 * `skipLibCheck`, which hides the unresolved import inside laziergit's own declarations and
 * then hands the author `any` — so the one surface the spec calls version-coupled was the one
 * surface with no types at all. It is the `effect` laziergit itself runs, which is what
 * ADR-0002's peer dependency means: an author writing against this door is pinned to the same
 * beta core is, deliberately.
 */
const AUTHORING_PACKAGES = ["laziergit", "react", "@opentui/react", "@types/react", "@types/bun", "effect"] as const

const TSCONFIG_NAME = "tsconfig.json"

/**
 * The authoring half of the promise that Extensions are learnable from their types: an editor
 * that opens a file in this directory reads these options and checks it the way the workspace
 * does. Mirrored from tsconfig.base.json rather than read out of it because only the options
 * that describe the language travel — a workspace-relative `paths` or `references` added there
 * later would be meaningless, or actively wrong, in somebody's config directory.
 */
const AUTHORING_TSCONFIG = {
  $schema: "https://json.schemastore.org/tsconfig",
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ESNext", "DOM"],
    jsx: "react-jsx",
    jsxImportSource: "@opentui/react",
    strict: true,
    noUncheckedIndexedAccess: true,
    // An Extension is transpiled a file at a time with no type information available, so an
    // import that carries only types has to say so — this turns what would be a runtime
    // failure on activation into an error the author sees while typing.
    verbatimModuleSyntax: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["bun"],
  },
  include: ["."],
  // Naming `exclude` at all replaces TypeScript's default of `node_modules`, so it is restated
  // here — next to the import copies, which are the same sources under a second path and would
  // otherwise be reported twice.
  exclude: ["node_modules", importCopyContainerName],
}

const OVERLAY_NAME = "node_modules"

/**
 * The overlay is written into somebody else's working tree — most repositories reach here
 * through their own `.laziergit/extensions` — and links into laziergit's install, which is
 * nothing that tree could usefully track. `*` matches the ignore file too, so the overlay
 * hides itself with no cooperation from the repository around it.
 */
const OVERLAY_IGNORE_NAME = ".gitignore"
const OVERLAY_IGNORE_CONTENT = "*\n"

type Report = (path: string, error: unknown) => void

async function pathMetadata(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

async function writeAuthoringTsconfig(directory: string, report: Report): Promise<void> {
  const path = join(directory, TSCONFIG_NAME)
  try {
    // `wx` rather than a stat first: an author who has customised their own tsconfig keeps it,
    // and one syscall cannot lose the race two laziergits starting at once would otherwise run.
    // Never rewriting also keeps the file out of the reload fingerprint's way, which reads
    // mtimes and would see a fresh write as an edit worth reloading every Extension for.
    await writeFile(path, `${JSON.stringify(AUTHORING_TSCONFIG, null, 2)}\n`, { flag: "wx" })
  } catch (error) {
    if (errorCode(error) === "EEXIST") return
    report(path, error)
  }
}

async function linkAuthoringPackage(overlayPath: string, specifier: string, platform: NodeJS.Platform): Promise<void> {
  const targetPath = join(overlayPath, ...specifier.split("/"))
  const existing = await pathMetadata(targetPath)
  // A real directory here is one the author installed themselves, and theirs to keep. Only our
  // own links are replaced, and they are replaced every start because laziergit moving on disk
  // is what turns a working overlay into a directory of dangling links.
  if (existing && !existing.isSymbolicLink()) return

  const sourcePath = hostPackageRoot(specifier)
  await mkdir(dirname(targetPath), { recursive: true })
  if (existing) await rm(targetPath)
  await symlink(sourcePath, targetPath, directoryLinkType(platform))
}

async function publishOverlay(directory: string, platform: NodeJS.Platform, report: Report): Promise<void> {
  const overlayPath = join(directory, OVERLAY_NAME)
  try {
    await mkdir(overlayPath, { recursive: true })
  } catch (error) {
    // Nothing below can resolve without the directory, so this one failure is the whole overlay.
    report(overlayPath, error)
    return
  }

  const ignorePath = join(overlayPath, OVERLAY_IGNORE_NAME)
  try {
    await writeFile(ignorePath, OVERLAY_IGNORE_CONTENT)
  } catch (error) {
    // A visible overlay is untidy, not broken: the imports it exists for still resolve.
    report(ignorePath, error)
  }

  await Promise.all(
    // Independently, because a package missing from this installation costs the author that
    // package's types rather than every package's.
    AUTHORING_PACKAGES.map(async (specifier) => {
      try {
        await linkAuthoringPackage(overlayPath, specifier, platform)
      } catch (error) {
        report(join(overlayPath, specifier), error)
      }
    }),
  )
}

/**
 * Publishes the environment an Extension author's editor needs into each Extension directory: a
 * `tsconfig.json` holding the compiler options the workspace itself uses, and a `node_modules`
 * overlay linking the packages an Extension may import. Without it "ask an agent for a Pane and
 * drop the file in" produces a file whose every import is unresolved — the types are the API,
 * so an editor that cannot find them has no API to offer.
 *
 * Every failure is reported and skipped: the type environment is for writing Extensions, and
 * nothing about loading the ones already written depends on it.
 */
export async function publishTypeEnvironment(options: TypeEnvironmentOptions): Promise<void> {
  const platform = options.platform ?? process.platform
  const diagnose = options.diagnose
  const report: Report = (path, error) => {
    if (!diagnose) return
    try {
      diagnose({ path, error: normalizeError(error) })
    } catch {
      // Diagnostics must never replace the failure they describe.
    }
  }

  await Promise.all(
    options.directories.map(async (directory) => {
      await Promise.all([writeAuthoringTsconfig(directory, report), publishOverlay(directory, platform, report)])
    }),
  )
}
