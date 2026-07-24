import { expect, it } from "bun:test"
import type { PlacementHint } from "laziergit"

import type { LayoutConfig } from "../config/config"
import type { PaneEntry } from "../extension/pane-host"
import { LayoutHost, resolveLayout } from "./layout"

function pane(id: string, placement?: PlacementHint, state: PaneEntry["state"] = "active"): PaneEntry {
  return { id, owner: id.split(".")[0] ?? id, title: id, state, placement }
}

function columns(...cells: (string | readonly string[])[][]): LayoutConfig {
  return {
    columns: cells.map((column) => ({
      weight: 1,
      cells: column.map((cell) => (typeof cell === "string" ? [cell] : [...cell])),
    })),
    focus: null,
  }
}

function shape(layout: { columns: readonly { readonly cells: readonly { readonly paneIds: readonly string[] }[] }[] }) {
  return layout.columns.map((column) => column.cells.map((cell) => [...cell.paneIds]))
}

it("places configured Panes in the configured order and drops ids nothing registered", () => {
  const layout = resolveLayout(columns(["status", "files"], ["missing", "diff"]), [
    pane("diff"),
    pane("files"),
    pane("status"),
  ])

  expect(shape(layout)).toEqual([[["status"], ["files"]], [["diff"]]])
})

it("groups a configured cell of several ids into one tab group", () => {
  const layout = resolveLayout(columns(["status", ["files", "stash"]]), [pane("status"), pane("files"), pane("stash")])

  expect(shape(layout)).toEqual([[["status"], ["files", "stash"]]])
})

it("keeps a Pane the config never mentions, placing it by its own hint", () => {
  const layout = resolveLayout(columns(["status"]), [
    pane("status"),
    pane("late", { column: 1, order: 10 }),
    pane("later", { column: 1, order: 90 }),
  ])

  expect(shape(layout)).toEqual([[["status"]], [["late"], ["later"]]])
})

it("honours tabWith by joining the companion's cell", () => {
  const layout = resolveLayout(columns(["files"]), [pane("files"), pane("preview", { tabWith: "files" })])

  expect(shape(layout)).toEqual([[["files", "preview"]]])
})

it("falls back to the hint's column when the companion is not placed", () => {
  const layout = resolveLayout(null, [pane("preview", { tabWith: "absent", column: 2 })])

  expect(shape(layout)).toEqual([[["preview"]]])
})

it("joins a companion that is itself hint-placed, whichever sorts first", () => {
  const layout = resolveLayout(null, [pane("diff", { tabWith: "files" }), pane("files")])

  expect(shape(layout)).toEqual([[["files", "diff"]]])
})

it("follows a chain of companions to the Pane that owns the cell", () => {
  const layout = resolveLayout(null, [
    pane("third", { tabWith: "second" }),
    pane("second", { tabWith: "first" }),
    pane("first"),
  ])

  expect(shape(layout)).toEqual([[["first", "second", "third"]]])
})

it("keeps a Pane whose column hint is not a usable number, and never grows without bound", () => {
  const layout = resolveLayout(null, [
    pane("nan", { column: Number.NaN }),
    pane("huge", { column: Number.POSITIVE_INFINITY }),
    pane("negative", { column: -3 }),
  ])

  expect(layout.columns.flatMap((column) => column.cells.flatMap((cell) => cell.paneIds)).sort()).toEqual([
    "huge",
    "nan",
    "negative",
  ])
  expect(layout.columns.length).toBeLessThanOrEqual(2)
})

it("keeps a cell's identity when it loses a tab, so its neighbours do not remount", () => {
  const both = resolveLayout(columns([["files", "stash"]]), [pane("files"), pane("stash")])
  const one = resolveLayout(columns([["files", "stash"]]), [pane("stash")])

  expect(both.columns[0]?.cells[0]?.key).toBe(one.columns[0]?.cells[0]?.key)
})

