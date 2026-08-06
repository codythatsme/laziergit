#!/usr/bin/env bun
/**
 * Runs each test file in its own process, so one suite's runtime state can never leak into
 * another's. The first argument picks a slice — `unit`, `integration`, or `all` (the
 * default). `--shard INDEX/TOTAL` selects one duration-balanced file shard; every other
 * flag passes through to each per-file run, so `bun scripts/test.ts integration --shard
 * 1/4 --rerun-each 10 --randomize` stresses each selected file inside its own process.
 */
import {
  assignFilesToShards,
  defaultTestFileWeight,
  discoverTestFiles,
  parseTestArguments,
  selectTestFiles,
  stressTestFileWeights,
} from "./test-selection"

const { mode, shard, extraArgs } = parseTestArguments(process.argv.slice(2))
const modeFiles = selectTestFiles(discoverTestFiles(), mode)
let files = modeFiles

if (shard !== undefined) {
  const selectedFiles = assignFilesToShards(modeFiles, shard.total)[shard.index - 1]
  if (selectedFiles === undefined) throw new Error(`Shard ${shard.index}/${shard.total} was not assigned`)
  files = selectedFiles

  const estimatedSeconds = files.reduce(
    (total, file) => total + (stressTestFileWeights[file] ?? defaultTestFileWeight),
    0,
  )
  console.log(
    `Running ${mode} file shard ${shard.index}/${shard.total}: ${files.length}/${modeFiles.length} files (estimated weight ${estimatedSeconds}s)`,
  )
  for (const file of files) console.log(`  ${file}`)
}

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
