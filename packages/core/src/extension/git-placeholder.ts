import type { Disposable, GitState } from "laziergit"

const emptyFiles = Object.freeze([])

export const emptyGitState: GitState = Object.freeze({
  head: Object.freeze({ oid: "", branch: null, detached: false, upstream: null }),
  branches: Object.freeze([]),
  remotes: Object.freeze([]),
  tags: Object.freeze([]),
  status: Object.freeze({
    staged: emptyFiles,
    unstaged: emptyFiles,
    untracked: emptyFiles,
    conflicted: emptyFiles,
    isClean: true,
  }),
  commits: Object.freeze([]),
  stash: Object.freeze([]),
})

export class GitPlaceholder {
  getSnapshot = (): GitState => emptyGitState

  subscribe =
    (_listener: () => void): (() => void) =>
    () =>
      undefined

  subscribeSelector<T>(_selector: (state: GitState) => T, _onChange: (value: T, previous: T) => void): Disposable {
    return { dispose: () => undefined }
  }
}

export function gitUnavailable(): Promise<never> {
  return Promise.reject(new Error("Git services arrive in M3"))
}
