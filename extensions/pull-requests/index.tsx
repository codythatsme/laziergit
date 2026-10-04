/** @jsxImportSource @opentui/react */
import type { TextRenderable } from "@opentui/core"
import {
  createRowSource,
  defineExtension,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type PaneHandle,
  type PaneProps,
  type Head,
  type PullRequest,
  type PullRequestsApi,
  type Remote,
} from "laziergit"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import stringWidth from "string-width"

import {
  formatAge,
  parseAuthoredPullRequests,
  pullRequestQueryArgs,
  pullRequestRepository,
  repositoryArgument,
  repositoryKey,
} from "./model"

const refreshIntervalMs = 60_000
const ellipsis = "..."
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function truncateEnd(value: string, width: number): string {
  if (width <= 0) return ""
  if (stringWidth(value) <= width) return value
  if (width <= ellipsis.length) return ellipsis.slice(0, width)

  const contentWidth = width - ellipsis.length
  let visible = ""
  let used = 0
  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = stringWidth(segment)
    if (used + segmentWidth > contentWidth) break
    visible += segment
    used += segmentWidth
  }
  return `${visible}${ellipsis}`
}

function ShrinkingText({
  value,
  color,
  grow = false,
}: {
  readonly value: string
  readonly color: string
  readonly grow?: boolean
}) {
  const text = useRef<TextRenderable>(null)
  return (
    <box
      flexBasis={stringWidth(value)}
      flexGrow={grow ? 1 : 0}
      flexShrink={1}
      minWidth={0}
      overflow="hidden"
      onSizeChange={function () {
        const visible = truncateEnd(value, this.width)
        if (text.current !== null && text.current.plainText !== visible) text.current.content = visible
      }}
    >
      <text ref={text} width="100%" wrapMode="none" content={value} fg={color} />
    </box>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function commandFailure(stderr: string, stdout: string, fallback: string): Error {
  return new Error(stderr.trim() || stdout.trim() || fallback)
}

function restoreRef(head: Head): string | null {
  if (head.kind === "onBranch") return head.branch
  if (head.kind === "detached") return head.oid
  return null
}

function sameRemotes(left: readonly Remote[], right: readonly Remote[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (remote, index) =>
        remote.name === right[index]?.name &&
        remote.fetchUrl === right[index]?.fetchUrl &&
        remote.pushUrl === right[index]?.pushUrl,
    )
  )
}

export default defineExtension({
  name: "pull-requests",
  description: "Open pull requests authored by the current GitHub user (requires the `gh` CLI)",
  needs: ["branches"],

  activate(ctx): PullRequestsApi {
    const rows = createRowSource<PullRequest>({
      pane: "pull-requests",
      key: (pullRequest) => `${repositoryKey(pullRequest.repository)}#${pullRequest.number}`,
    })

    const fail = (error: unknown): void => ctx.popups.notify(messageOf(error), "error")

    async function restoreCheckout(head: Head, failure: Error): Promise<never> {
      const ref = restoreRef(head)
      if (ref === null) throw failure
      try {
        await ctx.git.checkout(ref)
      } catch (rollback) {
        throw new Error(`${failure.message}\nCould not restore ${ref}: ${messageOf(rollback)}`)
      }
      throw failure
    }

    async function checkout(pullRequest: PullRequest): Promise<void> {
      try {
        const originalHead = ctx.git.state.head
        if (originalHead.kind === "unborn") {
          throw new Error("Cannot safely check out a pull request before the current branch has its first commit")
        }
        const args = [
          "pr",
          "checkout",
          String(pullRequest.number),
          "--repo",
          repositoryArgument(pullRequest.repository),
        ] as const
        const output = await ctx
          .exec("gh", args)
          .catch((cause: unknown) =>
            restoreCheckout(originalHead, cause instanceof Error ? cause : new Error(String(cause))),
          )
        if (output.exitCode !== 0) {
          await restoreCheckout(
            originalHead,
            commandFailure(output.stderr, output.stdout, `Could not check out pull request #${pullRequest.number}`),
          )
        }
        await ctx.git.refresh()
        ctx.popups.notify(`Checked out ${pullRequest.headRefName}`, "success")
      } catch (error) {
        fail(error)
      }
    }

    async function open(pullRequest: PullRequest): Promise<void> {
      try {
        await ctx.open(pullRequest.url)
      } catch (error) {
        fail(error)
      }
    }

    async function copyUrl(pullRequest: PullRequest): Promise<void> {
      try {
        await ctx.copy(pullRequest.url)
        ctx.popups.notify(`Copied pull request #${pullRequest.number} URL`, "success")
      } catch (error) {
        fail(error)
      }
    }

    ctx.commands.register({
      id: "pull-requests.checkout",
      source: rows.api,
      title: "Check out pull request branch",
      hint: "checkout",
      keys: "space",
      run: checkout,
    })
    ctx.commands.register({
      id: "pull-requests.open",
      source: rows.api,
      title: "Open pull request in browser",
      hint: "open",
      keys: "o",
      run: open,
    })
    ctx.commands.register({
      id: "pull-requests.copy-url",
      source: rows.api,
      title: "Copy pull request URL",
      keys: "y",
      run: copyUrl,
    })

    function PullRequestRow({
      pullRequest,
      id,
      selected,
      focused,
      onSelect,
      now,
    }: {
      readonly pullRequest: PullRequest
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
      readonly onSelect: () => void
      readonly now: Date
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(pullRequest)
      const dim = decoration?.dim === true
      const foreground = dim ? theme.textMuted : theme.text
      const age = formatAge(pullRequest.updatedAt, now)

      return (
        <box
          id={id}
          width="100%"
          flexDirection="row"
          backgroundColor={selected && focused ? theme.selection : undefined}
          onMouseDown={onSelect}
        >
          <text wrapMode="none" flexShrink={0}>
            <span fg={pullRequest.isDraft || dim ? theme.textMuted : theme.success}>
              {pullRequest.isDraft ? "D " : "  "}
            </span>
            <span fg={dim ? theme.textMuted : theme.accent}>{`#${pullRequest.number} `}</span>
          </text>
          <ShrinkingText value={pullRequest.title} color={foreground} grow />
          <text wrapMode="none" flexShrink={0} fg={theme.textMuted} content=" · " />
          <ShrinkingText value={pullRequest.headRefName} color={theme.textMuted} />
          {age === null ? null : <text wrapMode="none" flexShrink={0} fg={theme.textMuted} content={` · ${age}`} />}
          {decoration?.badge === undefined ? null : (
            <text
              wrapMode="none"
              flexShrink={0}
              fg={toneColor(theme, decoration.tone)}
              content={`  ${decoration.badge}`}
            />
          )}
        </box>
      )
    }

    function PullRequestsPane({ focused }: PaneProps) {
      const theme = useTheme()
      const remotes = useGit((state) => state.remotes, sameRemotes)
      const repository = useMemo(() => pullRequestRepository(remotes), [remotes])
      const key = repository === null ? null : repositoryKey(repository)
      const [result, setResult] = useState<{ readonly key: string; readonly items: readonly PullRequest[] } | null>(
        null,
      )
      const [attemptedKey, setAttemptedKey] = useState<string | null>(null)
      const [error, setError] = useState<{ readonly key: string; readonly message: string } | null>(null)
      const ticket = useRef(0)
      const pending = useRef<{ readonly key: string; readonly result: Promise<void> } | null>(null)
      const pullRequests = result?.key === key ? result.items : []
      const cursor = useListCursor({
        items: pullRequests,
        idPrefix: "pull-requests",
        noun: "pull request",
        query: {
          mode: "filter",
          fields: (pullRequest) => [
            String(pullRequest.number),
            `#${pullRequest.number}`,
            pullRequest.title,
            pullRequest.headRefName,
          ],
        },
      })
      const selected = cursor.selected

      const refresh = useCallback((): Promise<void> => {
        if (repository === null || key === null) return Promise.resolve()
        if (pending.current?.key === key) return pending.current.result

        const issued = (ticket.current += 1)
        const request = (async () => {
          try {
            const output = await ctx.exec("gh", pullRequestQueryArgs(repository))
            const items = (() => {
              try {
                return parseAuthoredPullRequests(output.stdout, repository)
              } catch (cause) {
                if (output.exitCode !== 0) {
                  throw commandFailure(output.stderr, output.stdout, "GitHub could not list pull requests")
                }
                throw cause
              }
            })()
            if (issued !== ticket.current || ctx.signal.aborted) return
            setResult({ key, items })
            setError(null)
          } catch (cause) {
            if (issued !== ticket.current || ctx.signal.aborted) return
            setError({ key, message: messageOf(cause) })
          } finally {
            if (issued === ticket.current && !ctx.signal.aborted) setAttemptedKey(key)
          }
        })()
        pending.current = { key, result: request }
        void request.finally(() => {
          if (pending.current?.result === request) pending.current = null
        })
        return request
      }, [key, repository])

      useEffect(() => {
        void refresh()
        const timer = setInterval(() => void refresh(), refreshIntervalMs)
        return () => {
          clearInterval(timer)
          ticket.current += 1
          if (pending.current?.key === key) pending.current = null
        }
      }, [key, refresh])

      useEffect(() => {
        rows.setSelected(selected)
        return () => rows.setSelected(undefined)
      }, [selected])

      useCommand({
        id: "pull-requests.refresh",
        title: "Refresh pull requests",
        hint: "refresh",
        keys: "r",
        run: refresh,
      })

      if (repository === null || key === null) {
        return <text fg={theme.textMuted} content="no browsable remote configured" />
      }

      const currentError = error?.key === key ? error.message : null
      const loading = attemptedKey !== key && result?.key !== key
      if (loading) return <text fg={theme.textMuted} content="loading pull requests…" />
      if (pullRequests.length === 0 && currentError !== null) return <text fg={theme.danger} content={currentError} />
      if (pullRequests.length === 0) {
        return <text fg={theme.textMuted} content="no open or draft pull requests authored by you" />
      }

      const now = new Date()
      return (
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          {currentError === null ? null : <text wrapMode="none" fg={theme.danger} content={currentError} />}
          <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
            {cursor.items.map((pullRequest, index) => (
              <PullRequestRow
                key={`${repositoryKey(pullRequest.repository)}#${pullRequest.number}`}
                id={cursor.rowId(index)}
                pullRequest={pullRequest}
                selected={index === cursor.index}
                focused={focused}
                onSelect={() => cursor.setIndex(index)}
                now={now}
              />
            ))}
          </scrollbox>
        </box>
      )
    }

    let pane: PaneHandle | undefined
    let focusCommand: ReturnType<typeof ctx.commands.register> | undefined
    const syncPane = (remotes: readonly Remote[]): void => {
      const available = pullRequestRepository(remotes) !== null
      if (available && pane === undefined) {
        pane = ctx.panes.register({
          id: "pull-requests",
          title: "Pull Requests",
          component: PullRequestsPane,
          placement: { column: 0, order: 32, tabWith: "branches" },
        })
      } else if (!available && pane !== undefined) {
        pane.dispose()
        pane = undefined
      }
      focusCommand?.refresh()
    }

    syncPane(ctx.git.state.remotes)
    ctx.events.on("git.remotes.changed", ({ current }) => syncPane(current))
    focusCommand = ctx.commands.register({
      id: "pull-requests.focus",
      title: "Focus pull requests",
      when: () => pane !== undefined,
      run: () => pane?.focus(),
    })

    return rows.api
  },
})
