import { MouseButton, type PluginErrorEvent } from "@opentui/core"
import { Slot } from "@opentui/react"
import type { ReactNode } from "react"
import { useTheme, type Theme } from "laziergit"

import type { PaneEntry, PaneHost } from "../extension/pane-host"
import type { LayoutHost, ResolvedCell } from "./layout"
import { useStore } from "./use-store"

function PaneErrorCard({ failure }: { failure: PluginErrorEvent }) {
  const theme = useTheme()
  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" padding={1}>
      <text content="Pane crashed" style={{ fg: theme.danger }} />
      <text content={failure.error.message} style={{ fg: theme.textMuted, marginTop: 1 }} />
      <text content="Save the Extension to retry" style={{ fg: theme.info, marginTop: 1 }} />
    </box>
  )
}

/** Tab titles for a cell; the visible one is bracketed so it reads without color. */
function cellTitle(entries: readonly PaneEntry[], activeId: string): string {
  if (entries.length === 1) return entries[0]?.title ?? activeId
  return entries.map((entry) => (entry.id === activeId ? `[${entry.title}]` : entry.title)).join(" ")
}

function PaneFrame({
  cell,
  layout,
  panes,
  entries,
  activeId,
  focused,
  theme,
}: {
  cell: ResolvedCell
  layout: LayoutHost
  panes: PaneHost
  entries: readonly PaneEntry[]
  activeId: string
  focused: boolean
  theme: Theme
}) {
  const active = entries.find((entry) => entry.id === activeId)
  if (!active) return null

  return (
    <box
      flexGrow={1}
      flexBasis={0}
      minHeight={3}
      border
      borderStyle="rounded"
      borderColor={focused ? theme.borderFocused : theme.border}
      title={` ${cellTitle(entries, active.id)} `}
      titleColor={focused ? theme.accent : theme.textMuted}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT) layout.focus(active.id)
      }}
    >
      {active.state === "reloading" ? (
        // Top-left and muted, in the slot the Pane's first row just vacated: centring it
        // makes the text jump for the half-second a reload takes.
        <text content="reloading…" style={{ fg: theme.textMuted }} />
      ) : (
        <Slot
          key={cell.key}
          registry={panes.registry}
          name={active.id}
          mode="single_winner"
          paneId={active.id}
          focused={focused}
          pluginFailurePlaceholder={(failure) => <PaneErrorCard failure={failure} />}
        >
          <text content="Pane registered no content" style={{ fg: theme.textMuted }} />
        </Slot>
      )}
    </box>
  )
}

function EmptyLayout({ theme, fallback }: { theme: Theme; fallback?: ReactNode }) {
  return (
    <box
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      flexDirection="column"
      gap={1}
    >
      <text content="No Panes registered" style={{ fg: theme.text }} />
      <text
        content="Drop a .ts or .tsx Extension into ~/.config/laziergit/extensions or .laziergit/extensions"
        style={{ fg: theme.textMuted }}
      />
      {fallback}
    </box>
  )
}

/** The screen: columns of cells, each cell a tab group with one visible Pane. */
export function LayoutView({ layout, panes, fallback }: { layout: LayoutHost; panes: PaneHost; fallback?: ReactNode }) {
  const theme = useTheme()
  const view = useStore(layout)
  const registered = useStore(panes)

  if (view.layout.columns.length === 0) return <EmptyLayout theme={theme} fallback={fallback} />

  return (
    <box flexGrow={1} flexDirection="row">
      {view.layout.columns.map((column, index) => (
        // Cells stack border-to-border: a blank row between them costs a short Pane a third
        // of its content, and rounded borders already separate one Pane from the next.
        <box key={`column-${index}`} flexGrow={column.weight} flexBasis={0} flexDirection="column">
          {column.cells.map((cell) => {
            const entries = cell.paneIds.flatMap((paneId) => {
              const entry = registered.find((candidate) => candidate.id === paneId)
              return entry ? [entry] : []
            })
            const activeId = view.activeTabs.get(cell.key) ?? entries[0]?.id
            if (activeId === undefined) return null
            return (
              <PaneFrame
                key={cell.key}
                cell={cell}
                layout={layout}
                panes={panes}
                entries={entries}
                activeId={activeId}
                focused={view.focusedPaneId === activeId}
                theme={theme}
              />
            )
          })}
        </box>
      ))}
    </box>
  )
}
