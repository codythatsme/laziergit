import { describe, expect, it, spyOn } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "./test-harness"

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
      const host = createRowSource<Row>({ key: (row) => row.name })

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

/**
 * A key press, plus enough real time for the terminal parser to disambiguate it — a lone
 * escape byte is only a key once the parser has waited for the sequence it could start.
 */
async function press(harness: Harness, action: () => void): Promise<void> {
  await act(async () => {
    action()
    await Bun.sleep(60)
  })
  await settle(harness)
}

/**
 * Renders until the frame says `text`, since a Command that spawns a child process returns
 * long after the keypress. Times out quietly, so the test's own `expect` reports the failure.
 */
async function waitForFrame(harness: Harness, text: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await settle(harness)
    if (frame(harness).includes(text)) return
    await act(async () => {
      await Bun.sleep(25)
    })
  }
}

async function withExtensions(harness: Harness, sources: Record<string, string>, config?: string): Promise<void> {
  await Promise.all([
    ...Object.entries(sources).map(([name, source]) => writeFile(join(harness.repo, name), source)),
    config === undefined ? Promise.resolve() : writeFile(harness.configFiles.repo, config),
  ])
  await renderApp(harness)
}

describe("useListCursor", () => {
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

    await press(harness, () => harness.setup.mockInput.pressKey("G"))
    expect(frame(harness)).toContain("cursor=2 selected=three")

    await press(harness, () => harness.setup.mockInput.pressKey("s"))
    expect(frame(harness)).toContain("cursor=0 selected=one")

    await press(harness, () => harness.setup.mockInput.pressKey("w"))
    expect(frame(harness)).toContain("cursor=0 selected=one")
  })

  it("keeps its position when the list is replaced with an equal-length one", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("r"))

    expect(frame(harness)).toContain("cursor=1 selected=two")
  })

  it("filters live under capture, keeps the filter on Enter, and preserves selection when cleared", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, () => harness.setup.mockInput.pressKey("/"))
    expect(frame(harness)).toContain("Filter:")

    // `s` is also the Pane's destructive shrink Command. Capture makes it query text only.
    await press(harness, () => void harness.setup.mockInput.typeText("two"))
    let rendered = frame(harness)
    expect(rendered).toContain("two")
    expect(rendered).not.toContain("one")
    expect(rendered).not.toContain("three")
    expect(rendered).toContain("cursor=0 selected=two")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    expect(frame(harness)).toContain("matches for 'two' (1 of 3)")

    await press(harness, () => harness.setup.mockInput.pressEscape())
    rendered = frame(harness)
    expect(rendered).toContain("one")
    expect(rendered).toContain("three")
    expect(rendered).toContain("cursor=1 selected=two")
    expect(rendered).not.toContain("matches for")
  })

  it("renders an honest empty filter and Escape cancels it", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, () => harness.setup.mockInput.pressKey("/"))
    await press(harness, () => void harness.setup.mockInput.typeText("missing"))
    expect(frame(harness)).toContain("cursor=0 selected=none")

    await press(harness, () => harness.setup.mockInput.pressEscape())
    expect(frame(harness)).toContain("cursor=0 selected=one")
  })

  it("applies text pasted in the same render tick as Enter", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource })

    await press(harness, () => harness.setup.mockInput.pressKey("/"))
    await press(harness, () => {
      void harness.setup.mockInput.typeText("three")
      harness.setup.mockInput.pressEnter()
    })

    const rendered = frame(harness)
    expect(rendered).toContain("matches for 'three' (1 of 3)")
    expect(rendered).toContain("cursor=0 selected=three")
    expect(rendered).not.toContain("one")
  })

  it("searches without removing rows and cycles relative to ordinary cursor movement", async () => {
    const harness = await createHarness()
    const searchSource = rowsSource.replace('mode: "filter"', 'mode: "search"')
    await withExtensions(harness, { "rows.tsx": searchSource })

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("/"))
    await press(harness, () => void harness.setup.mockInput.typeText("e"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    let rendered = frame(harness)
    expect(rendered).toContain("one")
    expect(rendered).toContain("two")
    expect(rendered).toContain("three")
    expect(rendered).toContain("cursor=2 selected=three")
    expect(rendered).toContain("matches for 'e' (2 of 2)")

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    expect(frame(harness)).toContain("cursor=0 selected=one")

    // Move below the current match. Previous first returns to that match rather than
    // skipping straight to the match at the other end of the list.
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("N"))
    rendered = frame(harness)
    expect(rendered).toContain("cursor=0 selected=one")
    expect(rendered).toContain("matches for 'e' (1 of 2)")

    await press(harness, () => harness.setup.mockInput.pressKey("N"))
    expect(frame(harness)).toContain("cursor=2 selected=three")

    await press(harness, () => harness.setup.mockInput.pressKey("/"))
    await press(harness, () => {
      void harness.setup.mockInput.typeText("missing")
      harness.setup.mockInput.pressEnter()
    })
    rendered = frame(harness)
    expect(rendered).toContain("matches for 'missing' (0 of 0)")
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

    await press(harness, () => harness.setup.mockInput.pressKey("/"))
    await press(harness, () => void harness.setup.mockInput.typeText("o"))
    await press(harness, () => harness.setup.mockInput.pressEnter())
    expect(frame(harness)).toContain("cursor=1 selected=two")

    // Moving past `four` makes it the nearest search result. Previous returns there first;
    // retaining the original landing at `two` would incorrectly jump all the way back to it.
    await press(harness, () => harness.setup.mockInput.pressKey("G"))
    await press(harness, () => harness.setup.mockInput.pressKey("N"))
    expect(frame(harness)).toContain("cursor=3 selected=four")
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

    await press(harness, () => harness.setup.mockInput.pressKey("R"))
    expect(frame(harness)).toContain("two [late/warning]")
    warnSpy.mockRestore()
  })

  it("stops calling a provider the moment its registration is disposed", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined)
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource, "decorations.tsx": decorationsSource })

    expect(frame(harness)).toContain("two [second/warning]")

    // Disposal is how a deactivating Extension's providers stop being called: its ctx scope
    // disposes exactly this handle.
    await press(harness, () => harness.setup.mockInput.pressKey("F"))
    expect(frame(harness)).toContain("two [first/warning]")

    // And a refresh on the dead registration neither throws nor revives it.
    await press(harness, () => harness.setup.mockInput.pressKey("R"))
    expect(frame(harness)).toContain("two [first/warning]")
    expect(harness.kernel.diagnostics.getSnapshot()).toEqual([])
    warnSpy.mockRestore()
  })

  it("hands the row the cursor is on to the consuming Extension", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "rows.tsx": rowsSource, "decorations.tsx": decorationsSource })

    await press(harness, () => harness.setup.mockInput.pressKey("V"))
    expect(frame(harness)).toContain("selection is one")

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    await press(harness, () => harness.setup.mockInput.pressKey("V"))
    expect(frame(harness)).toContain("selection is two")
  })
})

