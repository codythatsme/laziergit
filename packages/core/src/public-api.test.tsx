import { describe, expect, it, spyOn } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"

import {
  createHarness,
  frame,
  installHarnessLifecycle,
  press,
  pressEscape,
  renderApp,
  settle,
  waitForFrame,
  type Harness,
} from "./test-harness"

installHarnessLifecycle()

/**
 * The public helpers the Bundled Extensions are built on — `useListCursor`,
 * `createRowSource`, `toneColor`, `useKeyCapture` — exercised the only way that proves
 * they are public: from real Extensions, through the same loader and the same `"laziergit"`
 * module an author would import.
 */
const rowsSource = `
  /** @jsxImportSource @opentui/react */
  import { createRowSource, defineExtension, toneColor, useCommand, useListCursor, useTheme, type PaneProps } from "laziergit"
  import { useEffect, useState } from "react"

  interface Row { readonly name: string }

  export default defineExtension({
    name: "rows",
    activate(ctx) {
      const host = createRowSource<Row>({ pane: "rows", key: (row) => row.name })

      function RowLine({
        id,
        row,
        selected,
        onSelect,
      }: {
        readonly id: string
        readonly row: Row
        readonly selected: boolean
        readonly onSelect: () => void
      }) {
        const theme = useTheme()
        const decoration = host.useDecoration(row)
        const badge = decoration === undefined ? "" : " [" + (decoration.badge ?? "-") + "/" + (decoration.tone ?? "-") + "]"
        return (
          <text
            id={id}
            fg={toneColor(theme, decoration?.tone)}
            content={(selected ? "> " : "  ") + row.name + badge}
            onMouseDown={onSelect}
          />
        )
      }

      function RowsPane({ focused }: PaneProps) {
        const [items, setItems] = useState<readonly Row[]>([{ name: "one" }, { name: "two" }, { name: "three" }])
        const cursor = useListCursor({
          items,
          idPrefix: "rows",
          noun: "row",
          query: { mode: "filter", fields: (row) => row.name },
        })

        useEffect(() => {
          host.setSelected(cursor.selected)
        }, [cursor.selected])

        // Shrinking keeps the surviving rows' identity, the way the git store does; the
        // replacement is a fresh object per row, so the cache is exercised both ways.
        useCommand({ id: "rows.shrink", title: "Shrink", keys: "s", run: () => setItems(items.slice(0, 1)) })
        useCommand({ id: "rows.grow", title: "Grow", keys: "w",
          run: () => setItems([{ name: "one" }, { name: "two" }, { name: "three" }]) })
        useCommand({ id: "rows.replace", title: "Replace", keys: "r",
          run: () => setItems(items.map((row) => ({ name: row.name }))) })

        return (
          <box flexDirection="column">
            {cursor.items.map((row, index) => (
              <RowLine
                key={row.name}
                id={cursor.rowId(index)}
                row={row}
                selected={index === cursor.index && focused}
                onSelect={() => cursor.setIndex(index)}
              />
            ))}
            <text content={"cursor=" + cursor.index + " selected=" + (cursor.selected?.name ?? "none")} />
          </box>
        )
      }

      ctx.panes.register({ id: "rows", title: "Rows", component: RowsPane })
      return host.api
    },
  })
`

const scrollingRowsSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useListCursor, type PaneProps } from "laziergit"

  const items = Array.from({ length: 30 }, (_, index) => "row-" + String(index).padStart(2, "0"))

  export default defineExtension({
    name: "scrolling-rows",
    activate(ctx) {
      function RowsPane({ focused }: PaneProps) {
        const cursor = useListCursor({ items, idPrefix: "scrolling-rows", noun: "row" })
        return (
          <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
            {items.map((row, index) => (
              <text
                key={row}
                id={cursor.rowId(index)}
                content={(focused && index === cursor.index ? "> " : "  ") + row}
              />
            ))}
          </scrollbox>
        )
      }

      ctx.panes.register({ id: "scrolling-rows", title: "Scrolling rows", component: RowsPane })
    },
  })
`

const decorationsSource = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "decorations",
    needs: ["rows"],
    activate(ctx) {
      const rows = ctx.extensions.get("rows")
      let refreshed = false

      rows.decorateRows((row) => (row.name === "two" ? { badge: "first", tone: "warning" } : undefined))
      const handle = rows.decorateRows((row) => {
        if (row.name === "three") throw new Error("decoration boom")
        return row.name === "two" ? { badge: refreshed ? "late" : "second" } : undefined
      })

      ctx.commands.register({
        id: "decorations.refresh",
        title: "Refresh decorations",
        keys: "shift+r",
        run: () => {
          refreshed = true
          handle.refresh()
        },
      })
      ctx.commands.register({
        id: "decorations.forget",
        title: "Stop decorating",
        keys: "shift+f",
        run: () => handle.dispose(),
      })
      ctx.commands.register({
        id: "decorations.selected",
        title: "Show the selected row",
        keys: "shift+v",
        run: () => ctx.popups.notify("selection is " + (rows.selected()?.name ?? "none")),
      })
    },
  })
`

const editorSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useCommand, useKeyCapture } from "laziergit"
  import { useState } from "react"

  export default defineExtension({
    name: "editor",
    activate(ctx) {
      function EditorPane() {
        const [editing, setEditing] = useState(false)
        const [saved, setSaved] = useState(0)
        useKeyCapture(editing)

        useCommand({ id: "editor.begin", title: "Begin editing", keys: "e", run: () => setEditing(true) })
        useCommand({ id: "editor.submit", title: "Submit message", keys: "mod+s", capture: true,
          run: () => {
            setSaved((count) => count + 1)
            setEditing(false)
          } })
        useCommand({ id: "editor.cancel", title: "Cancel edit", keys: "escape", capture: true,
          run: () => setEditing(false) })

        return <text content={"editor " + (editing ? "editing" : "idle") + " saved=" + saved} />
      }

      ctx.panes.register({ id: "editor", title: "Editor", component: EditorPane })
      ctx.commands.register({
        id: "editor.ask",
        title: "Ask something",
        run: () => ctx.popups.confirm({ title: "Really?" }).then(() => undefined),
      })
    },
  })
`

async function withExtensions(harness: Harness, sources: Record<string, string>, config?: string): Promise<void> {
  await Promise.all([
    ...Object.entries(sources).map(([name, source]) => writeFile(join(harness.repo, name), source)),
    config === undefined ? Promise.resolve() : writeFile(harness.configFiles.repo, config),
  ])
  await renderApp(harness)
}

describe("useListCursor", () => {
  it("keeps two upcoming rows visible by default in every scrolling list", async () => {
    const harness = await createHarness({ height: 12 })
    await withExtensions(harness, { "scrolling-rows.tsx": scrollingRowsSource })
    const names = Array.from({ length: 30 }, (_, index) => `row-${String(index).padStart(2, "0")}`)
    const initiallyVisibleLast = names.findLastIndex((name) => frame(harness).includes(name))
    expect(initiallyVisibleLast).toBeGreaterThan(2)
    expect(initiallyVisibleLast).toBeLessThan(names.length - 2)

    const selectedIndex = initiallyVisibleLast - 1
    for (let index = 0; index < selectedIndex; index += 1) await press(harness, "j")
    await waitForFrame(harness, `> ${names[selectedIndex]}`)

    expect(frame(harness)).toContain(names[selectedIndex + 1] as string)
    expect(frame(harness)).toContain(names[selectedIndex + 2] as string)
  })

  it("moves to the row clicked with the mouse", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    const third = harness.setup.renderer.root.findDescendantById("rows.row.2")
    if (!third) throw new Error("third row did not render")
    await act(async () => {
      await harness.setup.mockMouse.click(third.x, third.y)
    })
    await settle(harness)

    expect(frame(harness)).toContain("cursor=2 selected=three")
  })

  it("clamps to a shrinking list without resurrecting the old position", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, "G")
    await waitForFrame(harness, "cursor=2 selected=three")

    await press(harness, "s")
    await waitForFrame(harness, "cursor=0 selected=one")

    await press(harness, "w")
    await waitForFrame(harness, "three")
    expect(frame(harness)).toContain("cursor=0 selected=one")
  })

  it("keeps its position when the list is replaced with an equal-length one", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, "j")
    await waitForFrame(harness, "cursor=1 selected=two")
    await press(harness, "r")

    expect(frame(harness)).toContain("cursor=1 selected=two")
  })

  it("filters live under capture, keeps the filter on Enter, and preserves selection when cleared", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, "/")
    await waitForFrame(harness, "Filter:")

    // `s` is also the Pane's destructive shrink Command. Capture makes it query text only.
    await press(harness, () => void harness.setup.mockInput.typeText("two"))
    await waitForFrame(harness, "cursor=0 selected=two")
    let rendered = frame(harness)
    expect(rendered).toContain("two")
    expect(rendered).not.toContain("one")
    expect(rendered).not.toContain("three")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "matches for 'two' (1 of 3)")

    await pressEscape(harness)
    await waitForFrame(harness, "cursor=1 selected=two")
    rendered = frame(harness)
    expect(rendered).toContain("one")
    expect(rendered).toContain("three")
    expect(rendered).not.toContain("matches for")
  })

  it("renders an honest empty filter and Escape cancels it", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, "/")
    await waitForFrame(harness, "Filter:")
    await press(harness, () => void harness.setup.mockInput.typeText("missing"))
    await waitForFrame(harness, "cursor=0 selected=none")

    await pressEscape(harness)
    await waitForFrame(harness, "cursor=0 selected=one")
  })

  it("applies text pasted in the same render tick as Enter", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, "/")
    await press(harness, () => {
      void harness.setup.mockInput.typeText("three")
      harness.setup.mockInput.pressEnter()
    })

    await waitForFrame(harness, "matches for 'three' (1 of 3)")
    const rendered = frame(harness)
    expect(rendered).toContain("cursor=0 selected=three")
    expect(rendered).not.toContain("one")
  })

  it("searches without removing rows and cycles relative to ordinary cursor movement", async () => {
    const harness = await createHarness()
    const searchSource = rowsSource.replace('mode: "filter"', 'mode: "search"')
    await withExtensions(harness, { "rows.tsx": searchSource })

    await press(harness, "j")
    await press(harness, "/")
    await press(harness, () => void harness.setup.mockInput.typeText("e"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "matches for 'e' (2 of 2)")
    let rendered = frame(harness)
    expect(rendered).toContain("one")
    expect(rendered).toContain("two")
    expect(rendered).toContain("three")
    expect(rendered).toContain("cursor=2 selected=three")

    await press(harness, "n")
    await waitForFrame(harness, "cursor=0 selected=one")

    // Move below the current match. Previous first returns to that match rather than
    // skipping straight to the match at the other end of the list.
    await press(harness, "j")
    await press(harness, "N")
    await waitForFrame(
      harness,
      (screen) => screen.includes("cursor=0 selected=one") && screen.includes("matches for 'e' (1 of 2)"),
    )

    await press(harness, "N")
    await waitForFrame(harness, "cursor=2 selected=three")

    await press(harness, "/")
    await press(harness, () => {
      void harness.setup.mockInput.typeText("missing")
      harness.setup.mockInput.pressEnter()
    })
    await waitForFrame(harness, "matches for 'missing' (0 of 0)")
    rendered = frame(harness)
    expect(rendered).toContain("cursor=2 selected=three")
    expect(rendered).toContain("one")
    expect(rendered).toContain("two")
  })

  it("continues search from the nearest match crossed by ordinary movement", async () => {
    const harness = await createHarness()
    const threeRows = '[{ name: "one" }, { name: "two" }, { name: "three" }]'
    const fiveRows = '[{ name: "one" }, { name: "two" }, { name: "three" }, { name: "four" }, { name: "five" }]'
    const searchSource = rowsSource.replaceAll(threeRows, fiveRows).replace('mode: "filter"', 'mode: "search"')
    await withExtensions(harness, { "rows.tsx": searchSource })

    await press(harness, "/")
    await press(harness, () => void harness.setup.mockInput.typeText("o"))
    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "cursor=1 selected=two")

    // Moving past `four` makes it the nearest search result. Previous returns there first;
    // retaining the original landing at `two` would incorrectly jump all the way back to it.
    await press(harness, "G")
    await press(harness, "N")
    await waitForFrame(harness, "cursor=3 selected=four")
    expect(frame(harness)).toContain("matches for 'o' (3 of 3)")
  })
})

describe("createRowSource", () => {
  it("merges providers per field, skips one that throws, and re-runs it on refresh", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined)
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource, "decorations.tsx": decorationsSource })

    // Later provider wins the badge; the tone the earlier one set survives, because
    // merging is per field rather than wholesale.
    expect(frame(harness)).toContain("two [second/warning]")
    // The throwing provider is skipped, and the row it threw on simply has no decoration.
    expect(frame(harness)).toContain("three")
    expect(frame(harness)).not.toContain("three [")
    expect(warnSpy).toHaveBeenCalled()

    await press(harness, "R")
    await waitForFrame(harness, "two [late/warning]")
    warnSpy.mockRestore()
  })

  it("stops calling a provider the moment its registration is disposed", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined)
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource, "decorations.tsx": decorationsSource })

    expect(frame(harness)).toContain("two [second/warning]")

    // Disposal is how a deactivating Extension's providers stop being called: its ctx scope
    // disposes exactly this handle.
    await press(harness, "F")
    await waitForFrame(harness, "two [first/warning]")

    // And a refresh on the dead registration neither throws nor revives it.
    await press(harness, "R")
    expect(frame(harness)).toContain("two [first/warning]")
    expect(harness.kernel.diagnostics.getSnapshot()).toEqual([])
    warnSpy.mockRestore()
  })

  it("hands the row the cursor is on to the consuming Extension", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource, "decorations.tsx": decorationsSource })

    await press(harness, "V")
    await waitForFrame(harness, "selection is one")

    await press(harness, "j")
    await press(harness, "V")
    await waitForFrame(harness, "selection is two")
  })
})

describe("useKeyCapture", () => {
  it("still lets a popup outrank the capture", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "editor.tsx": editorSource })

    await press(harness, "e")
    await waitForFrame(harness, "editor editing saved=0")
    await press(harness, () => void harness.kernel.commands.execute("editor.ask"))
    await waitForFrame(harness, "Really?")

    await press(harness, "s", { ctrl: true })
    expect(frame(harness)).toContain("editor editing saved=0")

    await press(harness, "n")
    await waitForFrame(harness, (screen) => !screen.includes("Really?"))
    await press(harness, "s", { ctrl: true })
    await waitForFrame(harness, "editor idle saved=1")
  })

  it("gives capture Commands a section of their own, listed after the Pane's ordinary keys", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "editor.tsx": editorSource })

    await press(harness, () => void harness.kernel.openCheatSheet())
    await waitForFrame(harness, "Keybindings — editor")

    const rendered = frame(harness)
    // Titled for the Pane it is about, because it is only about that Pane now.
    expect(rendered).toContain("Submit message")
    expect(rendered).toContain("editor (capturing keys)")
    // Against an entry rather than a heading, so this pins the order the name claims: the
    // Pane's ordinary keys, then its capture keys, then the globals.
    expect(rendered.indexOf("editor (capturing keys)")).toBeGreaterThan(rendered.indexOf("Begin editing"))
    expect(rendered.indexOf("Global")).toBeGreaterThan(rendered.indexOf("editor (capturing keys)"))

    await pressEscape(harness)
  })

  it("collapses the cheat sheet to the capturing Pane, because nothing else is live", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "editor.tsx": editorSource })

    await press(harness, "e")
    await waitForFrame(harness, "editor editing saved=0")
    await press(harness, () => void harness.kernel.openCheatSheet())
    await waitForFrame(harness, "editor (capturing keys)")

    const rendered = frame(harness)
    expect(rendered).toContain("Submit message")
    // `q` quits and `e` begins an edit, and neither does anything right now: the sheet lists
    // what is live, not what exists.
    expect(rendered).not.toContain("Quit")
    expect(rendered).not.toContain("Begin editing")

    await pressEscape(harness)
  })
})

/**
 * The Bundled Layout in miniature: a list Pane in its own cell, driving a Pane that is
 * tabbed behind another one — which is where the two {@link PaneHandle} verbs differ.
 */
const tabsSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, type PaneProps } from "laziergit"

  const line = (name: string) => ({ focused }: PaneProps) =>
    <text content={name + " " + (focused ? "focused" : "blurred")} />

  export default defineExtension({
    name: "tabs",
    activate(ctx) {
      ctx.panes.register({ id: "tabs", title: "List", component: line("list") })
      ctx.panes.register({ id: "tabs.front", title: "Front", component: line("front") })
      const behind = ctx.panes.register({ id: "tabs.behind", title: "Behind", component: line("behind") })

      ctx.commands.register({ id: "tabs.reveal", title: "Reveal", keys: "v", run: () => behind.reveal() })
      ctx.commands.register({ id: "tabs.focus", title: "Focus", keys: "f", run: () => behind.focus() })
    },
  })
`

