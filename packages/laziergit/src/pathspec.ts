/**
 * A path, as the git pathspec that matches only that path.
 *
 * Every path git accepts is a *pathspec*, and a pathspec is a glob. `foo[1].txt` also
 * matches `foo1.txt`, and `--` does not change that — `--` only stops a leading dash being
 * read as an option. So handing a path straight back to git is not the round trip it looks
 * like: staging `foo[1].txt` also stages `foo1.txt`, and `git clean -ffd` deletes an
 * unrelated `bar1.txt` after a confirm dialog that named exactly one file.
 *
 * `:(literal)` is git's own magic for "this is a path, not a pattern", and every command
 * that takes a pathspec honours it. The porcelain helpers on {@link Git} apply it for you;
 * wrap the paths you put in an argv for {@link Git.raw} yourself:
 *
 * ```ts
 * await ctx.git.raw(["diff", "-U3", "--", literalPathspec(path)]);
 * ```
 */
export function literalPathspec(path: string): string {
  // An empty pathspec is git's error to raise, not this function's to launder: `:(literal)`
  // with nothing after it matches the WHOLE tree, so prefixing `""` would silently turn
  // "stage nothing, badly" into "stage everything".
  return path === "" ? "" : `:(literal)${path}`
}
