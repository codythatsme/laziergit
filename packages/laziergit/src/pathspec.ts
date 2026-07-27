/**
 * A path, as the git pathspec that matches only that path.
 *
 * Every path git accepts is a pathspec, and a pathspec is a glob: staging `foo[1].txt` also
 * stages `foo1.txt`, and `--` does not change that. The porcelain helpers on {@link Git} apply
 * `:(literal)` for you; wrap the paths you put in an argv for {@link Git.raw} yourself:
 *
 * ```ts
 * await ctx.git.raw(["diff", "-U3", "--", literalPathspec(path)]);
 * ```
 */
export function literalPathspec(path: string): string {
  // `:(literal)` with nothing after it matches the whole tree, so an empty path is left for
  // git to reject rather than turned into "everything".
  return path === "" ? "" : `:(literal)${path}`
}