describe("PaneHandle", () => {
  it("reveals a tabbed-away Pane without moving the keyboard, and focuses it when asked", async () => {
    const harness = await createHarness()
    await withExtensions(
      harness,
      { "tabs.tsx": tabsSource },
      `{ "layout": { "columns": [["tabs"], [["tabs.front", "tabs.behind"]]] } }`,
    )

    expect(frame(harness)).toContain("list focused")
    expect(frame(harness)).toContain("front blurred")

    await press(harness, "v")
    // The stranded Pane is on screen — and unfocused, so the keys still belong to the Pane
    // the user was driving. That is the whole distinction `reveal` exists for.
    await waitForFrame(harness, "behind blurred")
    expect(frame(harness)).toContain("list focused")

    await press(harness, "f")
    await waitForFrame(harness, "behind focused")
    expect(frame(harness)).toContain("list blurred")
  })
})

/**
 * Three Panes and not one digit among them, which is the point: a third-party Extension cannot
 * know which numbers are free.
 */
const jumpSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, type PaneProps } from "laziergit"

  const line = (name: string) => ({ focused }: PaneProps) =>
    <text content={name + " " + (focused ? "focused" : "blurred")} />

  export default defineExtension({
    name: "diff",
    activate(ctx) {
      ctx.panes.register({ id: "diff.files", title: "Files", component: line("files") })
      ctx.panes.register({ id: "diff.actions", title: "Actions", component: line("actions") })
      ctx.panes.register({ id: "diff", title: "Diff", component: line("detail") })
    },
  })
