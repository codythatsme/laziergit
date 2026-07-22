import { KeymapProvider } from "@opentui/keymap/react"
import { RuntimeProvider } from "@laziergit/runtime-bridge"
import { basename } from "node:path"
import { useTheme, type Theme } from "laziergit"

import type { ExtensionKernel, ExtensionLoadState } from "./extension/kernel"
import { LayoutView } from "./ui/layout-view"
import { PopupLayer } from "./ui/popup-view"
import { StatuslineView, ToastLayer } from "./ui/statusline-view"
import { useStore } from "./ui/use-store"

function stateColor(state: ExtensionLoadState, theme: Theme): string {
  if (state === "active") return theme.success
  if (state === "failed") return theme.danger
  if (state === "shadowed") return theme.warning
  return theme.info
}

/** Shown in place of the Layout while nothing has registered a Pane yet. */
function ExtensionStatusList({ kernel }: { kernel: ExtensionKernel }) {
  const theme = useTheme()
  const extensions = useStore(kernel)

  return (
    <box flexDirection="column">
      {extensions.map((extension) => (
        <text
          key={extension.key}
          content={`${extension.state.padEnd(8)} ${extension.name ?? basename(extension.path)}${
            extension.message ? ` — ${extension.message}` : ""
          }`}
          style={{ fg: stateColor(extension.state, theme) }}
        />
      ))}
    </box>
  )
}

function AppShell({ kernel }: { kernel: ExtensionKernel }) {
  const theme = useTheme()

  return (
    <box width="100%" height="100%" backgroundColor={theme.background}>
      <box flexGrow={1} flexDirection="column" padding={1} gap={1}>
        <LayoutView layout={kernel.layout} panes={kernel.panes} fallback={<ExtensionStatusList kernel={kernel} />} />
        <StatuslineView statusline={kernel.statusline} panes={kernel.panes} />
      </box>
      <ToastLayer notifications={kernel.notifications} />
      <PopupLayer popups={kernel.popups} />
    </box>
  )
}

export function App({ kernel }: { kernel: ExtensionKernel }) {
  return (
    <RuntimeProvider runtime={kernel.runtime}>
      <KeymapProvider keymap={kernel.keymap}>
        <AppShell kernel={kernel} />
      </KeymapProvider>
    </RuntimeProvider>
  )
}