describe("useKeyCapture", () => {
  it("still lets a popup outrank the capture", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "editor.tsx": editorSource })

    await press(harness, () => harness.setup.mockInput.pressKey("e"))
    await press(harness, () => void harness.kernel.commands.execute("editor.ask"))
    expect(frame(harness)).toContain("Really?")

    await press(harness, () => harness.setup.mockInput.pressKey("s", { ctrl: true }))
    expect(frame(harness)).toContain("editor editing saved=0")

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    await press(harness, () => harness.setup.mockInput.pressKey("s", { ctrl: true }))
    expect(frame(harness)).toContain("editor idle saved=1")
  })

  it("gives capture Commands a section of their own, listed after the Pane's ordinary keys", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "editor.tsx": editorSource })

    await press(harness, () => void harness.kernel.openCheatSheet())

    const rendered = frame(harness)
    // Titled for the Pane it is about, because it is only about that Pane now.
    expect(rendered).toContain("Keybindings — editor")
    expect(rendered).toContain("Submit message")
    expect(rendered).toContain("editor (capturing keys)")
    // Against an entry rather than a heading, so this pins the order the name claims: the
    // Pane's ordinary keys, then its capture keys, then the globals.
    expect(rendered.indexOf("editor (capturing keys)")).toBeGreaterThan(rendered.indexOf("Begin editing"))
    expect(rendered.indexOf("Global")).toBeGreaterThan(rendered.indexOf("editor (capturing keys)"))

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })

  it("collapses the cheat sheet to the capturing Pane, because nothing else is live", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "editor.tsx": editorSource })

    await press(harness, () => harness.setup.mockInput.pressKey("e"))
    await press(harness, () => void harness.kernel.openCheatSheet())

    const rendered = frame(harness)
    expect(rendered).toContain("editor (capturing keys)")
    expect(rendered).toContain("Submit message")
    // `q` quits and `e` begins an edit, and neither does anything right now: the sheet lists
    // what is live, not what exists.
    expect(rendered).not.toContain("Quit")
    expect(rendered).not.toContain("Begin editing")

    await press(harness, () => harness.setup.mockInput.pressEscape())
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

    await press(harness, () => harness.setup.mockInput.pressKey("v"))
    // The stranded Pane is on screen — and unfocused, so the keys still belong to the Pane
    // the user was driving. That is the whole distinction `reveal` exists for.
    expect(frame(harness)).toContain("behind blurred")
    expect(frame(harness)).toContain("list focused")

    await press(harness, () => harness.setup.mockInput.pressKey("f"))
    expect(frame(harness)).toContain("behind focused")
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
    name: "jump",
    activate(ctx) {
      ctx.panes.register({ id: "jump", title: "Files", component: line("files") })
      ctx.panes.register({ id: "jump.actions", title: "Actions", component: line("actions") })
      ctx.panes.register({ id: "jump.detail", title: "Diff", component: line("detail") })
    },
  })
