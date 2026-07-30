import { isAbsolute, relative, sep } from "node:path"

/**
 * Whether `childPath` is `rootPath` itself or lives beneath it — the check that keeps a
 * directory Extension's entry point, and every import copy taken from it, inside the tree it
 * was discovered in.
 */
export function isPathInside(rootPath: string, childPath: string): boolean {
  const childRelativePath = relative(rootPath, childPath)
  return (
    childRelativePath === "" ||
    (!isAbsolute(childRelativePath) && childRelativePath !== ".." && !childRelativePath.startsWith(`..${sep}`))
  )
}