`

describe("pane-jump keys", () => {
  it("numbers the Layout's cells, so a Pane that claimed no digit still has one", async () => {
    const harness = await createHarness()
    await withExtensions(
      harness,
      { "diff.tsx": jumpSource },
      `{ "layout": { "columns": [["diff.files", "diff.actions"], ["diff"]] } }`,
    )

    expect(frame(harness)).toContain("files focused")

    // `2` is the second cell of the first column. The bundled Diff id keeps `0` instead of
    // taking its positional `3`, wherever the Layout places it.
    await press(harness, "2")
    await waitForFrame(harness, "actions focused")
    expect(frame(harness)).toContain("files blurred")

    await press(harness, "3")
    expect(frame(harness)).toContain("actions focused")

    await press(harness, "0")
    await waitForFrame(harness, "detail focused")

    await press(harness, "1")
    await waitForFrame(harness, "files focused")

    // A digit past the end of the Layout is a miss, not an error.
    await press(harness, "9")
    expect(frame(harness)).toContain("files focused")
  })

  it("names each digit after the Pane it reaches, in the sheet a user asks", async () => {
    const harness = await createHarness({ height: 40 })
    await withExtensions(
      harness,
      { "diff.tsx": jumpSource },
      `{ "layout": { "columns": [["diff.files", "diff.actions"], ["diff"]] } }`,
    )

    await press(harness, "?")
    // The titles the Panes registered, not "pane 2": this sheet is where a user finds out
    // which digit is which. All three at once, because the jump keys trail the rest of the
    // globals and a sheet that had to be scrolled would hide the answer.
    await waitForFrame(harness, "Focus Files")
    const sheet = frame(harness)
    expect(sheet).toContain("Focus Actions")
    expect(sheet).toContain("Focus Diff")

    await pressEscape(harness)
  })

  it("renumbers when the Layout changes under it", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "diff.tsx": jumpSource }, `{ "layout": { "columns": [["diff.actions"]] } }`)

    // One cell in the Layout, so the two Panes it leaves out fall back to their placement
    // hints — and `1` names whatever ended up first, not whatever registered first.
    await press(harness, "1")
    expect(frame(harness)).toContain("actions focused")
  })
})

const copySource = `
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "copier",
    activate(ctx) {
      ctx.commands.register({
        id: "copier.run",
        title: "Copy something",
        keys: "y",
        run: async () => {
          try {
            await ctx.copy("cafebabe deadbeef")
            ctx.popups.notify("copied")
          } catch (error) {
            ctx.popups.notify(error instanceof Error ? error.message : String(error), "error")
          }
        },
      })
      ctx.panes.register({ id: "copier", title: "Copier", component: () => <text content="copier" /> })
    },
  })
