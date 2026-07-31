#!/usr/bin/env bun

const roots = ["packages", "extensions"] as const
const glob = new Bun.Glob("**/*.test.{ts,tsx}")
const files = (
  await Promise.all(
    roots.map(async (root) => [...glob.scanSync({ cwd: root, onlyFiles: true })].map((path) => `${root}/${path}`)),
  )
)
  .flat()
  .sort()

// Extra flags pass through to every per-file run, so `bun scripts/test.ts --rerun-each 10
// --randomize` stresses each file inside its own process.
const extraArgs = process.argv.slice(2)

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
