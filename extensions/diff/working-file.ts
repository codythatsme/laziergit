import { chmod, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Write a complete replacement beside its target so saves never rely on in-place truncation. */
export async function writeWorkingFile(path: string, content: string): Promise<void> {
  const target = await realpath(path)
  const { mode } = await stat(target)
  const directory = await mkdtemp(join(dirname(target), ".laziergit-conflict-"))
  try {
    const replacement = join(directory, "resolved")
    await writeFile(replacement, content)
    await chmod(replacement, mode)
    await rename(replacement, target)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