`

describe("ctx.copy", () => {
  it("hands the text to the platform's clipboard tool on stdin", async () => {
    const harness = await createHarness({
      clipboardWriters: [
        [process.execPath, ["-e", `if (await Bun.stdin.text() !== "cafebabe deadbeef") process.exit(1)`]],
      ],
    })
    await withExtensions(harness, { "copier.tsx": copySource })
    await press(harness, "y")
    await waitForFrame(harness, "copied")
  })

  it("reports the failure rather than resolving as if it had copied", async () => {
    const harness = await createHarness({
      clipboardWriters: [[process.execPath, ["-e", `console.error("no display"); process.exit(1)`]]],
    })
    await withExtensions(harness, { "copier.tsx": copySource })
    await press(harness, "y")
    await waitForFrame(harness, "no display")
  })

  it("settles when the writer leaves something behind holding its pipes", async () => {
    const harness = await createHarness({
      clipboardWriters: [
        [
          process.execPath,
          [
            "-e",
            `
              if (await Bun.stdin.text() !== "cafebabe deadbeef") process.exit(1)
              const survivor = Bun.spawn([process.execPath, "-e", "await Bun.sleep(10000)"], {
                stdout: "inherit",
                stderr: "inherit",
              })
              survivor.unref()
            `,
          ],
        ],
      ],
    })
    await withExtensions(harness, { "copier.tsx": copySource })
    await press(harness, "y")
    await waitForFrame(harness, "copied")
  })
})
