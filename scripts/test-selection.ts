export type TestMode = "unit" | "integration" | "all"

export interface TestShard {
  /** One-based shard index, matching the CLI and workflow matrix. */
  index: number
  total: number
}

export interface TestArguments {
  mode: TestMode
  shard?: TestShard
  extraArgs: string[]
}

/**
 * Pure-logic suites: no renderer, no git subprocesses, no filesystem watching. One
 * environment is as good as three for these. Everything else counts as integration, so a
 * new suite gets cross-platform coverage until it earns its way onto this list.
 */
const unitPrefixes = ["packages/core/src/config/", "packages/laziergit/", "packages/runtime-bridge/", "extensions/"]

const roots = ["packages", "extensions"] as const
const testGlob = new Bun.Glob("**/*.test.{ts,tsx}")

export const defaultTestFileWeight = 1

/**
 * Approximate seconds for integration files taking at least ten seconds in the successful
 * macOS stress run https://github.com/codythatsme/laziergit/actions/runs/30801463252/job/91646753164.
 * Longest-processing-time assignment only needs relative weights, so keeping the small
 * heavy-file tail current is enough; new and fast files receive the default weight above.
 */
export const stressTestFileWeights: Readonly<Record<string, number>> = {
  "packages/core/src/bundled/branches-clean.test.tsx": 9,
  "packages/core/src/bundled/branches.test.tsx": 110,
  "packages/core/src/bundled/commit-flow.test.tsx": 53,
  "packages/core/src/bundled/commits.test.tsx": 92,
  "packages/core/src/bundled/diff-context.test.tsx": 24,
  "packages/core/src/bundled/diff.test.tsx": 29,
  "packages/core/src/bundled/files.test.tsx": 137,
  "packages/core/src/bundled/gh-workflows.test.tsx": 59,
  "packages/core/src/bundled/stash.test.tsx": 87,
  "packages/core/src/bundled/sync.test.tsx": 76,
  "packages/core/src/extension/kernel.test.tsx": 38,
  "packages/core/src/git/activity.test.ts": 14,
  "packages/core/src/git/live-pane.test.tsx": 17,
  "packages/core/src/git/service.test.ts": 151,
  "packages/core/src/public-api.test.tsx": 31,
  "packages/core/src/ui/framework.test.tsx": 36,
}

const isMode = (value: string | undefined): value is TestMode =>
  value === "unit" || value === "integration" || value === "all"

const isUnit = (path: string): boolean => unitPrefixes.some((prefix) => path.startsWith(prefix))

const parseShard = (value: string | undefined): TestShard => {
  const match = value?.match(/^([1-9]\d*)\/([1-9]\d*)$/)
  if (match === undefined || match === null) {
    throw new Error(`Invalid --shard ${JSON.stringify(value ?? "")}; expected INDEX/TOTAL (for example 1/4)`)
  }

  const index = Number(match[1])
  const total = Number(match[2])
  if (index > total) {
    throw new Error(`Invalid --shard ${JSON.stringify(value)}; INDEX must not exceed TOTAL`)
  }

  return { index, total }
}

export const parseTestArguments = (args: readonly string[]): TestArguments => {
  const [first] = args
  const mode = isMode(first) ? first : "all"
  const runnerArgs = isMode(first) ? args.slice(1) : args
  const extraArgs: string[] = []
  let shard: TestShard | undefined

  for (let index = 0; index < runnerArgs.length; index += 1) {
    const argument = runnerArgs[index]
    const isSeparateShard = argument === "--shard"
    const isInlineShard = argument?.startsWith("--shard=") ?? false
    if (!isSeparateShard && !isInlineShard) {
      if (argument !== undefined) extraArgs.push(argument)
      continue
    }

    if (shard !== undefined) throw new Error("Only one --shard argument may be provided")
    const value = isSeparateShard ? runnerArgs[index + 1] : argument?.slice("--shard=".length)
    shard = parseShard(value)
    if (isSeparateShard) index += 1
  }

  return shard === undefined ? { mode, extraArgs } : { mode, shard, extraArgs }
}

export const discoverTestFiles = (): string[] =>
  roots
    .flatMap((root) => [...testGlob.scanSync({ cwd: root, onlyFiles: true })].map((path) => `${root}/${path}`))
    .toSorted()

export const selectTestFiles = (files: readonly string[], mode: TestMode): string[] =>
  files.filter((path) => (mode === "all" ? true : mode === "unit" ? isUnit(path) : !isUnit(path))).toSorted()

export const assignFilesToShards = (
  files: readonly string[],
  shardCount: number,
  weights: Readonly<Record<string, number>> = stressTestFileWeights,
): string[][] => {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`Shard count must be a positive integer; received ${shardCount}`)
  }

  const weightedFiles = files
    .map((file) => ({ file, weight: weights[file] ?? defaultTestFileWeight }))
    .toSorted((left, right) => right.weight - left.weight || left.file.localeCompare(right.file))
  const shards = Array.from({ length: shardCount }, () => ({ files: [] as string[], weight: 0 }))
  const [firstShard, ...remainingShards] = shards
  if (firstShard === undefined) throw new Error("At least one shard is required")

  for (const weightedFile of weightedFiles) {
    const lightestShard = remainingShards.reduce(
      (lightest, candidate) => (candidate.weight < lightest.weight ? candidate : lightest),
      firstShard,
    )
    lightestShard.files.push(weightedFile.file)
    lightestShard.weight += weightedFile.weight
  }

  return shards.map((shard) => shard.files.toSorted())
}
