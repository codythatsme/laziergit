import { isAbsolute, relative, sep } from "node:path"

/**
 * Whether `childPath` is `rootPath` itself or lives beneath it — the check that keeps a
 * directory Extension's entry point, and every import copy taken from it, inside the tree it
 * was discovered in. Alone in its own module because two copies of a containment predicate can
 * be fixed in one place and stay wrong in the other, and the wrong one still returns a boolean.
 */
export function isPathInside(rootPath: string, childPath: string): boolean {
  const childRelativePath = relative(rootPath, childPath)
  return (
    childRelativePath === "" ||
    (!isAbsolute(childRelativePath) && childRelativePath !== ".." && !childRelativePath.startsWith(`..${sep}`))
  )
}
