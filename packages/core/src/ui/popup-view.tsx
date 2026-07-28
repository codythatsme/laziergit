import { useTerminalDimensions } from "@opentui/react"
import { useBindings } from "@opentui/keymap/react"
import type { InputKeyBinding } from "@opentui/core"
import { useMemo, useRef, useState, type ReactNode } from "react"
import { useTheme, type Theme } from "laziergit"

import { fuzzyFilter, type FuzzyResult } from "./fuzzy"
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
const textInputKeyBindings = [
  { name: "backspace", super: true, action: "delete-to-line-start" },
  { name: "delete", super: true, action: "delete-to-line-end" },
] satisfies InputKeyBinding[]

/**
 * The rows a popup frame spends on itself: two borders, the padding line under the title,
 * and the footer with its margin. Subtracted from the terminal height, plus a little air, to
 * size a list that would otherwise scroll for no reason.
 */
const popupChrome = 5

/**
 * How many rows the cheat sheet may draw, given the terminal it is drawn in. A floor of six
 * keeps it a popup rather than a full-screen takeover on a very short terminal, where
 * scrolling is the honest fallback.
 */
function sheetRows(height: number): number {
  return Math.max(6, height - popupChrome - 4)
}

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
      // The title is drawn *in* the top border, so without this the first line of a popup's
      // body sits directly under it and the two read as one block.
      paddingTop={1}
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
  /**
   * What `return` submits — written by the input handler below, not during render. A keypress
   * is not a React event: the binding runs on the modal key layer the moment the byte arrives,
   * so Enter in the same tick as the keystroke before it would otherwise read whatever the
   * last render left behind. Rare by hand, certain on a paste.
   */
  const latest = useRef(popup.initial)

  // Enter is bound on the modal layer rather than taken from the input's submit event: the JSX
  // namespace merges OpenTUI's `input` with the DOM one, so `onSubmit` has two incompatible
  // signatures. One key path also keeps validation in a single place.
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
        keyBindings={textInputKeyBindings}
        onInput={(next: string) => {
          latest.current = next
          setValue(next)
          setError(null)
        }}
      />
      {error === null ? null : <text content={error} style={{ fg: theme.danger }} />}
    </PopupFrame>
  )
}

/** One definition, so the render and the key handlers can never disagree on what matches. */
function filterChoices(popup: ChoosePopup, query: string): readonly FuzzyResult<ChoosePopup["choices"][number]>[] {
  return fuzzyFilter(popup.choices, query, (choice) => choice.label)
}

function ChooseView({ popup, theme }: { popup: ChoosePopup; theme: Theme }) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)

  const matches = useMemo(() => filterChoices(popup, query), [popup, query])
  const clamped = Math.min(cursor, Math.max(0, matches.length - 1))

  /**
   * The filter and the row the key handlers act on, written by those handlers rather than
   * mirrored during render — see {@link PromptView}'s `latest` for the window this closes. It
   * matters more here: this is the component behind both the command palette and every
   * `select`, so a stale read runs a different row, and the rows include force-push and hard
   * reset.
   */
  const state = useRef({ query: "", cursor: 0 })

  useBindings(() => {
    const move = (delta: number): void => {
      const list = filterChoices(popup, state.current.query)
      const next = Math.min(Math.max(0, state.current.cursor + delta), Math.max(0, list.length - 1))
      state.current = { ...state.current, cursor: next }
      setCursor(next)
    }
    return {
      priority: modalLayerPriority,
      bindings: [
        { key: "escape", cmd: () => popup.dismiss() },
        { key: "up", cmd: () => move(-1) },
        { key: "down", cmd: () => move(1) },
        {
          key: "return",
          cmd: () => {
            const list = filterChoices(popup, state.current.query)
            const match = list[Math.min(state.current.cursor, Math.max(0, list.length - 1))]
            if (match) popup.choose(match.index)
          },
        },
      ],
    }
  }, [popup])

  const start = windowStart(matches.length, clamped, visibleRows)
  const window = matches.slice(start, start + visibleRows)

  return (
    <PopupFrame title={popup.title} footer="↑↓ move  ·  enter run  ·  escape cancel" theme={theme} holdsFocus={false}>
      <input
        focused
        width="100%"
        value={query}
        placeholder={popup.placeholder ?? "Filter"}
        keyBindings={textInputKeyBindings}
        onInput={(next) => {
          state.current = { query: next, cursor: 0 }
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

  // One key column for the whole menu, measured across every group: a `shift+d` beside an `s`
  // otherwise pushes its own label six columns right and the labels stop forming a column.
  const keyWidth = Math.max(0, ...popup.groups.flatMap((group) => group.items.map((item) => item.key.length)))

  return (
    <PopupFrame title={popup.title} footer="escape cancel" theme={theme}>
      {popup.groups.map((group, index) => (
        <box key={group.title ?? `group-${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          {group.title === undefined ? null : <text content={group.title} style={{ fg: theme.textMuted }} />}
          {group.items.map((item) => (
            <text key={item.key} content={`  ${item.key.padEnd(keyWidth)}  ${item.label}`} style={{ fg: theme.text }} />
          ))}
        </box>
      ))}
    </PopupFrame>
  )
}

function CheatSheetView({ popup, theme }: { popup: CheatSheetPopup; theme: Theme }) {
  const [offset, setOffset] = useState(0)
  const window = sheetRows(useTerminalDimensions().height)
  const rows = popup.sections.flatMap((section) => [
    { kind: "section" as const, text: section.title },
    ...section.entries.map((entry) => ({
      kind: "entry" as const,
      text: `  ${entry.keys.join(" / ").padEnd(12)} ${entry.title}`,
    })),
  ])
  // The window is read through a ref rather than closed over, so a resize while the sheet is
  // open cannot leave the down key scrolling against the height the terminal used to have.
  const state = useRef({ rows: rows.length, window, offset })
  state.current = { rows: rows.length, window, offset }

  useBindings(
    () => ({
      priority: modalLayerPriority,
      bindings: [
        { key: "escape", cmd: () => popup.dismiss() },
        { key: "q", cmd: () => popup.dismiss() },
        { key: "up", cmd: () => setOffset((current) => Math.max(0, current - 1)) },
        {
          key: "down",
          cmd: () =>
            setOffset((current) => Math.min(Math.max(0, state.current.rows - state.current.window), current + 1)),
        },
      ],
    }),
    [popup],
  )

  return (
    <PopupFrame title={popup.title} footer="↑↓ scroll  ·  escape close" theme={theme}>
      {rows.slice(offset, offset + window).map((row, index) => (
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
