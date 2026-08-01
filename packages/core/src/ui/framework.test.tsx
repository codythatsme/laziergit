import { describe, expect, it } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"

import {
  createHarness,
  frame,
  highlighted,
  installHarnessLifecycle,
  press,
  pressEscape,
  renderApp,
  settle,
  waitFor,
  waitForFrame,
  type Harness,
} from "../test-harness"

installHarnessLifecycle()

const alphaSource = `
  /** @jsxImportSource @opentui/react */
  import { createRowSource, defineExtension, useCommand, type PaneProps, type RowSource } from "laziergit"
  import { useEffect, useState } from "react"

  declare module "laziergit" {
    interface ExtensionApis { alpha: RowSource<{ readonly name: string }> }
  }

  export default defineExtension({
    name: "alpha",
    activate(ctx) {
      const globals = globalThis as any
      globals.__laziergitActivations = (globals.__laziergitActivations ?? 0) + 1
      const rows = createRowSource<{ readonly name: string }>({ pane: "alpha", key: (row) => row.name })

      function AlphaPane({ focused }: PaneProps) {
        const [count, setCount] = useState(0)
        useEffect(() => {
          rows.setSelected({ name: "row" })
          return () => rows.setSelected(undefined)
        }, [])
        useCommand({ id: "alpha.bump", title: "Bump alpha", keys: "j", run: () => setCount((value) => value + 1) })
        return <text id="alpha-pane" content={"alpha=" + count + (focused ? " focused" : "")} />
      }

      ctx.panes.register({ id: "alpha", title: "Alpha", component: AlphaPane })
      ctx.commands.register({
        id: "alpha.own",
        source: rows.api,
        title: "Own contextual Command",
        keys: "a",
        run: (row) => ctx.popups.notify("own ran on " + row.name),
      })
      ctx.commands.register({
        id: "alpha.choose",
        title: "Choose how alpha continues",
        keys: "m",
        pane: "alpha",
        run: () => ctx.popups.menu({
          title: "Alpha choice",
          groups: [{ items: [{ key: "a", label: "Own choice", run: () => ctx.popups.notify("choice ran") }] }],
        }),
      })
      ctx.commands.register({
        id: "alpha.ask",
        title: "Alpha prompt",
        run: async () => {
          const value = await ctx.popups.prompt({
            title: "Name it",
            initial: "seed",
            validate: (entered) => (entered.length < 5 ? "Too short" : null),
          })
          ctx.popups.notify(value === undefined ? "cancelled" : "named " + value)
        },
      })
      ctx.commands.register({
        id: "alpha.pick",
        title: "Alpha select",
        run: async () => {
          const picked = await ctx.popups.select({
            title: "Pick one",
            items: [
              { label: "first", value: 1, hint: "one" },
              { label: "second", value: 2 },
            ],
          })
          ctx.popups.notify(picked === undefined ? "picked nothing" : "picked " + picked)
        },
      })
      ctx.commands.register({
        id: "alpha.danger",
        title: "Alpha confirm",
        run: async () => {
          const confirmed = await ctx.popups.confirm({
            title: "Delete it?",
            message: "This cannot be undone",
            danger: true,
          })
          ctx.popups.notify(confirmed ? "confirmed" : "declined")
        },
      })
      return rows.api
    },
  })
`

const betaSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useCommand, type PaneProps, type RowSource } from "laziergit"
  import { useState } from "react"

  declare module "laziergit" {
    interface ExtensionApis { alpha: RowSource<{ readonly name: string }> }
  }

  export default defineExtension({
    name: "beta",
    needs: ["alpha"],
    activate(ctx) {
      const alpha = ctx.extensions.get("alpha")
      function BetaPane({ focused }: PaneProps) {
        const [count, setCount] = useState(0)
        useCommand({ id: "beta.bump", title: "Bump beta", keys: "j", run: () => setCount((value) => value + 1) })
        return <text id="beta-pane" content={"beta=" + count + (focused ? " focused" : "")} />
      }

      ctx.panes.register({ id: "beta", title: "Beta", component: BetaPane })
      ctx.statusline.register({ id: "beta", component: () => <text content="beta-segment" />, align: "right" })
      ctx.commands.register({
        id: "beta.alpha",
        source: alpha,
        title: "Contributed contextual Command",
        keys: "b",
        run: (row) => ctx.popups.notify("contribution ran on " + row.name),
      })
    },
  })
