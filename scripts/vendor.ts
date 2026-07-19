#!/usr/bin/env bun
/**
 * Fetches the reference repos into vendor/ at pinned SHAs.
 * vendor/ is gitignored — run this after cloning, or after bumping vendor-pins.json.
 *
 * Usage: bun scripts/vendor.ts [name...]   (no args = all)
 */
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import pinsJson from "./vendor-pins.json"

type Pin = { repo: string; sha: string; sparse?: string[]; note?: string }
const pins = pinsJson as Record<string, Pin>

const root = join(import.meta.dir, "..")
const vendorDir = join(root, "vendor")

const only = Bun.argv.slice(2)
const entries = Object.entries(pins).filter(([name]) => only.length === 0 || only.includes(name))
if (entries.length === 0) {
  console.error(`no matching pins; known: ${Object.keys(pins).join(", ")}`)
  process.exit(1)
}

for (const [name, pin] of entries) {
  const dest = join(vendorDir, name)
  if (existsSync(join(dest, ".git"))) {
    const current = (await $`git -C ${dest} rev-parse HEAD`.text()).trim()
    if (current === pin.sha) {
      console.log(`✓ ${name} already at ${pin.sha.slice(0, 10)}`)
      continue
    }
    rmSync(dest, { recursive: true })
  }
  console.log(`… ${name} ← ${pin.repo} @ ${pin.sha.slice(0, 10)}${pin.sparse ? " (sparse)" : ""}`)
  await $`git init -q ${dest}`
  await $`git -C ${dest} remote add origin ${pin.repo}`
  if (pin.sparse) await $`git -C ${dest} sparse-checkout set --cone ${pin.sparse}`
  await $`git -C ${dest} fetch -q --depth 1 origin ${pin.sha}`
  await $`git -C ${dest} checkout -q FETCH_HEAD`
  console.log(`✓ ${name}`)
}
