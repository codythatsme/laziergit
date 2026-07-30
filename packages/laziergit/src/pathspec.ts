/**
 * A path, as the git pathspec that matches only that path. Every path git accepts is a glob —
 * staging `foo[1].txt` also stages `foo1.txt`, and `--` does not change that — so wrap the
 * paths you put in an argv for {@link Git.raw}; the porcelain helpers on {@link Git} already do.
 */
export function literalPathspec(path: string): string {
  // `:(literal)` with nothing after it matches the whole tree, so an empty path is left for
  // git to reject rather than turned into "everything".
  return path === "" ? "" : `:(literal)${path}`
}
