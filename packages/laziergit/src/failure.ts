/**
 * What to put in front of the user when git says no.
 *
 * git's own sentence is the whole explanation — it wrote it for this exact situation, and a
 * friendlier paraphrase would be a worse one. {@link GitError.message} already *is* that
 * sentence: the constructor builds it from `stderr.trim()`, falling back to a description of
 * the argv and exit code for the failures git says nothing about. Internal newlines survive
 * the trim, so a rejected `pre-commit` hook still reaches the toast across several lines.
 *
 * Anything that is not a {@link GitError} reaching here is a bug in the calling Extension
 * rather than a refusal from git, and says so plainly instead of hiding behind a generic
 * message.
 *
 * ```ts
 * try {
 *   await ctx.git.commit(message);
 * } catch (error) {
 *   ctx.popups.notify(describeGitFailure(error), "error");
 * }
 * ```
 *
 * Public API rather than a snippet each Extension copies: all eight Bundled Extensions
 * wanted it, six wrote it under five different names, and five of those spelled the
 * `stderr.trim() || message` fallback that {@link GitError} already applies for them.
 */
export function describeGitFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
