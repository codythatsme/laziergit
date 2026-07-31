/**
 * Rejects timing bets in renderer tests before they can flake in CI. A UI test that sleeps
 * for a fixed time is betting on how fast the machine is, and CI collects on that bet: waits
 * belong in the test harness's condition-based helpers, which poll until the expected state
 * is on screen. Runs from the pre-commit hook and from `verify`, so the answer arrives in
 * seconds rather than a CI round-trip later.
 *
 * The allowlist names the files where real time is the subject itself, with the reason.
 * Adding to it is a review decision, not a fix.
 */
import { Glob } from "bun"

const allowed: ReadonlyMap<string, string> = new Map([
  // The loader-animation test samples frames over a deliberately slow push hook: elapsed
  // time is what makes the animation observable.
  ["packages/core/src/bundled/sync.test.tsx", "animation sampling"],
  // A stand-in git that stalls on purpose, so a fetch's in-flight state can be asserted.
  ["packages/core/src/bundled/diff.test.tsx", "slow-git fixture"],
  // The sleep is the body of a spawned child standing in for a long-lived process, and the
  // timer is a deadline guard on a fixture subprocess.
  ["packages/core/src/public-api.test.tsx", "child-process fixture"],
  // Proves the watcher stays disarmed after shutdown — an absence over elapsed time, with
  // no positive condition to poll for — and guards a fixture subprocess with a deadline.
  ["packages/core/src/extension/kernel.test.tsx", "watcher-disarm absence check"],
])

/**
 * The harness owns these names. A test file defining its own is how the fixed-sleep press
 * helpers came back twice already: the local copy starts as a wrapper and grows a sleep.
 */
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

    if (!allowed.has(path) && (source.includes("Bun.sleep") || source.includes("setTimeout"))) {
      offenders.push(`${path} — fixed delay; wait on a condition with waitFor/waitForFrame instead`)
    }

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
