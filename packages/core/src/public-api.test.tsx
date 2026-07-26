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

      function RowLine({ row, selected }: { readonly row: Row; readonly selected: boolean }) {
        const theme = useTheme()
        const decoration = host.useDecoration(row)
        const badge = decoration === undefined ? "" : " [" + (decoration.badge ?? "-") + "/" + (decoration.tone ?? "-") + "]"
        return <text fg={toneColor(theme, decoration?.tone)} content={(selected ? "> " : "  ") + row.name + badge} />
      }

      function RowsPane({ focused }: PaneProps) {
        const [items, setItems] = useState<readonly Row[]>([{ name: "one" }, { name: "two" }, { name: "three" }])
        const cursor = useListCursor({ items, idPrefix: "rows", noun: "row" })

        useEffect(() => {
          host.setSelected(cursor.selected)
        }, [cursor.selected])

        // Shrinking keeps the surviving rows' identity, the way the git store does; the
        // replacement is a fresh object per row, so the decoration cache is exercised both ways.
        useCommand({ id: "rows.shrink", title: "Shrink", keys: "s", run: () => setItems(items.slice(0, 1)) })
        useCommand({ id: "rows.grow", title: "Grow", keys: "w",
          run: () => setItems([{ name: "one" }, { name: "two" }, { name: "three" }]) })
        useCommand({ id: "rows.replace", title: "Replace", keys: "r",
          run: () => setItems(items.map((row) => ({ name: row.name }))) })

        return (
          <box flexDirection="column">
            {items.map((row, index) => (
              <RowLine key={row.name} row={row} selected={index === cursor.index && focused} />
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
 * Renders until the frame says `text`. A Command that spawns a child process returns long
 * after the keypress does, and a fixed sleep would be flaky or slow. Times out quietly, so
 * the test's own `expect` reports the failure with its own message and its own frame.
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
    // disposes exactly this handle, so the live path and the teardown path are the same one.
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
    // Against an entry rather than a heading, so this pins the ordering the name claims: the
    // Pane's ordinary keys, then its capture keys, then the globals that trail every sheet.
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
    // `q` quits and `e` begins an edit, and neither does anything right now, so neither is
    // offered — the sheet lists what is live, not what exists.
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
