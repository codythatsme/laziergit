import { literalPathspec, type DiffTarget } from "laziergit"

export interface DiffFetch {
  readonly argv: readonly string[]
  /** `git diff --no-index` exits 1 both for "they differ" and for "cannot read"; only the
   * presence of a patch tells them apart. */
  readonly nonZeroExitMayCarryPatch: boolean
  /** Whether git was asked to print its own commit header before the patch. */
  readonly headed: boolean
}

/**
 * The git invocation for a target. Every shape here must stay on `ctx.git.raw`'s read-only
 * list: a fetch counted as a mutation would refresh the store, which re-runs the fetch.
 */
export function fetchFor(target: DiffTarget, context: number, untracked: ReadonlySet<string>): DiffFetch {
  // `--no-ext-diff` is the only thing that disarms a user's `GIT_EXTERNAL_DIFF`, whose output
  // has no `@@` in it; it is a diff-only option, so core cannot pin it globally.
  const patchFlags = ["--no-ext-diff", `-U${context}`]
  // `literalPathspec` because git reads every path as a pattern: `foo[1].txt` would otherwise
  // also match `foo1.txt`.
  const pathspec = target.path === null ? [] : ["--", literalPathspec(target.path)]
  // For argvs that write their own `--`. It goes in unconditionally: anything naming a
  // revision must end the revision list, or `git show docs` is an ambiguous argument.
  const pathTail = target.path === null ? [] : [literalPathspec(target.path)]
  switch (target.kind) {
    case "workingTree":
      // An untracked file has nothing in the index to diff against, so plain `git diff` prints
      // nothing; `--no-index` against `/dev/null` renders the whole file as added. Untracked
      // paths only — a tracked one would render whole rather than as its change. The path is
      // raw because `--no-index` takes filesystem paths, not pathspecs.
      if (target.path !== null && untracked.has(target.path)) {
        return {
          argv: ["diff", "--no-index", ...patchFlags, "--", "/dev/null", target.path],
          nonZeroExitMayCarryPatch: true,
          headed: false,
        }
      }
      return { argv: ["diff", ...patchFlags, ...pathspec], nonZeroExitMayCarryPatch: false, headed: false }
    case "staged":
      return { argv: ["diff", "--cached", ...patchFlags, ...pathspec], nonZeroExitMayCarryPatch: false, headed: false }
    case "commit":
    case "branch":
      // A branch is a ref like any other; the kinds differ only in the line the Pane writes
      // above the result.
      //
      // `--pretty=medium` is pinned rather than left to the user's `format.pretty`, which core
      // does not pin: `oneline` drops the body, and a custom format drops the four-space
      // message indent that keeps a message line from parsing as a `diff --git` boundary.
      //
      // `--first-parent` is what makes a merge render at all — git prints no diff for one
      // otherwise — and is byte-identical to no flag on a non-merge commit. `--cc` renders
      // nothing for a conflict-free merge, and `-m` claims each file changed once per parent.
      return {
        argv: ["show", "--pretty=medium", ...patchFlags, "--first-parent", target.ref, "--", ...pathTail],
        nonZeroExitMayCarryPatch: false,
        headed: true,
      }
    case "stash":
      // `git stash show` takes one revision and nothing else, so a narrowed stash diffs the
      // entry against its first parent instead — byte-identical to `stash show -p`.
      if (target.path !== null) {
        return {
          argv: ["diff", ...patchFlags, `${target.ref}^1`, target.ref, "--", ...pathTail],
          nonZeroExitMayCarryPatch: false,
          headed: false,
        }
      }
      // `show` must sit immediately after `stash`: the service reads the next argv element as
      // the operand, and only the exact pair `stash show` is on its read-only list.
      return {
        argv: ["stash", "show", "-p", ...patchFlags, target.ref],
        nonZeroExitMayCarryPatch: false,
        headed: false,
      }
  }
}