`

/**
 * A Pane with a hinted Command, plus a LEFT status line segment — the two things that share
 * the left of the bottom row, which is the arrangement under test.
 */
const leftSegmentSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension } from "laziergit"

  export default defineExtension({
    name: "left",
    activate(ctx) {
      ctx.statusline.register({ id: "left", component: () => <text content="left-segment" />, align: "left" })
      ctx.panes.register({ id: "left", title: "Left", component: () => <text content="left pane" /> })
      ctx.commands.register({
        id: "left.act",
        title: "Do the thing",
        hint: "do it",
        keys: "z",
        pane: "left",
        run: () => undefined,
      })
    },
  })
`

async function twoPanes(harness: Harness, config?: string): Promise<void> {
  await Promise.all([
    writeFile(join(harness.repo, "alpha.tsx"), alphaSource),
    writeFile(join(harness.repo, "beta.tsx"), betaSource),
    config === undefined ? Promise.resolve() : writeFile(harness.configFiles.repo, config),
  ])
  await renderApp(harness)
}

function activations(): number {
  const globals = globalThis as typeof globalThis & { __laziergitActivations?: number }
  return globals.__laziergitActivations ?? 0
}

describe("config-driven Layout", () => {
  it("places Panes in the columns the config asks for", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] } }`)

    const columns = harness.kernel.layout.getSnapshot().layout.columns
    expect(columns.map((column) => column.cells.map((cell) => cell.paneIds))).toEqual([[["alpha"]], [["beta"]]])
    expect(frame(harness)).toContain("Alpha")
    expect(frame(harness)).toContain("Beta")
    expect(harness.kernel.layout.focusedPaneId).toBe("alpha")
  })

  it("rearranges the screen when the config changes, without reactivating Extensions", async () => {
    const harness = await createHarness({ watch: true, debounceMs: 25 })
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] } }`)
    const before = activations()

    await writeFile(harness.configFiles.repo, `{ "layout": { "columns": [[["beta", "alpha"]]] } }`)
    await waitFor(
      harness,
      () => harness.kernel.layout.getSnapshot().layout.columns.length === 1,
      "the layout to reload as a single column",
    )

    expect(harness.kernel.layout.getSnapshot().layout.columns[0]?.cells[0]?.paneIds).toEqual(["beta", "alpha"])
    // Rearranging keeps the Pane the user was on visible rather than resetting the tab.
    await waitForFrame(harness, "Beta - [Alpha]")
    expect(harness.kernel.layout.focusedPaneId).toBe("alpha")
    expect(activations()).toBe(before)
  })

  it("keeps a Pane the config never mentions", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"]] } }`)

    expect(harness.kernel.layout.liveTabs()).toEqual(["alpha", "beta"])
  })
})

