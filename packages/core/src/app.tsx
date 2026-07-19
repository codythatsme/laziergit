import type { PluginErrorEvent } from "@opentui/core"
import { Slot, useKeyboard, useRenderer } from "@opentui/react"
import { basename } from "node:path"
import { useSyncExternalStore } from "react"

import type { ExtensionKernel } from "./extension/kernel"
import type { PaneEntry } from "./extension/pane-host"
import { defaultTheme as theme } from "./extension/theme"

function stateColor(state: "loading" | "active" | "failed" | "shadowed") {
  if (state === "active") return theme.success
  if (state === "failed") return theme.danger
  if (state === "shadowed") return theme.warning
  return theme.info
}

function PaneErrorCard({ failure }: { failure: PluginErrorEvent }) {
  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" padding={1}>
      <text content="Pane crashed" style={{ fg: theme.danger }} />
      <text content={failure.error.message} style={{ fg: theme.textMuted, marginTop: 1 }} />
      <text content="Save the Extension to retry" style={{ fg: theme.info, marginTop: 1 }} />
    </box>
  )
}

function DebugPane({ kernel, pane }: { kernel: ExtensionKernel; pane: PaneEntry }) {
  const focused = kernel.panes.focused === pane.id

  return (
    <box
      flexGrow={1}
      minWidth={24}
      border
      borderStyle="rounded"
      borderColor={focused ? theme.borderFocused : theme.border}
      title={` ${pane.title} · ${pane.id} `}
      padding={1}
    >
      {pane.state === "reloading" ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text content="reloading…" style={{ fg: theme.info }} />
        </box>
      ) : (
        <Slot
          registry={kernel.panes.registry}
          name={pane.id}
          mode="single_winner"
          paneId={pane.id}
          focused={focused}
          pluginFailurePlaceholder={(failure) => <PaneErrorCard failure={failure} />}
        >
          <text content="Pane registered no content" style={{ fg: theme.textMuted }} />
        </Slot>
      )}
    </box>
  )
}

export function App({ kernel }: { kernel: ExtensionKernel }) {
  const renderer = useRenderer()
  const extensions = useSyncExternalStore(kernel.subscribe, kernel.getSnapshot, kernel.getSnapshot)
  const panes = useSyncExternalStore(kernel.panes.subscribe, kernel.panes.getSnapshot, kernel.panes.getSnapshot)
  const diagnostics = useSyncExternalStore(
    kernel.diagnostics.subscribe,
    kernel.diagnostics.getSnapshot,
    kernel.diagnostics.getSnapshot,
  )

  useKeyboard((key) => {
    if (key.name === "r") void kernel.reload()
    if (key.name === "q") renderer.destroy()
  })

  const active = extensions.filter((extension) => extension.state === "active").length
  const failed = extensions.filter((extension) => extension.state === "failed").length

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} padding={1}>
      <box height={3} flexDirection="row" alignItems="center" paddingLeft={1} paddingRight={1}>
        <text content="laziergit" style={{ fg: theme.accent }} />
        <text
          content={`  M1 extension kernel  ·  ${active} active  ·  ${failed} failed  ·  ${panes.length} panes`}
          style={{ fg: theme.textMuted }}
        />
      </box>

      {panes.length === 0 ? (
        <box flexGrow={1} border borderStyle="rounded" borderColor={theme.border} padding={2} flexDirection="column">
          <text content="No Panes registered" style={{ fg: theme.text }} />
          <text
            content="Drop a .ts or .tsx Extension into ~/.config/laziergit/extensions or .laziergit/extensions"
            style={{ fg: theme.textMuted, marginTop: 1 }}
          />
          {extensions.map((extension) => (
            <text
              key={extension.key}
              content={`${extension.state.padEnd(8)} ${extension.name ?? basename(extension.path)}${extension.message ? ` — ${extension.message}` : ""}`}
              style={{ fg: stateColor(extension.state), marginTop: 1 }}
            />
          ))}
        </box>
      ) : (
        <box flexGrow={1} flexDirection="row" gap={1}>
          {panes.map((pane) => (
            <DebugPane key={pane.id} kernel={kernel} pane={pane} />
          ))}
        </box>
      )}

      <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text content="q quit  ·  r reload  ·  file saves reload automatically" style={{ fg: theme.textMuted }} />
        <text
          content={`${diagnostics.length} diagnostics`}
          style={{ fg: diagnostics.length ? theme.warning : theme.textMuted }}
        />
      </box>
    </box>
  )
}
