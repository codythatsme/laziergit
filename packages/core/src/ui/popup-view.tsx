import { useBindings } from "@opentui/keymap/react"
import { useMemo, useRef, useState, type ReactNode } from "react"
import { useTheme, type Theme } from "laziergit"

import { fuzzyFilter } from "./fuzzy"
import { modalLayerPriority } from "./keybindings"
import type {
  ActionsPopup,
  CheatSheetPopup,
  ChoosePopup,
  ConfirmPopup,
  Popup,
  PopupHost,
  PromptPopup,
} from "./popup-host"
import { useStore } from "./use-store"

const popupWidth = 64
const visibleRows = 10

/** Keeps the cursor inside a scrolling window without moving it more than it must. */
function windowStart(count: number, cursor: number, size: number): number {
  if (count <= size) return 0
  return Math.min(Math.max(0, cursor - Math.floor(size / 2)), count - size)
}

function PopupFrame({
  title,
  footer,
  theme,
  holdsFocus = true,
  children,
}: {
  title: string
  footer: string
  theme: Theme
  /**
   * OpenTUI has one focus slot and React creates children before their parent, so a
   * focusable frame would take focus back from an input it contains. Frames without a
   * text field claim it instead, which is what pulls focus off the Panes underneath.
   */
  holdsFocus?: boolean
  children?: ReactNode
}) {
  return (
    <box
      focusable={holdsFocus}
      focused={holdsFocus}
      width={popupWidth}
      maxWidth="90%"
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={theme.accent}
      focusedBorderColor={theme.accent}
      backgroundColor={theme.backgroundPanel}
      title={` ${title} `}
      titleColor={theme.accent}
      paddingLeft={1}
      paddingRight={1}
    >
      {children}
      <text content={footer} style={{ fg: theme.textMuted, marginTop: 1 }} />
    </box>
  )
}

function ConfirmView({ popup, theme }: { popup: ConfirmPopup; theme: Theme }) {
  useBindings(
    () => ({
      priority: modalLayerPriority,
      bindings: [
        { key: "y", cmd: () => popup.confirm() },
        { key: "return", cmd: () => popup.confirm() },
        { key: "n", cmd: () => popup.dismiss() },
        { key: "escape", cmd: () => popup.dismiss() },
      ],
    }),
    [popup],
  )

  return (
    <PopupFrame title={popup.title} footer={`y ${popup.confirmLabel}  ·  n cancel`} theme={theme}>
      {popup.message === undefined ? null : (
        <text content={popup.message} style={{ fg: popup.danger ? theme.danger : theme.text }} />
      )}
    </PopupFrame>
  )
}

function PromptView({ popup, theme }: { popup: PromptPopup; theme: Theme }) {
  const [value, setValue] = useState(popup.initial)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(value)
  latest.current = value

  // Enter is bound on the modal layer rather than taken from the input's submit event:
  // the JSX namespace merges OpenTUI's `input` with the DOM one, so `onSubmit` has two
  // incompatible signatures. One key path also keeps validation in a single place.
  useBindings(
    () => ({
      priority: modalLayerPriority,
      bindings: [
        { key: "escape", cmd: () => popup.dismiss() },
        {
          key: "return",
          cmd: () => {
            const problem = popup.validate(latest.current)
            if (problem === null) popup.submit(latest.current)
            else setError(problem)
          },
        },
      ],
    }),
    [popup],
  )

  return (
    <PopupFrame title={popup.title} footer="enter submit  ·  escape cancel" theme={theme} holdsFocus={false}>
      <input
        focused
        width="100%"
        value={value}
        placeholder={popup.placeholder ?? ""}
        onInput={(next: string) => {
          setValue(next)
          setError(null)
        }}
      />
      {error === null ? null : <text content={error} style={{ fg: theme.danger }} />}
    </PopupFrame>
  )
}