it("orders hint-placed Panes by order then id, and ignores a Pane listed twice", () => {
  const layout = resolveLayout(columns(["a", "a"]), [pane("a"), pane("c", { order: 1 }), pane("b", { order: 1 })])

  expect(shape(layout)).toEqual([[["a"], ["b"], ["c"]]])
})

it("preserves configured column weights and drops columns nothing landed in", () => {
  const config: LayoutConfig = {
    columns: [
      { weight: 1, cells: [["absent"]] },
      { weight: 3, cells: [["diff"]] },
    ],
    focus: null,
  }

  expect(resolveLayout(config, [pane("diff")]).columns).toEqual([
    { weight: 3, cells: [{ key: "layout:1.0", paneIds: ["diff"] }] },
  ])
})

function host(panes: readonly PaneEntry[], config: LayoutConfig | null = null) {
  const layout = new LayoutHost()
  const focusEvents: (string | null)[] = []
  layout.setFocusListener((paneId) => focusEvents.push(paneId))
  layout.setConfig(config)
  layout.setPanes(panes)
  return { layout, focusEvents }
}

it("focuses the first live Pane and reports every focus change once", () => {
  const { layout, focusEvents } = host([pane("one"), pane("two")])

  expect(layout.focusedPaneId).toBe("one")
  layout.focus("two")
  layout.focus("two")

  expect(layout.focusedPaneId).toBe("two")
  expect(focusEvents).toEqual(["one", "two"])
})

it("settles startup focus on the Layout's first cell, not on whichever Pane registered first", () => {
  const layout = new LayoutHost()
  layout.setConfig(columns(["files"], ["diff"]))
  // `files` needs `diff`, so the dependency's Pane is always the one that gets there first.
  layout.setPanes([pane("diff")])
  expect(layout.focusedPaneId).toBe("diff")

  layout.setPanes([pane("diff"), pane("files")])
  layout.settleInitialFocus()

  expect(layout.focusedPaneId).toBe("files")
})

it("settles startup focus on the configured Pane, and leaves a chosen focus alone", () => {
  const configured = { ...columns(["status"], ["files"]), focus: "files" }
  const layout = new LayoutHost()
  layout.setConfig(configured)
  layout.setPanes([pane("status"), pane("files")])

  layout.settleInitialFocus()
  expect(layout.focusedPaneId).toBe("files")

  // A second pass — a hot reload re-activating every Extension — must not undo a choice.
  layout.focus("status")
  layout.settleInitialFocus()
  expect(layout.focusedPaneId).toBe("status")
})

it("ignores a configured startup focus naming a Pane nothing registered", () => {
  const layout = new LayoutHost()
  layout.setConfig({ ...columns(["status"], ["files"]), focus: "gh-workflows" })
  layout.setPanes([pane("status"), pane("files")])

  layout.settleInitialFocus()

  expect(layout.focusedPaneId).toBe("status")
})

it("steps focus by whole cells, wrapping in both directions", () => {
  const { layout } = host([pane("one"), pane("two"), pane("three")], columns(["one", "two"], ["three"]))

  layout.focusStep(1)
  expect(layout.focusedPaneId).toBe("two")
  layout.focusStep(1)
  expect(layout.focusedPaneId).toBe("three")
  layout.focusStep(1)
  expect(layout.focusedPaneId).toBe("one")
  layout.focusStep(-1)
  expect(layout.focusedPaneId).toBe("three")
})

it("skips a cell whose Panes are all reloading", () => {
  const { layout } = host([pane("one"), pane("two", undefined, "reloading"), pane("three")])

  expect(layout.liveTabs()).toEqual(["one", "three"])
  layout.focusStep(1)
  expect(layout.focusedPaneId).toBe("three")
})

it("cycles tabs inside the focused cell and leaves single-Pane cells alone", () => {
  const { layout } = host([pane("files"), pane("stash"), pane("diff")], columns([["files", "stash"]], ["diff"]))

  layout.cycleTab(1)
  expect(layout.focusedPaneId).toBe("stash")
  layout.cycleTab(1)
  expect(layout.focusedPaneId).toBe("files")

  layout.focus("diff")
  layout.cycleTab(1)
  expect(layout.focusedPaneId).toBe("diff")
})

