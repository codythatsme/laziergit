import type { ChangeKind, FileChange, WorktreeChange } from "laziergit"

type Selection = readonly string[] | "all"

const codeOf: Readonly<Record<ChangeKind, string>> = Object.freeze({
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
})

function shortStatus(change: Extract<FileChange, { kind: "changed" }>): string {
  if (change.worktree === "untracked") return "??"
  const index = change.index === null ? " " : codeOf[change.index]
  const worktree = change.worktree === null ? " " : codeOf[change.worktree]
  return `${index}${worktree}`
}

function changed(
  change: Extract<FileChange, { kind: "changed" }>,
  index: ChangeKind | null,
  worktree: WorktreeChange | null,
): FileChange {
  return { ...change, index, worktree }
}

/**
 * The status pairs whose post-`git add` result is knowable without asking git. Kept
 * deliberately conservative: conflicts, renames, copies, and type changes reconcile from the
 * real refresh instead of briefly claiming an answer we cannot derive.
 */
function stageChange(change: FileChange): FileChange {
  if (change.kind !== "changed") return change
  switch (shortStatus(change)) {
    case "??":
    case " A":
      return changed(change, "added", null)
    case " M":
    case "MM":
      return changed(change, "modified", null)
    case " D":
    case "MD":
      return changed(change, "deleted", null)
    case "AM":
      return changed(change, "added", null)
    default:
      return change
  }
}

/** The inverse status pairs whose post-reset result is equally unambiguous. */
function unstageChange(change: FileChange): FileChange {
  if (change.kind !== "changed") return change
  switch (shortStatus(change)) {
    case "A ":
      return changed(change, null, "untracked")
    case "M ":
    case "MM":
      return changed(change, null, "modified")
    case "D ":
      return changed(change, null, "deleted")
    default:
      return change
  }
}

function selected(path: string, selection: Selection): boolean {
  if (selection === "all") return true
  return selection.some((candidate) => path === candidate || path.startsWith(`${candidate}/`))
}

function preview(
  files: readonly FileChange[],
  selection: Selection,
  transform: (change: FileChange) => FileChange,
): readonly FileChange[] {
  let changed = false
  const next = files.map((file) => {
    if (!selected(file.path, selection)) return file
    const transformed = transform(file)
    changed ||= transformed !== file
    return transformed
  })
  return changed ? next : files
}

export function previewStage(files: readonly FileChange[], selection: Selection): readonly FileChange[] {
  return preview(files, selection, stageChange)
}

export function previewUnstage(files: readonly FileChange[], selection: Selection): readonly FileChange[] {
  return preview(files, selection, unstageChange)
}
