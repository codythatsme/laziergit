import { describe, expect, test } from "bun:test"
import {
  assignFilesToShards,
  defaultTestFileWeight,
  discoverTestFiles,
  parseTestArguments,
  selectTestFiles,
  stressTestFileWeights,
} from "./test-selection"

describe("test file sharding", () => {
  test("is deterministic regardless of discovery order", () => {
    const files = ["delta.test.ts", "alpha.test.ts", "charlie.test.ts", "bravo.test.ts"]
    const weights = {
      "alpha.test.ts": 40,
      "bravo.test.ts": 30,
      "charlie.test.ts": 20,
      "delta.test.ts": 10,
    }

    expect(assignFilesToShards(files, 2, weights)).toEqual(assignFilesToShards(files.toReversed(), 2, weights))
  })

  test("assigns every integration file to exactly one shard", () => {
    const files = discoverTestFiles()
    const integrationFiles = selectTestFiles(files, "integration")
    const shards = assignFilesToShards(integrationFiles, 4, stressTestFileWeights)
    const assigned = shards.flat().toSorted()

    expect(assigned).toEqual(integrationFiles)
    expect(new Set(assigned).size).toBe(integrationFiles.length)
  })

  test("keeps the measured stress allocation meaningfully balanced", () => {
    const files = selectTestFiles(discoverTestFiles(), "integration")
    const shards = assignFilesToShards(files, 4, stressTestFileWeights)
    const weights = shards.map((shard) =>
      shard.reduce((total, file) => total + (stressTestFileWeights[file] ?? defaultTestFileWeight), 0),
    )
    const idealWeight = weights.reduce((total, weight) => total + weight, 0) / weights.length

    expect(Math.max(...weights)).toBeLessThanOrEqual(idealWeight * 1.05)
  })

  test("spreads newly added unweighted files evenly and never drops them", () => {
    const files = Array.from({ length: 11 }, (_, index) => `new-${index}.test.ts`)
    const shards = assignFilesToShards(files, 4, {})
    const sizes = shards.map((shard) => shard.length)

    expect(shards.flat().toSorted()).toEqual(files.toSorted())
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
  })
})

describe("test runner arguments", () => {
  test("removes a valid file shard while preserving Bun arguments and the known reproduction seed", () => {
    expect(parseTestArguments(["integration", "--shard", "2/4", "--rerun-each", "10", "--seed", "1700475292"])).toEqual(
      {
        mode: "integration",
        shard: { index: 2, total: 4 },
        rerunEach: 10,
        extraArgs: ["--seed", "1700475292"],
      },
    )
  })

  test("accepts the inline rerun form and removes it from Bun's in-process arguments", () => {
    expect(parseTestArguments(["integration", "--rerun-each=3", "--randomize"])).toEqual({
      mode: "integration",
      rerunEach: 3,
      extraArgs: ["--randomize"],
    })
  })

  test("accepts the equals form", () => {
    expect(parseTestArguments(["integration", "--shard=3/4", "--randomize"])).toEqual({
      mode: "integration",
      shard: { index: 3, total: 4 },
      extraArgs: ["--randomize"],
    })
  })

  test.each(["", "0/4", "5/4", "1/0", "1.5/4", "one/four", "1/4/5"])("rejects invalid shard %p", (shard) => {
    expect(() => parseTestArguments(["integration", "--shard", shard])).toThrow("Invalid --shard")
  })

  test("rejects duplicate shard arguments", () => {
    expect(() => parseTestArguments(["integration", "--shard=1/4", "--shard", "2/4"])).toThrow("Only one --shard")
  })

  test.each(["", "0", "-1", "1.5", "many"])("rejects invalid rerun count %p", (count) => {
    expect(() => parseTestArguments(["integration", "--rerun-each", count])).toThrow("Invalid --rerun-each")
  })

  test("rejects duplicate rerun arguments", () => {
    expect(() => parseTestArguments(["integration", "--rerun-each=2", "--rerun-each", "3"])).toThrow(
      "Only one --rerun-each",
    )
  })
})
