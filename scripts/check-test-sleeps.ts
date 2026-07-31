/**
 * Rejects `Bun.sleep` in renderer test files. A UI test that sleeps for a fixed time is
 * betting on how fast the machine is, and CI collects on that bet: waits belong in the
 * test harness's condition-based helpers, which poll until the expected state is on screen.
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
  // The sleep is the body of a spawned child standing in for a long-lived process.
  ["packages/core/src/public-api.test.tsx", "child-process fixture"],
  // Proves the watcher stays disarmed after shutdown: an absence over elapsed time, with
  // no positive condition to poll for.
  ["packages/core/src/extension/kernel.test.tsx", "watcher-disarm absence check"],
])

const roots = ["packages", "extensions"]
const glob = new Glob("**/*.test.tsx")
const offenders: string[] = []

for (const root of roots) {
  for await (const file of glob.scan(root)) {
    // Glob yields native separators; keep comparisons and diagnostics repository-relative.
    const path = `${root}/${file.replaceAll("\\", "/")}`
    if (allowed.has(path)) continue
    const source = await Bun.file(path).text()
    if (source.includes("Bun.sleep")) offenders.push(path)
  }
}

if (offenders.length > 0) {
  console.error("Fixed sleeps in renderer tests — wait on a condition via the test harness instead:")
  for (const path of offenders) console.error(`  ${path}`)
  process.exit(1)
}
