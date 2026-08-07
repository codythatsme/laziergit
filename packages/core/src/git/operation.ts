import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import type { GitOperation, GitOperationKind } from "laziergit"

export const noOperation: GitOperation = Object.freeze({
  merging: false,
  rebasing: false,
  cherryPicking: false,
  reverting: false,
  effective: null,
  initiatedHere: false,
})

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function text(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch {
    return null
  }
}

export function effectiveOperation(flags: {
  readonly merging: boolean
  readonly rebasing: boolean
  readonly cherryPicking: boolean
  readonly reverting: boolean
}): GitOperationKind | null {
  if (flags.reverting) return "revert"
  if (flags.cherryPicking) return "cherryPick"
  if (flags.merging) return "merge"
  if (flags.rebasing) return "rebase"
  return null
}

/** Reads worktree-local sentinels. Every failure is absence: refresh must remain total. */
export async function readOperation(gitDir: string): Promise<Omit<GitOperation, "initiatedHere">> {
  const rebaseMerge = join(gitDir, "rebase-merge")
  const rebaseApply = join(gitDir, "rebase-apply")
  const [mergeHead, rebaseMergeExists, rebaseApplyExists, cherryHead, revertHead] = await Promise.all([
    exists(join(gitDir, "MERGE_HEAD")),
    exists(rebaseMerge),
    exists(rebaseApply),
    text(join(gitDir, "CHERRY_PICK_HEAD")),
    exists(join(gitDir, "REVERT_HEAD")),
  ])

  const rebasing = rebaseMergeExists || rebaseApplyExists
  // A stopped interactive rebase writes CHERRY_PICK_HEAD for its current pick. It remains a
  // rebase unless a genuinely nested cherry-pick names a different commit.
  const stoppedSha = rebaseMergeExists ? await text(join(rebaseMerge, "stopped-sha")) : null
  const flags = {
    merging: mergeHead,
    rebasing,
    cherryPicking: cherryHead !== null && (!rebasing || stoppedSha === null || cherryHead !== stoppedSha),
    reverting: revertHead,
  }
  return { ...flags, effective: effectiveOperation(flags) }
}

export function operationFingerprint(operation: Omit<GitOperation, "initiatedHere">): string {
  return [operation.merging, operation.rebasing, operation.cherryPicking, operation.reverting]
    .map((value) => (value ? "1" : "0"))
    .join("")
}
