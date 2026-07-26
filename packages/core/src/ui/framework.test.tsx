import { describe, expect, it } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"

import { createHarness, frame, installHarnessLifecycle, renderApp, settle, type Harness } from "../test-harness"

installHarnessLifecycle()

const alphaSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useCommand, type PaneProps } from "laziergit"
  import { useState } from "react"

  declare module "laziergit" {
    interface MenuMap {
      "alpha.actions": { readonly name: string }
    }
  }

  export default defineExtension({
    name: "alpha",
    activate(ctx) {
      const globals = globalThis as any
      globals.__laziergitActivations = (globals.__laziergitActivations ?? 0) + 1

      function AlphaPane({ focused }: PaneProps) {
        const [count, setCount] = useState(0)
        useCommand({ id: "alpha.bump", title: "Bump alpha", keys: "j", run: () => setCount((value) => value + 1) })
        return <text content={"alpha=" + count + (focused ? " focused" : "")} />
      }

      ctx.panes.register({ id: "alpha", title: "Alpha", component: AlphaPane })
      ctx.menus.register({
        id: "alpha.actions",
        title: (target) => "Alpha: " + target.name,
        groups: [{ id: "core", items: [{ key: "a", label: "Own action", run: () => ctx.popups.notify("own ran") }] }],
      })
      ctx.commands.register({
        id: "alpha.menu",
        title: "Alpha actions",
        keys: "m",
        run: () => ctx.menus.open("alpha.actions", { name: "row" }),
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
        id: "alpha.missing-menu",
        title: "Alpha missing menu",
        // Deliberately not \`async\`: a Promise-returning member must reject rather than
        // throw past the \`.catch\` the caller attached.
        run: () =>
          ctx.menus
            .open("nope.actions" as never, undefined as never)
            .then(
              () => ctx.popups.notify("opened nothing"),
              (error: Error) => ctx.popups.notify("rejected: " + error.message),
            ),
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
    },
  })
`

const betaSource = `
  /** @jsxImportSource @opentui/react */
  import { defineExtension, useCommand, type PaneProps } from "laziergit"
  import { useState } from "react"

  declare module "laziergit" {
    interface MenuMap {
      "alpha.actions": { readonly name: string }
    }
  }

  export default defineExtension({
    name: "beta",
    activate(ctx) {
      function BetaPane({ focused }: PaneProps) {
        const [count, setCount] = useState(0)
        useCommand({ id: "beta.bump", title: "Bump beta", keys: "j", run: () => setCount((value) => value + 1) })
        return <text content={"beta=" + count + (focused ? " focused" : "")} />
      }

      ctx.panes.register({ id: "beta", title: "Beta", component: BetaPane })
      ctx.statusline.register({ id: "beta", component: () => <text content="beta-segment" />, align: "right" })
      ctx.menus.extend("alpha.actions", {
        group: "core",
        items: [{ key: "b", label: "Spliced action", run: () => ctx.popups.notify("splice ran") }],
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

/**
 * A key press, plus enough real time for the terminal parser to disambiguate it — a
 * lone escape byte is only a key once the parser has waited for the sequence it could
 * have started.
 */
async function press(harness: Harness, action: () => void): Promise<void> {
  await act(async () => {
    action()
    await Bun.sleep(60)
  })
  await settle(harness)
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
    await act(async () => {
      const deadline = Date.now() + 3_000
      while (harness.kernel.layout.getSnapshot().layout.columns.length !== 1 && Date.now() < deadline) {
        await Bun.sleep(10)
      }
    })
    await settle(harness)

    expect(harness.kernel.layout.getSnapshot().layout.columns[0]?.cells[0]?.paneIds).toEqual(["beta", "alpha"])
    // Rearranging keeps the Pane the user was on visible rather than resetting the tab.
    expect(frame(harness)).toContain("Beta [Alpha]")
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
  it("moves focus with tab and reports it as an app event", async () => {
    const harness = await createHarness()
    const focusEvents: string[] = []
    harness.kernel.events.subscribe("test", "app.pane.focused", ({ paneId }) => {
      focusEvents.push(paneId)
    })
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] } }`)

    await press(harness, () => harness.setup.mockInput.pressTab())
    expect(harness.kernel.layout.focusedPaneId).toBe("beta")
    expect(frame(harness)).toContain("beta=0 focused")

    await press(harness, () => harness.setup.mockInput.pressTab({ shift: true }))
    expect(harness.kernel.layout.focusedPaneId).toBe("alpha")

    await harness.kernel.events.drain()
    expect(focusEvents).toEqual(["alpha", "beta", "alpha"])
  })

  it("lets the user rebind a Command in config", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] }, "keybindings": { "alpha.bump": "x" } }`)

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    expect(frame(harness)).toContain("alpha=0")

    await press(harness, () => harness.setup.mockInput.pressKey("x"))
    expect(frame(harness)).toContain("alpha=1")
  })
})

describe("popups", () => {
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

    await press(harness, () => harness.setup.mockInput.pressKey("p", { ctrl: true }))
    expect(harness.setup.renderer.currentFocusedRenderable).not.toBe(focused)

    await press(harness, () => harness.setup.mockInput.pressEscape())
    expect(harness.setup.renderer.currentFocusedRenderable).toBe(focused)
  })

  it("suspends Pane keys while a popup is open and restores them on escape", async () => {
    const harness = await createHarness()
    await twoPanes(harness, `{ "layout": { "columns": [["alpha"], ["beta"]] } }`)

    await press(harness, () => harness.setup.mockInput.pressKey("p", { ctrl: true }))
    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    expect(frame(harness)).toContain("alpha=0")

    await press(harness, () => harness.setup.mockInput.pressEscape())
    expect(frame(harness)).not.toContain("Commands")

    await press(harness, () => harness.setup.mockInput.pressKey("j"))
    expect(frame(harness)).toContain("alpha=1")
  })

  it("blocks a prompt that fails validation and accepts the corrected answer", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.ask"))
    expect(frame(harness)).toContain("Name it")

    await press(harness, () => harness.setup.mockInput.pressEnter())
    expect(frame(harness)).toContain("Too short")
    expect(frame(harness)).toContain("Name it")

    await press(harness, () => void harness.setup.mockInput.typeText("x"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    expect(frame(harness)).not.toContain("Name it")
    expect(frame(harness)).toContain("named seedx")
  })

  it("submits what was typed even when Enter arrives before the render that would show it", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.ask"))
    expect(frame(harness)).toContain("Name it")

    // One `act`, so React commits nothing between the keystroke and the Enter: the popup's
    // `return` binding runs on the key layer, which is not a React event and does not wait
    // for a render. Typing each key in its own `act` — as every other popup test does —
    // flushes in between and cannot catch this. A person hitting enter straight after a
    // paste, and every automated driver, produces exactly this ordering.
    await press(harness, () => {
      void harness.setup.mockInput.typeText("x")
      harness.setup.mockInput.pressEnter()
    })

    expect(frame(harness)).not.toContain("Name it")
    expect(frame(harness)).toContain("named seedx")
  })

  it("chooses the row the cursor is on even when Enter arrives before the render that moves it", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.pick"))
    expect(frame(harness)).toContain("Pick one")

    // Same ordering as the prompt case above: holding `down` and hitting enter, or typing a
    // filter and hitting enter, delivers both keys before React commits either.
    await press(harness, () => {
      harness.setup.mockInput.pressArrow("down")
      harness.setup.mockInput.pressEnter()
    })

    expect(frame(harness)).toContain("picked 2")
  })

  it("filters and chooses in one breath, without a render in between", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.pick"))
    expect(frame(harness)).toContain("Pick one")

    await press(harness, () => {
      void harness.setup.mockInput.typeText("second")
      harness.setup.mockInput.pressEnter()
    })

    expect(frame(harness)).toContain("picked 2")
  })

  it("resolves a select with the caller's own value, not the row index", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.pick"))
    expect(frame(harness)).toContain("Pick one")
    expect(frame(harness)).toContain("first")

    await press(harness, () => harness.setup.mockInput.pressArrow("down"))
    await press(harness, () => harness.setup.mockInput.pressEnter())

    expect(frame(harness)).toContain("picked 2")
  })

  it("answers a confirm either way", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.danger"))
    expect(frame(harness)).toContain("Delete it?")
    expect(frame(harness)).toContain("This cannot be undone")

    await press(harness, () => harness.setup.mockInput.pressKey("n"))
    expect(frame(harness)).toContain("declined")

    await press(harness, () => void harness.kernel.commands.execute("alpha.danger"))
    await press(harness, () => harness.setup.mockInput.pressKey("y"))
    expect(frame(harness)).toContain("confirmed")
  })
})