describe("focus and keybindings", () => {
  it("focuses the Pane under a mouse click through the Layout's focus model", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] } }`)

    const beta = harness.setup.renderer.root.findDescendantById("beta-pane")
    if (!beta) throw new Error("beta Pane did not render")
    await act(async () => {
      await harness.setup.mockMouse.click(beta.x, beta.y)
    })
    await settle(harness)

    expect(harness.kernel.layout.focusedPaneId).toBe("beta")
    expect(frame(harness)).toContain("beta=0 focused")
  })

  it("moves focus with tab and reports it as an app event", async () => {
    const harness = await createHarness()
    const focusEvents: string[] = []
    harness.kernel.events.subscribe("test", "app.pane.focused", ({ paneId }) => {
      focusEvents.push(paneId)
    })
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] } }`)

    await press(harness, () => harness.setup.mockInput.pressTab())
    await waitForFrame(harness, "beta=0 focused")
    expect(harness.kernel.layout.focusedPaneId).toBe("beta")

    await press(harness, () => harness.setup.mockInput.pressTab({ shift: true }))
    await waitFor(harness, () => harness.kernel.layout.focusedPaneId === "alpha", "focus to return to alpha")

    await act(async () => {
      await harness.kernel.events.drain()
    })
    expect(focusEvents).toEqual(["alpha", "beta", "alpha"])
  })

  it("lets the user rebind a Command in config", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] }, "keybindings": { "alpha.bump": "x" } }`)

    await press(harness, "j")
    expect(frame(harness)).toContain("alpha=0")

    await press(harness, "x")
    await waitForFrame(harness, "alpha=1")
  })

  it("applies mouse capture config live without reactivating Extensions", async () => {
    const harness = await createHarness({ watch: true, debounceMs: 25 })
    await twoPanes(harness, `{ "mouse": false }`)
    const before = activations()

    expect(harness.setup.renderer.useMouse).toBe(false)

    await writeFile(harness.configFiles.repo, `{ "mouse": true }`)
    await waitFor(harness, () => harness.setup.renderer.useMouse, "the config reload to enable mouse capture")

    expect(harness.setup.renderer.useMouse).toBe(true)
    expect(activations()).toBe(before)
  })
})

describe("popups", () => {
  it("uses the standard row highlight without a cursor glyph", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.pick"))
    await waitForFrame(harness, "first")

    expect(frame(harness)).not.toContain("❯")
    expect(highlighted(harness).some((row) => row.includes("first"))).toBeTrue()
  })

  it("hands keyboard focus back to the Pane's own field when a popup closes", async () => {
    const harness = await createHarness()
    // A Pane that focuses a Renderable of its own: the case where a modal stealing the
    // single OpenTUI focus slot is visible to the user.
    await writeFile(
      join(harness.repo, "editor.tsx"),
      `/** @jsxImportSource @opentui/react */
       import { defineExtension } from "laziergit"
       export default defineExtension({
         name: "editor",
         activate(ctx) {
           ctx.panes.register({
             id: "editor",
             title: "Editor",
             component: () => <input focused width="100%" value="typed here" />,
           })
         },
       })`,
    )
    await renderApp(harness)

    const focused = harness.setup.renderer.currentFocusedRenderable
    expect(focused).not.toBeNull()

    await press(harness, "p", { ctrl: true })
    await waitFor(
      harness,
      () => harness.setup.renderer.currentFocusedRenderable !== focused,
      "the palette to take the focus slot",
    )

    await pressEscape(harness)
    await waitFor(
      harness,
      () => harness.setup.renderer.currentFocusedRenderable === focused,
      "focus to return to the Pane's input",
    )
  })

  it("suspends Pane keys while a popup is open and restores them on escape", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] } }`)

    await press(harness, "p", { ctrl: true })
    await waitFor(harness, () => harness.kernel.popups.getSnapshot().length > 0, "the palette to open")
    await press(harness, "j")
    expect(frame(harness)).toContain("alpha=0")

    await pressEscape(harness)
    await waitFor(harness, () => harness.kernel.popups.getSnapshot().length === 0, "the palette to close")
    expect(frame(harness)).not.toContain("Commands")

    await press(harness, "j")
    await waitForFrame(harness, "alpha=1")
  })

  it("blocks a prompt that fails validation and accepts the corrected answer", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.ask"))
    await waitForFrame(harness, "Name it")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    await waitForFrame(harness, "Too short")
    expect(frame(harness)).toContain("Name it")

    await press(harness, () => void harness.setup.mockInput.typeText("x"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "named seedx")
    expect(frame(harness)).not.toContain("Name it")
  })

  it("submits what was typed even when Enter arrives before the render that would show it", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.ask"))
    await waitForFrame(harness, "Name it")

    // One `act`, so React commits nothing between the keystroke and the Enter: the popup's
    // `return` binding runs on the key layer, which is not a React event and does not wait for
    // a render. Typing each key in its own `act` flushes in between and cannot catch this.
    await press(harness, () => {
      void harness.setup.mockInput.typeText("x")
      harness.setup.mockInput.pressEnter()
    })

    await waitForFrame(harness, "named seedx")
    expect(frame(harness)).not.toContain("Name it")
  })

  it("uses terminal-reported Option and Command modifiers for native text editing", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.ask"))
    await waitForFrame(harness, "Name it")
    await press(harness, () => void harness.setup.mockInput.typeText(" one two"))

    const input = harness.setup.renderer.currentFocusedRenderable
    expect(input).toBeInstanceOf(InputRenderable)
    if (!(input instanceof InputRenderable)) throw new TypeError("The prompt did not focus its input")

    await press(harness, () => harness.setup.mockInput.pressBackspace({ meta: true }))
    expect(input.value).toBe("seed one ")

    await press(harness, () => harness.setup.mockInput.pressBackspace({ super: true }))
    expect(input.value).toBe("")

    await press(harness, () => void harness.setup.mockInput.typeText("left right"))
    await press(harness, () => harness.setup.mockInput.pressArrow("left", { super: true }))
    await press(harness, "DELETE", { super: true })
    expect(input.value).toBe("")
  })

  it("chooses the row the cursor is on even when Enter arrives before the render that moves it", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.pick"))
    await waitForFrame(harness, "Pick one")

    // Same ordering as the prompt case above: holding `down` and hitting enter, or typing a
    // filter and hitting enter, delivers both keys before React commits either.
    await press(harness, () => {
      harness.setup.mockInput.pressArrow("down")
      harness.setup.mockInput.pressEnter()
    })

    await waitForFrame(harness, "picked 2")
  })

  it("filters and chooses in one breath, without a render in between", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.pick"))
    await waitForFrame(harness, "Pick one")

    await press(harness, () => {
      void harness.setup.mockInput.typeText("second")
      harness.setup.mockInput.pressEnter()
    })

    await waitForFrame(harness, "picked 2")
  })

  it("resolves a select with the caller's own value, not the row index", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.pick"))
    await waitForFrame(harness, "Pick one")
    expect(frame(harness)).toContain("first")

    await press(harness, () => harness.setup.mockInput.pressArrow("down"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    await waitForFrame(harness, "picked 2")
  })

  it("answers a confirm either way", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.danger"))
    await waitForFrame(harness, "Delete it?")
    expect(frame(harness)).toContain("This cannot be undone")

    await press(harness, "n")
    await waitForFrame(harness, "declined")

    await press(harness, () => void harness.kernel.commands.execute("alpha.danger"))
    await waitForFrame(harness, "Delete it?")
    await press(harness, "y")
    await waitForFrame(harness, "confirmed")
  })
})