it("reveals a tabbed-away Pane without taking the keyboard off the focused one", () => {
  const { layout, focusEvents } = host(
    [pane("files"), pane("diff"), pane("commit-flow")],
    columns(["files"], [["diff", "commit-flow"]]),
  )
  layout.focus("commit-flow")
  layout.focus("files")
  expect(layout.getSnapshot().activeTabs.get("layout:1.0")).toBe("commit-flow")

  layout.reveal("diff")

  // The diff Pane is what that cell shows...
  expect(layout.getSnapshot().activeTabs.get("layout:1.0")).toBe("diff")
  // ...and the keyboard never left the Pane the user is driving.
  expect(layout.focusedPaneId).toBe("files")
  expect(focusEvents).toEqual(["files", "commit-flow", "files"])
})

it("does nothing when asked to reveal a Pane that is not live or not placed", () => {
  const { layout } = host([pane("files"), pane("diff", undefined, "reloading")], columns(["files"]))

  // Revealing runs on cursor movement, so neither of these may throw the way `focus` does.
  expect(() => layout.reveal("diff")).not.toThrow()
  expect(() => layout.reveal("gh-workflows")).not.toThrow()
  expect(layout.focusedPaneId).toBe("files")
})

it("remembers the visible tab of a cell across focus moves", () => {
  const { layout } = host([pane("files"), pane("stash"), pane("diff")], columns([["files", "stash"]], ["diff"]))

  layout.focus("stash")
  layout.focus("diff")
  layout.focusStep(-1)

  expect(layout.focusedPaneId).toBe("stash")
})

it("keeps the focused cell and its visible tab across a reload of its Panes", () => {
  const reloading = (id: string) => pane(id, undefined, "reloading")
  const { layout } = host([pane("files"), pane("stash"), pane("diff")], columns([["files", "stash"]], ["diff"]))
  layout.focus("stash")

  layout.setPanes([reloading("files"), reloading("stash"), pane("diff")])
  expect(layout.focusedPaneId).toBeNull()

  layout.setPanes([pane("files"), pane("stash"), pane("diff")])
  expect(layout.focusedPaneId).toBe("stash")
})

it("rearranges live when the config changes, keeping focus on the same Pane", () => {
  const { layout } = host([pane("one"), pane("two")], columns(["one"], ["two"]))
  layout.focus("two")

  layout.setConfig(columns(["two", "one"]))

  expect(shape(layout.getSnapshot().layout)).toEqual([[["two"], ["one"]]])
  expect(layout.focusedPaneId).toBe("two")
})

it("moves focus off a Pane that goes away and reports null when none is left", () => {
  const { layout, focusEvents } = host([pane("one"), pane("two")])
  layout.focus("two")

  layout.setPanes([pane("one")])
  expect(layout.focusedPaneId).toBe("one")

  layout.setPanes([])
  expect(layout.focusedPaneId).toBeNull()
  expect(focusEvents).toEqual(["one", "two", "one", null])
})

it("refuses to focus a Pane with no live instance or no place in the Layout", () => {
  const { layout } = host([pane("one"), pane("two", undefined, "reloading")])

  expect(() => layout.focus("two")).toThrow('Pane "two" has no live instance')
  expect(() => layout.focus("absent")).toThrow('Pane "absent" has no live instance')
})

it("isolates a throwing focus listener and a throwing snapshot subscriber", () => {
  const layout = new LayoutHost()
  let healthyCalls = 0
  layout.setFocusListener(() => {
    throw new Error("focus listener exploded")
  })
  layout.subscribe(() => {
    throw new Error("snapshot listener exploded")
  })
  layout.subscribe(() => {
    healthyCalls += 1
  })

  expect(() => layout.setPanes([pane("one")])).not.toThrow()
  expect(layout.focusedPaneId).toBe("one")
  expect(healthyCalls).toBe(1)
})
