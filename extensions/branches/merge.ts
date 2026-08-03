export type MergeMode = "fast-forward" | "merge-commit" | "squash" | "squash-commit"

export interface MergeChoice {
  readonly label: string
  readonly mode: MergeMode
}

export function mergeChoices(canFastForward: boolean): readonly MergeChoice[] {
  return [
    canFastForward
      ? { label: "Regular merge (fast-forward)", mode: "fast-forward" }
      : { label: "Regular merge (with merge commit)", mode: "merge-commit" },
    ...(canFastForward ? [{ label: "Regular merge (with merge commit)", mode: "merge-commit" } as const] : []),
    { label: "Squash merge and leave uncommitted", mode: "squash" },
    { label: "Squash merge and commit", mode: "squash-commit" },
  ]
}

export function mergeArgs(branch: string, mode: MergeMode): readonly string[] {
  switch (mode) {
    case "fast-forward":
      return ["merge", "--ff-only", "--", branch]
    case "merge-commit":
      return ["merge", "--no-ff", "--no-edit", "--", branch]
    case "squash":
    case "squash-commit":
      return ["merge", "--squash", "--", branch]
  }
}

export function squashCommitMessage(branch: string, currentBranch: string): string {
  return `Squash merge ${branch} into ${currentBranch}`
}