describe("menus and status line", () => {
  it("merges another Extension's spliced items into the menu it opens", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("m"))
    expect(frame(harness)).toContain("Alpha: row")
    expect(frame(harness)).toContain("Own action")
    expect(frame(harness)).toContain("Spliced action")

    await press(harness, () => harness.setup.mockInput.pressKey("b"))
    expect(frame(harness)).not.toContain("Spliced action")
    expect(frame(harness)).toContain("splice ran")
  })

  it("closes an open menu when a reload takes its Extensions down", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => harness.setup.mockInput.pressKey("m"))
    expect(frame(harness)).toContain("Spliced action")

    await act(async () => harness.kernel.reload())
    await settle(harness)

    expect(harness.kernel.popups.getSnapshot()).toEqual([])
    expect(frame(harness)).not.toContain("Spliced action")
  })

  it("abandons a prompt its Extension was awaiting when the Extension reloads", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.ask"))
    expect(frame(harness)).toContain("Name it")

    await act(async () => harness.kernel.reload())
    await settle(harness)

    expect(harness.kernel.popups.getSnapshot()).toEqual([])
    expect(frame(harness)).not.toContain("Name it")
    // The awaited flow is parked, never resumed: no outcome toast is ever published.
    expect(frame(harness)).not.toContain("cancelled")
    expect(frame(harness)).not.toContain("named ")
  })

  it("rejects rather than throws when a Command opens a menu id nothing registered", async () => {
    const harness = await createHarness()
    await twoPanes(harness)

    await press(harness, () => void harness.kernel.commands.execute("alpha.missing-menu"))

    expect(frame(harness)).toContain("rejected: No menu registered")
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
    // One row, shared: core writes the focused Pane's hints along its left and an
    // Extension's own left-aligned segments follow them, rather than either displacing
    // the other.
    expect(rendered).toContain("z do it")
    expect(rendered).toContain("left-segment")
    expect(rendered.indexOf("z do it")).toBeLessThan(rendered.indexOf("left-segment"))
  })

  it("caps a many-line notification and says how many lines it dropped", async () => {
    const harness = await createHarness()
    await renderApp(harness)

    // git's most useful refusals are multi-line — the header plus the file list — and every
    // Bundled Extension passes GitError.stderr through verbatim, so the toast must keep the
    // lines that name what went wrong, while an overlay that grew to forty lines would cover
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
