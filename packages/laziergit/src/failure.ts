/** What to put in front of the user when git says no: git's own sentence, which {@link GitError.message} already carries, internal newlines included. */
export function describeGitFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