function ChooseView({ popup, theme }: { popup: ChoosePopup; theme: Theme }) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)

  const matches = useMemo(() => fuzzyFilter(popup.choices, query, (choice) => choice.label), [popup, query])
  const clamped = Math.min(cursor, Math.max(0, matches.length - 1))
  const state = useRef({ matches, cursor: clamped })
  state.current = { matches, cursor: clamped }

  useBindings(
    () => ({
      priority: modalLayerPriority,
      bindings: [
        { key: "escape", cmd: () => popup.dismiss() },
        { key: "up", cmd: () => setCursor((current) => Math.max(0, current - 1)) },
        {
          key: "down",
          cmd: () => setCursor((current) => Math.min(state.current.matches.length - 1, current + 1)),
        },
        {
          key: "return",
          cmd: () => {
            const match = state.current.matches[state.current.cursor]
            if (match) popup.choose(match.index)
          },
        },
      ],
    }),
    [popup],
  )

  const start = windowStart(matches.length, clamped, visibleRows)
  const window = matches.slice(start, start + visibleRows)

  return (
    <PopupFrame title={popup.title} footer="↑↓ move  ·  enter run  ·  escape cancel" theme={theme} holdsFocus={false}>
      <input
        focused
        width="100%"
        value={query}
        placeholder={popup.placeholder ?? "Filter"}
        onInput={(next) => {
          setQuery(next)
          setCursor(0)
        }}
      />
      {matches.length === 0 ? (
        <text content="no matches" style={{ fg: theme.textMuted }} />
      ) : (
        window.map((match, offset) => {
          const selected = start + offset === clamped
          return (
            <box key={match.index} flexDirection="row" justifyContent="space-between">
              <text
                content={`${selected ? "❯ " : "  "}${match.item.label}`}
                style={{ fg: selected ? theme.text : theme.textMuted, bg: selected ? theme.selection : undefined }}
              />
              {match.item.hint === undefined ? null : (
                <text content={match.item.hint} style={{ fg: theme.textMuted }} />
              )}
            </box>
          )
        })
      )}
    </PopupFrame>
  )
}

function ActionsView({ popup, theme }: { popup: ActionsPopup; theme: Theme }) {
  useBindings(
    () => ({
      priority: modalLayerPriority,
      bindings: [
        { key: "escape", cmd: () => popup.dismiss() },
        ...popup.groups.flatMap((group) =>
          group.items.map((item) => ({
            key: item.key,
            cmd: () => {
              // The menu closes before its action runs, so a slow action never leaves a
              // dead menu on screen and cannot receive a second keypress.
              popup.dismiss()
              void item.run()
            },
          })),
        ),
      ],
    }),
    [popup],
  )

  return (
    <PopupFrame title={popup.title} footer="escape cancel" theme={theme}>
      {popup.groups.map((group, index) => (
        <box key={group.title ?? `group-${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          {group.title === undefined ? null : <text content={group.title} style={{ fg: theme.textMuted }} />}
          {group.items.map((item) => (
            <text key={item.key} content={`  ${item.key}  ${item.label}`} style={{ fg: theme.text }} />
          ))}
        </box>
      ))}
    </PopupFrame>
  )
}

function CheatSheetView({ popup, theme }: { popup: CheatSheetPopup; theme: Theme }) {
  const [offset, setOffset] = useState(0)
  const rows = popup.sections.flatMap((section) => [
    { kind: "section" as const, text: section.title },
    ...section.entries.map((entry) => ({
      kind: "entry" as const,
      text: `  ${entry.keys.join(" / ").padEnd(12)} ${entry.title}`,
    })),
  ])
  const state = useRef({ rows: rows.length, offset })
  state.current = { rows: rows.length, offset }

  useBindings(
    () => ({
      priority: modalLayerPriority,
      bindings: [
        { key: "escape", cmd: () => popup.dismiss() },
        { key: "q", cmd: () => popup.dismiss() },
        { key: "up", cmd: () => setOffset((current) => Math.max(0, current - 1)) },
        {
          key: "down",
          cmd: () => setOffset((current) => Math.min(Math.max(0, state.current.rows - visibleRows), current + 1)),
        },
      ],
    }),
    [popup],
  )

  return (
    <PopupFrame title={popup.title} footer="↑↓ scroll  ·  escape close" theme={theme}>
      {rows.slice(offset, offset + visibleRows).map((row, index) => (
        <text
          key={offset + index}
          content={row.text}
          style={{ fg: row.kind === "section" ? theme.accent : theme.text }}
        />
      ))}
    </PopupFrame>
  )
}

function PopupView({ popup }: { popup: Popup }) {
  const theme = useTheme()

  switch (popup.kind) {
    case "confirm":
      return <ConfirmView popup={popup} theme={theme} />
    case "prompt":
      return <PromptView popup={popup} theme={theme} />
    case "choose":
      return <ChooseView popup={popup} theme={theme} />
    case "actions":
      return <ActionsView popup={popup} theme={theme} />
    case "cheatsheet":
      return <CheatSheetView popup={popup} theme={theme} />
  }
}

/**
 * The modal layer. Only the top popup renders and binds keys, so a nested flow can
 * never route a keypress into the popup underneath it.
 */
export function PopupLayer({ popups }: { popups: PopupHost }) {
  const stack = useStore(popups)
  const top = stack[stack.length - 1]
  if (!top) return null

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      right={0}
      bottom={0}
      zIndex={20}
      alignItems="center"
      justifyContent="center"
    >
      <PopupView key={top.id} popup={top} />
    </box>
  )
}
