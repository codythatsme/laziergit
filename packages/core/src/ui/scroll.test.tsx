import { expect, it } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  renderApp,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

/**
 * More rows than any terminal these tests run in, so "the cursor is on screen" can only be
 * true because something scrolled.
 */
const rowCount = 60

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

async function start(harness: Harness, name: string, source: string): Promise<void> {
  await writeFile(join(harness.repo, `${name}.tsx`), source)
  await renderApp(harness)
}

it("scrolls a diff taller than its pane, which the diff renderable cannot do on its own", async () => {
  const harness = await createHarness({ width: 40, height: 16 })
  await start(harness, "patch", patchExtension)

  await waitForFrame(harness, "patch 1 ")
  expect(frame(harness)).not.toContain(`patch ${rowCount} `)
  expect(frame(harness)).toContain("PATCH HEADER")

  await press(harness, "e")
  await waitForFrame(harness, `patch ${rowCount} `)
  expect(frame(harness)).toContain("PATCH HEADER")

  await press(harness, "s")
  await waitForFrame(harness, "patch 1 ")

  // A page is a viewport measurement, which is the one thing an Extension cannot compute.
  await press(harness, "d")
  await waitForFrame(harness, (screen) => !screen.includes("patch 1 "))
}, 30_000)
