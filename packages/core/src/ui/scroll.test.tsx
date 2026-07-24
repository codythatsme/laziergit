import { expect, it } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

/**
 * More rows than any terminal these tests run in, so "the cursor is on screen" can only be
 * true because something scrolled.
 */
const rowCount = 60

/**
 * A list Pane built the way the four Bundled ones are: `useListCursor` for the cursor, a
 * `<scrollbox>` for the rows, and a header above it that the box must not paint over.
 */
const listExtension = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useListCursor } from "laziergit"

  const rows = Array.from({ length: ${rowCount} }, (_, index) => "row " + (index + 1))

  export default defineExtension({
    name: "list",
    activate(ctx) {
      function ListPane() {
        const cursor = useListCursor({ items: rows, idPrefix: "list", noun: "row" })
        return (
          <box flexDirection="column" flexGrow={1} flexBasis={0}>
            <text content="LIST HEADER" />
            <scrollbox ref={cursor.scrollRef} flexGrow={1} flexBasis={0}>
              {rows.map((row, index) => (
                <text key={row} content={(index === cursor.index ? "> " : "  ") + row} />
              ))}
            </scrollbox>
          </box>
        )
      }
      ctx.panes.register({ id: "list", title: "List", component: ListPane })
    },
  })
`

/** A patch tall enough that its tail is nowhere near the first screenful. */
const patch = [
  "diff --git a/f.txt b/f.txt",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  `+++ b/f.txt`,
  `@@ -0,0 +1,${rowCount} @@`,
  ...Array.from({ length: rowCount }, (_, index) => `+patch ${index + 1}`),
].join("\\n")

/**
 * The diff Pane's shape: a `<diff>`, which has no scroll API of its own, inside the
 * `<scrollbox>` that gives it one.
 */
const patchExtension = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useCommand, useScrollView } from "laziergit"

  const patch = "${patch}\\n"

  export default defineExtension({
    name: "patch",
    activate(ctx) {
      function PatchPane() {
        const scroll = useScrollView()
        useCommand({
          id: "patch.page-down",
          title: "Page down",
          keys: "d",
          run: () => scroll.scrollBy(scroll.viewportRows()),
        })
        useCommand({ id: "patch.end", title: "End", keys: "e", run: () => scroll.scrollTo("end") })
        useCommand({ id: "patch.start", title: "Start", keys: "s", run: () => scroll.scrollTo("start") })
        return (
          <box flexDirection="column" flexGrow={1} flexBasis={0}>
            <text content="PATCH HEADER" />
            <scrollbox ref={scroll.ref} flexGrow={1} flexBasis={0}>
              <diff diff={patch} view="unified" />
            </scrollbox>
          </box>
        )
      }
      ctx.panes.register({ id: "patch", title: "Patch", component: PatchPane })
    },
  })
`

/** A key press, plus enough real time for the terminal parser to disambiguate it. */
async function press(harness: Harness, key: string): Promise<void> {
  await act(async () => {
    harness.setup.mockInput.pressKey(key)
    await Bun.sleep(60)
  })
  await settle(harness)
}

async function start(harness: Harness, name: string, source: string): Promise<void> {
  await writeFile(join(harness.repo, `${name}.tsx`), source)
  await renderApp(harness)
}

it("scrolls the selected row into view when the cursor walks past the bottom of the pane", async () => {
  const harness = await createHarness({ width: 40, height: 16 })
  await start(harness, "list", listExtension)

  // The starting screenful, and the proof that the viewport really is far short of the list.
  // The trailing space matters: without it "row 1" also matches "row 19".
  expect(frame(harness)).toContain("> row 1 ")
  expect(frame(harness)).not.toContain(`row ${rowCount} `)

  await press(harness, "G")

  // What the user has to be able to see: the row every key now acts on.
  expect(frame(harness)).toContain(`> row ${rowCount} `)
  // ...and the top of the list is genuinely gone, so this is scrolling and not a taller box.
  expect(frame(harness)).not.toContain("row 1 ")
  // The Pane's own header survived: a scrollbox sized by its content overflows its Pane and
  // paints across whatever is above it.
  expect(frame(harness)).toContain("LIST HEADER")

  await press(harness, "g")
  expect(frame(harness)).toContain("> row 1 ")
})

it("walks the cursor back into view one row at a time from the far end", async () => {
  const harness = await createHarness({ width: 40, height: 16 })
  await start(harness, "list", listExtension)
  await press(harness, "G")

  await press(harness, "k")
  // Minimum movement: the row above the last is revealed by scrolling one row, so the last
  // row is still on screen rather than the window recentring on the cursor.
  expect(frame(harness)).toContain(`> row ${rowCount - 1} `)
  expect(frame(harness)).toContain(`row ${rowCount} `)
})

it("scrolls a diff taller than its pane, which the diff renderable cannot do on its own", async () => {
  const harness = await createHarness({ width: 40, height: 16 })
  await start(harness, "patch", patchExtension)

  expect(frame(harness)).toContain("patch 1 ")
  expect(frame(harness)).not.toContain(`patch ${rowCount} `)
  expect(frame(harness)).toContain("PATCH HEADER")

  await press(harness, "e")
  expect(frame(harness)).toContain(`patch ${rowCount} `)
  expect(frame(harness)).toContain("PATCH HEADER")

  await press(harness, "s")
  expect(frame(harness)).toContain("patch 1 ")

  // A page is a viewport measurement, which is the one thing an Extension cannot compute.
  await press(harness, "d")
  expect(frame(harness)).not.toContain("patch 1 ")
})
