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

for (const file of files) {
  const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", file], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
