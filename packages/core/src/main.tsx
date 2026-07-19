import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

import { App } from "./app"

export async function main() {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App />)
}

if (import.meta.main) {
  await main()
}