`

describe("pane-jump keys", () => {
  it("numbers the Layout's cells, so a Pane that claimed no digit still has one", async () => {
    const harness = await createHarness()
    await withExtensions(
      harness,
      { "jump.tsx": jumpSource },
      `{ "layout": { "columns": [["jump", "jump.actions"], ["jump.detail"]] } }`,
    )

    expect(frame(harness)).toContain("files focused")

    // `2` is the second cell of the first column and `3` carries on into the next: reading
    // order, which is the only order the numbers could mean.
    await press(harness, () => harness.setup.mockInput.pressKey("2"))
    expect(frame(harness)).toContain("actions focused")
    expect(frame(harness)).toContain("files blurred")

    await press(harness, () => harness.setup.mockInput.pressKey("3"))
    expect(frame(harness)).toContain("detail focused")

    await press(harness, () => harness.setup.mockInput.pressKey("1"))
    expect(frame(harness)).toContain("files focused")

    // A digit past the end of the Layout is a miss, not an error.
    await press(harness, () => harness.setup.mockInput.pressKey("9"))
    expect(frame(harness)).toContain("files focused")
  })

  it("names each digit after the Pane it reaches, in the sheet a user asks", async () => {
    const harness = await createHarness({ height: 40 })
    await withExtensions(
      harness,
      { "jump.tsx": jumpSource },
      `{ "layout": { "columns": [["jump", "jump.actions"], ["jump.detail"]] } }`,
    )

    await press(harness, () => harness.setup.mockInput.pressKey("?"))
    // The titles the Panes registered, not "pane 2": this sheet is where a user finds out
    // which digit is which. All three at once, because the jump keys trail the rest of the
    // globals and a sheet that had to be scrolled would hide the answer.
    const sheet = frame(harness)
    expect(sheet).toContain("Focus Files")
    expect(sheet).toContain("Focus Actions")
    expect(sheet).toContain("Focus Diff")

    await press(harness, () => harness.setup.mockInput.pressEscape())
  })

  it("renumbers when the Layout changes under it", async () => {
    const harness = await createHarness()
    await withExtensions(harness, { "jump.tsx": jumpSource }, `{ "layout": { "columns": [["jump.actions"]] } }`)

    // One cell in the Layout, so the two Panes it leaves out fall back to their placement
    // hints — and `1` names whatever ended up first, not whatever registered first.
    await press(harness, () => harness.setup.mockInput.pressKey("1"))
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
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitForFrame(harness, "copied")

    expect(frame(harness)).toContain("copied")
  })

  it("reports the failure rather than resolving as if it had copied", async () => {
    const harness = await createHarness({
      clipboardWriters: [[process.execPath, ["-e", `console.error("no display"); process.exit(1)`]]],
    })
    await withExtensions(harness, { "copier.tsx": copySource })
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitForFrame(harness, "no display")

    expect(frame(harness)).toContain("no display")
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
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    await waitForFrame(harness, "copied")

    expect(frame(harness)).toContain("copied")
  })
})