describe("contextual Commands, transient menus and status line", () => {
  it("runs another Extension's Command directly against the selected row", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, "b")
    await waitForFrame(harness, "contribution ran on row")
    expect(harness.kernel.popups.getSnapshot()).toEqual([])
  })

  it("closes a transient chooser when a reload takes its Extension down", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, "m")
    await waitForFrame(harness, "Alpha choice")

    await act(async () => harness.kernel.reload())
    await settle(harness)

    expect(harness.kernel.popups.getSnapshot()).toEqual([])
    expect(frame(harness)).not.toContain("Alpha choice")
  })

  it("abandons a prompt its Extension was awaiting when the Extension reloads", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.ask"))
    await waitForFrame(harness, "Name it")

    await act(async () => harness.kernel.reload())
    await settle(harness)

    expect(harness.kernel.popups.getSnapshot()).toEqual([])
    expect(frame(harness)).not.toContain("Name it")
    // The awaited flow is parked, never resumed: no outcome toast is ever published.
    expect(frame(harness)).not.toContain("cancelled")
    expect(frame(harness)).not.toContain("named ")
  })

  it("renders a registered status line segment", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    expect(frame(harness)).toContain("beta-segment")
  })

  it("hides a segment the config hides", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "statusline": { "hidden": ["beta"] } }`)

    expect(frame(harness)).not.toContain("beta-segment")
  })

  it("renders the focused Pane's hints beside an Extension's own left segment", async () => {
    const harness = await createHarness()
    await writeFile(join(harness.repo, "left.tsx"), leftSegmentSource)
    await renderApp(harness)

    const rendered = frame(harness)
    // One row, shared: core writes the focused Pane's hints along its left and an Extension's
    // own left-aligned segments follow them.
    expect(rendered).toContain("z do it")
    expect(rendered).toContain("left-segment")
    expect(rendered.indexOf("z do it")).toBeLessThan(rendered.indexOf("left-segment"))
  })

  it("caps a many-line notification and says how many lines it dropped", async () => {
    const harness = await createHarness()
    await renderApp(harness)

    // git's most useful refusals are multi-line — the header plus the file list — so the toast
    // keeps the lines that name what went wrong, while an overlay of forty lines would cover
    // the screen. Eight lines in, six shown, the rest counted.
    await act(async () => {
      harness.kernel.notifications.publish({
        extension: "sync",
        message: "would be overwritten by merge:\none.txt\ntwo.txt\nthree.txt\nfour.txt\nfive.txt\nsix.txt\nseven.txt",
        level: "error",
      })
    })
    await settle(harness)

    const rendered = frame(harness)
    expect(rendered).toContain("would be overwritten by merge:")
    expect(rendered).toContain("five.txt")
    expect(rendered).toContain("… 2 more lines")
    // The two lines past the cap are represented by the count, not drawn.
    expect(rendered).not.toContain("six.txt")
    expect(rendered).not.toContain("seven.txt")
  })
})
