/**
 * Rejects local redefinitions of the test harness's synchronization helpers. Fixed delays
 * themselves are oxlint's job (`no-restricted-properties`/`no-restricted-globals` over
 * `*.test.tsx`); this covers the rule oxlint cannot express — a test file defining its own
 * `press` or `waitFor` is how the fixed-sleep helpers came back twice already: the local
 * copy starts as a wrapper and grows a sleep. Runs from the pre-commit hook and `verify`.
 */
import { Glob } from "bun"

const harnessHelpers = [
  "press",
  "pressEscape",
  "waitFor",
  "waitForFrame",
  "waitUntil",
  "settleUntil",
  "settle",
  "runCommand",
  "refreshGit",
] as const

const helperDefinition = new RegExp(`(?:function|const)\\s+(${harnessHelpers.join("|")})\\s*[(=]`)

const roots = ["packages", "extensions", "scripts/e2e"]
const glob = new Glob("**/*.test.tsx")
const offenders: string[] = []

for (const root of roots) {
  for await (const file of glob.scan(root)) {
    const path = `${root}/${file}`
    const source = await Bun.file(path).text()
    const shadowed = source.match(helperDefinition)
    if (shadowed !== null) {
      offenders.push(`${path} — defines its own \`${shadowed[1]}\`; import it from the test harness instead`)
    }
  }
}

if (offenders.length > 0) {
  console.error("Renderer-test discipline (scripts/check-tests.ts):")
  for (const line of offenders) console.error(`  ${line}`)
  process.exit(1)
}
