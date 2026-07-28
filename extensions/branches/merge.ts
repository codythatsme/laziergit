export type MergeMode = "fast-forward" | "merge-commit" | "squash" | "squash-commit"

export interface MergeChoice {
  readonly key: string
  readonly label: string
  readonly mode: MergeMode
}

export function mergeChoices(canFastForward: boolean): readonly MergeChoice[] {
  return [
    canFastForward
      ? { key: "m", label: "Regular merge (fast-forward)", mode: "fast-forward" }
      : { key: "m", label: "Regular merge (with merge commit)", mode: "merge-commit" },
    ...(canFastForward
      ? [{ key: "n", label: "Regular merge (with merge commit)", mode: "merge-commit" } as const]
      : []),
    { key: "s", label: "Squash merge and leave uncommitted", mode: "squash" },
    { key: "shift+s", label: "Squash merge and commit", mode: "squash-commit" },
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
