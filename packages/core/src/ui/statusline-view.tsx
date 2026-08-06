import type { InputKeyBinding } from "@opentui/core"
import { Slot } from "@opentui/react"
import { usePendingSequence } from "@opentui/keymap/react"
import { useTheme, type Theme } from "laziergit"

import type { PaneHost } from "../extension/pane-host"
import type { LiveBinding } from "./keybindings"
import type { ListQueryHost, ListQuerySnapshot } from "./list-query-host"
import type { NotificationHost, Toast } from "./notification-host"
import { segmentSlotName } from "./slots"
import type { StatusSegment, StatuslineHost } from "./statusline-host"
import { useStore, type ExternalStore } from "./use-store"

function toastColor(level: Toast["level"], theme: Theme): string {
  if (level === "success") return theme.success
  if (level === "warning") return theme.warning
  if (level === "error") return theme.danger
  return theme.info
}

function Segments({ panes, segments }: { panes: PaneHost; segments: readonly StatusSegment[] }) {
  return (
    <box flexDirection="row" gap={2}>
      {segments.map((segment) => (
        <Slot
          key={segment.id}
          registry={panes.registry}
          name={segmentSlotName(segment.id)}
          mode="single_winner"
          paneId={segment.id}
          focused={false}
        />
      ))}
    </box>
  )
}

/** Between two hints, and wide enough to read as a gap rather than as punctuation. */
const hintSeparator = "  ·  "
const queryInputKeyBindings = [
  { name: "backspace", super: true, action: "delete-to-line-start" },
  { name: "delete", super: true, action: "delete-to-line-end" },
] satisfies InputKeyBinding[]

function hintKey(key: string): string {
  const shiftedLetter = /^shift\+([a-z])$/i.exec(key)
  return shiftedLetter?.[1]?.toUpperCase() ?? key
}

/**
 * What the focused Pane can do, in the keys that would do it. Only Commands whose author wrote
 * a {@link CommandSpec.hint} appear: `tab`, the palette and `q` are on every screen in every
 * mode, so printing them forever would crowd out the keys that change.
 *
 * Clipped rather than wrapped or elided, since the row is one line by contract. The
 * live set puts the focused Pane's Commands before the globals, so a narrow terminal loses the
 * least specific end of the line.
 */
function HintBar({ keys }: { keys: ExternalStore<readonly LiveBinding[]> }) {
  const theme = useTheme()
  const bindings = useStore(keys)
  // Narrowed by the same pass that filters, so the label below is a string rather than a
  // second check of the field that decided it was there.
  const hints = bindings.flatMap((binding) =>
    binding.hint === undefined ? [] : [{ id: binding.id, key: hintKey(binding.key), label: binding.hint }],
  )

  return (
    <text wrapMode="none">
      {hints.map((entry, index) => (
        <span key={entry.id}>
          <span fg={theme.textMuted}>{index === 0 ? "" : hintSeparator}</span>
          <span fg={theme.accent}>{entry.key}</span>
          <span fg={theme.textMuted}>{` ${entry.label}`}</span>
        </span>
      ))}
    </text>
  )
}

function queryStatus(query: ListQuerySnapshot): string {
  const escaped = query.value.replaceAll("'", "\\'")
  if (query.mode === "filter") {
    return `matches for '${escaped}' (${query.matchCount} of ${query.totalCount})  ·  escape clear`
  }
  const position = query.currentMatch === null ? 0 : query.currentMatch + 1
  return `matches for '${escaped}' (${position} of ${query.matchCount})  ·  n next  ·  N previous  ·  escape clear`
}

function HintOrQuery({ host, keys }: { host: ListQueryHost; keys: ExternalStore<readonly LiveBinding[]> }) {
  const theme = useTheme()
  const query = useStore(host)
  if (query === null) return <HintBar keys={keys} />

  if (!query.editing) {
    return <text wrapMode="none" content={queryStatus(query)} style={{ fg: theme.textMuted }} />
  }

  return (
    <box flexDirection="row" flexGrow={1}>
      <text content={query.mode === "filter" ? "Filter: " : "Search: "} style={{ fg: theme.accent }} />
      <input
        key={`${query.paneId}:${query.id}`}
        focused
        flexGrow={1}
        value={query.value}
        keyBindings={queryInputKeyBindings}
        onInput={query.input}
      />
    </box>
  )
}

/**
 * The bottom row: what you can press on the left, Extension-owned segments on the right. Core
 * adds the pending key sequence, because "what did I just press" is the one piece of state no
 * Extension can report.
 */
export function StatuslineView({
  statusline,
  panes,
  keys,
  listQuery,
}: {
  statusline: StatuslineHost
  panes: PaneHost
  keys: ExternalStore<readonly LiveBinding[]>
  listQuery: ListQueryHost
}) {
  const theme = useTheme()
  const segments = useStore(statusline)
  const pending = usePendingSequence()

  return (
    // `paddingLeft={2}` is a Pane's border plus its own left padding, so the hint bar starts on
    // the column every Pane row starts on. `gap={2}` keeps the two halves apart: `space-between`
    // alone lets a long hint run touch the branch name.
    <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} gap={2}>
      <box flexDirection="row" gap={2} flexGrow={1} flexBasis={0}>
        <HintOrQuery host={listQuery} keys={keys} />
        <Segments panes={panes} segments={segments.left} />
      </box>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <Segments panes={panes} segments={segments.right} />
        {pending.length > 0 ? (
          <text content={pending.map((part) => part.display).join("")} style={{ fg: theme.accent }} />
        ) : null}
      </box>
    </box>
  )
}

/** How many lines of one notification a toast shows before it says there are more. */
const maxToastLines = 6

/**
 * A notification's lines, capped. Git writes its most useful refusals across several lines — a
 * header plus the file list — and every Bundled Extension passes `GitError.stderr` through
 * verbatim, so rendering only the first line would drop the part naming what went wrong.
 * Capped because a toast is an overlay.
 */
function toastLines(message: string): readonly string[] {
  const lines = message.split("\n").filter((line) => line.trim() !== "")
  if (lines.length <= maxToastLines) return lines.length === 0 ? [message] : lines
  return [...lines.slice(0, maxToastLines), `… ${lines.length - maxToastLines} more lines`]
}

/**
 * Transient notifications, stacked above the status line and never taking focus. `bottom={2}`
 * clears that row rather than landing on it: at `1` a toast would blank the keys you can press
 * for as long as it lasted, at exactly the moment you are deciding what to do next. `right={0}`
 * docks the toast's border to the column the Pane frames end on.
 */
export function ToastLayer({ notifications }: { notifications: NotificationHost }) {
  const theme = useTheme()
  const toasts = useStore(notifications)
  if (toasts.length === 0) return null

  return (
    <box position="absolute" right={0} bottom={2} zIndex={10} flexDirection="column" alignItems="flex-end" gap={1}>
      {toasts.map((toast) => (
        <box
          key={toast.id}
          border
          borderStyle="rounded"
          borderColor={toastColor(toast.level, theme)}
          backgroundColor={theme.backgroundPanel}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          alignItems="flex-start"
        >
          {toastLines(toast.message).map((line, index) => (
            <text
              key={`${toast.id}:${index}`}
              content={index === 0 ? `${toast.extension}: ${line}` : line}
              style={{ fg: toastColor(toast.level, theme) }}
            />
          ))}
        </box>
      ))}
    </box>
  )
}
