/**
 * What to put in front of the user when git says no: git's own sentence, which
 * {@link GitError.message} already carries. Internal newlines survive, so a rejected
 * `pre-commit` hook reaches the toast across several lines.
 *
 * ```ts
 * try {
 *   await ctx.git.commit(message);
 * } catch (error) {
 *   ctx.popups.notify(describeGitFailure(error), "error");
 * }
 * ```
 */
export function describeGitFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
