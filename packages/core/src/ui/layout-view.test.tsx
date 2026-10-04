import { expect, it } from "bun:test"
import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"

import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  renderApp,
  settle,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

const source = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useListCursor } from "laziergit"

  export default defineExtension({
    name: "lists",
    activate(ctx) {
      for (const name of ["files", "branches", "remotes", "stash", "diff", "details"]) {
        const id = "lists." + name
        function Pane() {
          const cursor = useListCursor({ items: Array.from({ length: 40 }, (_, i) => i), idPrefix: id, noun: "row" })
          return <scrollbox id={id + ".scroll"} ref={cursor.scrollRef} flexGrow={1} flexBasis={0}>
            {cursor.items.map((row, i) => <text key={row} id={cursor.rowId(i)}
              content={(cursor.index === i ? "> " : "  ") + name + " " + row} />)}
          </scrollbox>
        }
        ctx.panes.register({ id, title: name, component: Pane })
      }
    },
  })
`

async function renderLayout(height: number): Promise<Harness> {
  const harness = await createHarness({ width: 100, height })
  await writeFile(join(harness.repo, "lists.tsx"), source)
  await writeFile(
    harness.configFiles.repo,
    JSON.stringify({
      layout: {
        columns: [
          ["lists.files", ["lists.branches", "lists.remotes"], "lists.stash"],
          ["lists.diff", "lists.details"],
        ],
      },
    }),
  )
  await renderApp(harness)
  return harness
}

function cell(harness: Harness, column: number, index: number): BoxRenderable {
  const box = harness.setup.renderer.root.findDescendantById(`pane-frame:layout:${column}.${index}`)
  if (!(box instanceof BoxRenderable)) throw new Error("Pane frame did not render")
  return box
}

function sideHeights(harness: Harness): number[] {
  return [0, 1, 2].map((index) => cell(harness, 0, index).height)
}

it("redistributes side heights on keyboard and mouse focus, preserving the working pane in the detail view", async () => {
  const harness = await renderLayout(41)
  expect(sideHeights(harness)).toEqual([20, 10, 10])
  expect([cell(harness, 1, 0).height, cell(harness, 1, 1).height]).toEqual([20, 20])

  await press(harness, () => harness.setup.mockInput.pressTab())
  await waitFor(harness, () => harness.kernel.layout.focusedPaneId === "lists.branches", "branches focus")
  expect(sideHeights(harness)).toEqual([10, 20, 10])
  await press(harness, "2")
  await waitFor(harness, () => harness.kernel.layout.focusedPaneId === "lists.remotes", "remote tab focus")
  expect(harness.kernel.layout.focusedPaneId).toBe("lists.remotes")
  expect(sideHeights(harness)).toEqual([10, 20, 10])

  await press(harness, "4")
  await waitFor(harness, () => harness.kernel.layout.focusedPaneId === "lists.diff", "diff focus")
  expect(harness.kernel.layout.focusedPaneId).toBe("lists.diff")
  expect(sideHeights(harness)).toEqual([10, 20, 10])
  expect([cell(harness, 1, 0).height, cell(harness, 1, 1).height]).toEqual([20, 20])

  const stash = cell(harness, 0, 2)
  await act(async () => {
    await harness.setup.mockMouse.click(stash.x + 2, stash.y)
  })
  await settle(harness)
  expect(harness.kernel.layout.focusedPaneId).toBe("lists.stash")
  expect(sideHeights(harness)).toEqual([10, 10, 20])
})

it("gives the working pane room on short terminals and lets a collapsed title receive focus", async () => {
  const harness = await renderLayout(14)
  expect(sideHeights(harness)).toEqual([7, 3, 3])
  await act(async () => {
    harness.setup.resize(100, 10)
  })
  await settle(harness)
  expect(sideHeights(harness)).toEqual([7, 1, 1])
  expect(frame(harness)).toContain("stash")

  const branches = cell(harness, 0, 1)
  await act(async () => {
    await harness.setup.mockMouse.click(branches.x + 2, branches.y)
  })
  await settle(harness)
  expect(harness.kernel.layout.focusedPaneId).toBe("lists.branches")
  expect(sideHeights(harness)).toEqual([1, 7, 1])
  expect(frame(harness)).toContain("> branches 0")

  await act(async () => {
    harness.setup.resize(100, 41)
  })
  await settle(harness)
  expect(sideHeights(harness)).toEqual([10, 20, 10])
})

it("keeps a scrolled list mounted and its selected row visible after collapsing and expanding", async () => {
  const harness = await renderLayout(41)
  await press(harness, "g", { shift: true })
  await waitForFrame(harness, "> files 39")
  const scroll = harness.setup.renderer.root.findDescendantById("lists.files.scroll")
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Files list did not render")
  expect(scroll.scrollTop).toBeGreaterThan(0)

  await press(harness, "2")
  await waitFor(harness, () => harness.kernel.layout.focusedPaneId === "lists.branches", "branches focus")
  await act(async () => {
    harness.setup.resize(100, 10)
  })
  await settle(harness)
  await press(harness, "1")
  await waitFor(harness, () => harness.kernel.layout.focusedPaneId === "lists.files", "files focus")
  expect(harness.setup.renderer.root.findDescendantById("lists.files.scroll")).toBe(scroll)
  expect(frame(harness)).toContain("> files 39")
  expect(scroll.scrollTop).toBeGreaterThan(0)
})
