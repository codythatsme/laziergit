/** @jsxImportSource @opentui/react */
import type { ScrollView } from "laziergit"
import type { ScrollBoxProps } from "@opentui/react"
import { useCallback, useMemo, useRef, useState, type Ref, type ReactNode } from "react"

type ScrollNode = ScrollBoxProps["ref"] extends Ref<infer Node> | undefined ? Node : never

interface LineStyle {
  readonly fg: string
  readonly bg?: string
}

interface LineDocumentProps<T> {
  readonly lines: readonly T[]
  readonly textOf: (line: T) => string
  readonly styleAt: (index: number) => LineStyle
  readonly scroll: ScrollView
}

/** Keep native text and highlights bounded by the viewport, with the full document's scroll extent. */
export function LineDocument<T>({ lines, textOf, styleAt, scroll }: LineDocumentProps<T>): ReactNode {
  const document = useMemo(() => {
    const text = lines.map((line) => textOf(line).replace(/\r?\n$|\r$/, "") || " ")
    // OpenTUI's text buffers use two columns per tab.
    const width = text.reduce((max, line) => Math.max(max, Bun.stringWidth(line.replaceAll("\t", "  "))), 1)
    return { text, width }
  }, [lines, textOf])
  const [viewport, setViewport] = useState({ top: 0, rows: 0 })
  const detach = useRef<(() => void) | null>(null)
  const ref = useCallback(
    (node: ScrollNode | null) => {
      detach.current?.()
      detach.current = null
      scroll.ref(node)
      if (node === null) return
      const sync = (): void => {
        const top = Math.max(0, Math.floor(node.scrollTop))
        const rows = node.viewport.height
        setViewport((previous) => (previous.top === top && previous.rows === rows ? previous : { top, rows }))
      }
      node.verticalScrollBar.on("change", sync)
      node.viewport.on("resize", sync)
      detach.current = () => {
        node.verticalScrollBar.off("change", sync)
        node.viewport.off("resize", sync)
      }
      sync()
    },
    [scroll],
  )

  const top = Math.min(viewport.top, Math.max(0, lines.length - 1))
  const start = Math.max(0, top - 2)
  const end = Math.min(lines.length, top + Math.max(1, viewport.rows) + 2)
  const spans: ReactNode[] = []
  let style: LineStyle | undefined
  let run: string[] = []
  const flush = (): void => {
    if (style === undefined) return
    spans.push(
      <span key={spans.length} fg={style.fg} bg={style.bg}>
        {run.join("")}
      </span>,
    )
    run = []
  }
  for (let index = start; index < end; index += 1) {
    const next = styleAt(index)
    if (next.fg !== style?.fg || next.bg !== style?.bg) {
      flush()
      style = next
    }
    const line = document.text[index] ?? " "
    run.push(index < end - 1 ? `${line}\n` : line)
  }
  flush()

  return (
    <scrollbox ref={ref} focusable={false} scrollX flexGrow={1} flexBasis={0}>
      <box height={lines.length} width={document.width} minWidth="100%" flexShrink={0}>
        <text position="absolute" top={start} height={end - start} width="100%" wrapMode="none">
          {spans}
        </text>
      </box>
    </scrollbox>
  )
}
