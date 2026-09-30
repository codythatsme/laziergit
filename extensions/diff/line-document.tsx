/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react"

interface LineStyle {
  readonly fg: string
  readonly bg?: string
}

interface LineDocumentProps {
  readonly count: number
  readonly lineAt: (index: number) => string
  readonly styleAt: (index: number) => LineStyle
}

/** One native text buffer for the document; adjacent lines share a styled span. */
export function LineDocument({ count, lineAt, styleAt }: LineDocumentProps): ReactNode {
  const result: ReactNode[] = []
  let style: LineStyle | undefined
  let lines: string[] = []
  const flush = (): void => {
    if (style === undefined) return
    result.push(
      <span key={result.length} fg={style.fg} bg={style.bg}>
        {lines.join("")}
      </span>,
    )
    lines = []
  }
  for (let index = 0; index < count; index += 1) {
    const next = styleAt(index)
    if (next.fg !== style?.fg || next.bg !== style?.bg) {
      flush()
      style = next
    }
    const line = lineAt(index).replace(/\r?\n$|\r$/, "") || " "
    lines.push(index < count - 1 ? `${line}\n` : line)
  }
  flush()

  return <text wrapMode="none">{result}</text>
}
