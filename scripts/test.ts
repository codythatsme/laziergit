#!/usr/bin/env bun
/**
 * Runs each test file in its own process, so one suite's runtime state can never leak into
 * another's. The first argument picks a slice — `unit`, `integration`, or `all` (the
 * default) — and every remaining flag passes through to each per-file run, so
 * `bun scripts/test.ts integration --rerun-each 10 --randomize` stresses each file inside
 * its own process.
 */

/**
 * Pure-logic suites: no renderer, no git subprocesses, no filesystem watching. One
 * environment is as good as three for these. Everything else counts as integration, so a
 * new suite gets cross-platform coverage until it earns its way onto this list.
 */
const unitPrefixes = ["packages/core/src/config/", "packages/laziergit/", "packages/runtime-bridge/", "extensions/"]

const isUnit = (path: string): boolean => unitPrefixes.some((prefix) => path.startsWith(prefix))

const [first, ...restArgs] = process.argv.slice(2)
const mode = first === "unit" || first === "integration" || first === "all" ? first : "all"
const extraArgs = mode === first ? restArgs : process.argv.slice(2)

const roots = ["packages", "extensions"] as const
const glob = new Bun.Glob("**/*.test.{ts,tsx}")
const files = (
  await Promise.all(
    roots.map(async (root) => [...glob.scanSync({ cwd: root, onlyFiles: true })].map((path) => `${root}/${path}`)),
  )
)
  .flat()
  .sort()
  .filter((path) => (mode === "all" ? true : mode === "unit" ? isUnit(path) : !isUnit(path)))

for (const file of files) {
  const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", ...extraArgs, file], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
