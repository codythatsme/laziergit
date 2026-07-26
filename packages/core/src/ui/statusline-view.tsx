import { Slot } from "@opentui/react"
import { usePendingSequence } from "@opentui/keymap/react"
import { useTheme, type Theme } from "laziergit"

import type { PaneHost } from "../extension/pane-host"
import type { LiveBinding } from "./keybindings"
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

/**
 * What the focused Pane can do, in the keys that would do it.
 *
 * Only the Commands whose author wrote a {@link CommandSpec.hint} appear. `tab`, the palette
 * and `q` are on every screen in every mode, so printing them forever would crowd out the
 * keys that actually change — core writes no hint of its own for exactly that reason.
 *
 * Clipped rather than wrapped or elided: the row is one line by contract (§1.10), and there
 * is no width here to elide against. The order is the order the Commands were registered in,
 * and the live set puts the focused Pane's before the globals, so what a narrow terminal
 * loses is the least specific end of the line.
 */
function HintBar({ keys }: { keys: ExternalStore<readonly LiveBinding[]> }) {
  const theme = useTheme()
  const bindings = useStore(keys)
  // Narrowed by the same pass that filters, so the label below is a string rather than a
  // second check of the field that decided it was there.
  const hints = bindings.flatMap((binding) =>
    binding.hint === undefined ? [] : [{ id: binding.id, key: binding.key, label: binding.hint }],
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

/**
 * The bottom row: what you can press on the left, Extension-owned segments on the right.
 *
 * Core adds the pending key sequence, because "what did I just press" is the one piece of
 * state no Extension can report. Left-aligned segments still render — the config may pin
 * one there — but they follow the hints rather than displacing them.
 */
export function StatuslineView({
  statusline,
  panes,
  keys,
}: {
  statusline: StatuslineHost
  panes: PaneHost
  keys: ExternalStore<readonly LiveBinding[]>
}) {
  const theme = useTheme()
  const segments = useStore(statusline)
  const pending = usePendingSequence()

  return (
    <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2} flexShrink={1}>
        <HintBar keys={keys} />
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
 * A notification's lines, capped.
 *
 * Git writes its most useful refusals across several lines — "would be overwritten by
 * merge:" is a header and the file list is everything after it — and every Bundled
 * Extension passes `GitError.stderr` through verbatim, so a toast that rendered only the
 * first line would drop precisely the part naming what went wrong. Capped because a toast
 * is an overlay: a rebase that lists forty paths must not cover the screen.
 */
function toastLines(message: string): readonly string[] {
  const lines = message.split("\n").filter((line) => line.trim() !== "")
  if (lines.length <= maxToastLines) return lines.length === 0 ? [message] : lines
  return [...lines.slice(0, maxToastLines), `… ${lines.length - maxToastLines} more lines`]
}

/**
 * Transient notifications, stacked above the status line and never taking focus.
 *
 * `bottom={3}` clears that row rather than landing on it. At `2` a toast sat exactly on the
 * status line and blanked whatever was there for as long as it lasted — survivable when the
 * row held a branch name, not once it also holds the keys you can press, since the moment a
 * toast appears is the moment you are deciding what to do next.
 */
export function ToastLayer({ notifications }: { notifications: NotificationHost }) {
  const theme = useTheme()
  const toasts = useStore(notifications)
  if (toasts.length === 0) return null

  return (
    <box position="absolute" right={2} bottom={3} zIndex={10} flexDirection="column" alignItems="flex-end" gap={1}>
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
