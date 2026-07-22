import { Slot } from "@opentui/react"
import { usePendingSequence } from "@opentui/keymap/react"
import { useTheme, type Theme } from "laziergit"

import type { PaneHost } from "../extension/pane-host"
import type { NotificationHost, Toast } from "./notification-host"
import { segmentSlotName } from "./slots"
import type { StatusSegment, StatuslineHost } from "./statusline-host"
import { useStore } from "./use-store"

const hint = "tab focus  ·  mod+p palette  ·  ?  keys  ·  q quit"

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

/**
 * One row of Extension-owned segments. Core adds only the pending key sequence, because
 * "what did I just press" is the one piece of state no Extension can report.
 */
export function StatuslineView({ statusline, panes }: { statusline: StatuslineHost; panes: PaneHost }) {
  const theme = useTheme()
  const segments = useStore(statusline)
  const pending = usePendingSequence()

  return (
    <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      {segments.left.length === 0 ? (
        <text content={hint} style={{ fg: theme.textMuted }} />
      ) : (
        <Segments panes={panes} segments={segments.left} />
      )}
      <box flexDirection="row" gap={2}>
        <Segments panes={panes} segments={segments.right} />
        {pending.length > 0 ? (
          <text content={pending.map((part) => part.display).join("")} style={{ fg: theme.accent }} />
        ) : null}
      </box>
    </box>
  )
}

/** Transient notifications, stacked above the status line and never taking focus. */
export function ToastLayer({ notifications }: { notifications: NotificationHost }) {
  const theme = useTheme()
  const toasts = useStore(notifications)
  if (toasts.length === 0) return null

  return (
    <box position="absolute" right={2} bottom={2} zIndex={10} flexDirection="column" alignItems="flex-end" gap={1}>
      {toasts.map((toast) => (
        <box
          key={toast.id}
          border
          borderStyle="rounded"
          borderColor={toastColor(toast.level, theme)}
          backgroundColor={theme.backgroundPanel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text content={`${toast.extension}: ${toast.message}`} style={{ fg: toastColor(toast.level, theme) }} />
        </box>
      ))}
    </box>
  )
}
