import { isAbsolute, relative, sep } from "node:path"

/**
 * Whether `childPath` is `rootPath` itself or lives beneath it — the check that keeps a directory
 * Extension's entry point, and every import copy taken from it, from reaching outside the tree it
 * was discovered in. It sits alone in its own module because a containment predicate is the one
 * helper that must not be copied: two of these can be fixed in one place and stay wrong in the
 * other, and the wrong one still returns a plausible boolean.
 */
export function isPathInside(rootPath: string, childPath: string): boolean {
  const childRelativePath = relative(rootPath, childPath)
  return (
    childRelativePath === "" ||
    (!isAbsolute(childRelativePath) && childRelativePath !== ".." && !childRelativePath.startsWith(`..${sep}`))
  )
}
