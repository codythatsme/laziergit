#!/usr/bin/env bun
/**
 * Runs each test file in its own process, so one suite's runtime state can never leak into
 * another's. The first argument picks a slice — `unit`, `integration`, or `all` (the
 * default). `--shard INDEX/TOTAL` selects one duration-balanced file shard; every other
 * flag passes through to each per-file run. `--rerun-each` is expanded into fresh processes
 * because Bun can retain native descriptors between in-process reruns on macOS.
 */
import {
  assignFilesToShards,
  defaultTestFileWeight,
  discoverTestFiles,
  parseTestArguments,
  selectTestFiles,
  stressTestFileWeights,
} from "./test-selection"

const { mode, shard, rerunEach = 1, extraArgs } = parseTestArguments(process.argv.slice(2))
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

for (let repetition = 1; repetition <= rerunEach; repetition += 1) {
  if (rerunEach > 1) console.log(`Test repetition ${repetition}/${rerunEach}`)
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
}
