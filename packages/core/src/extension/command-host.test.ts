import { expect, it, spyOn } from "bun:test"
import { createRowSource } from "laziergit"

import { CommandHost, type CommandPaneAccess } from "./command-host"
import { Diagnostics } from "./diagnostics"
import { bindNotifier, createNotifier, type Notification } from "./notifier"

function panes(overrides: Partial<CommandPaneAccess> = {}): CommandPaneAccess {
  return { focus: () => undefined, isLive: () => true, ...overrides }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected Promise to reject")
}

it("rejects unknown Commands", async () => {
  const host = new CommandHost(new Diagnostics(), panes())

  expect(await rejectionOf(host.execute("missing.command"))).toEqual(
    expect.objectContaining({ message: 'Unknown command "missing.command"' }),
  )
})

it("rejects unavailable Pane focus without running the Command", async () => {
  let ran = false
  const host = new CommandHost(
    new Diagnostics(),
    panes({
      focus: (id) => {
        throw new Error(`Pane "${id}" has no live instance`)
      },
      isLive: () => false,
    }),
  )
  host.register("owner", {
    id: "owner.command",
    title: "Pane command",
    pane: "owner.pane",
    run: () => {
      ran = true
    },
  })

  expect(await rejectionOf(host.execute("owner.command"))).toEqual(
    expect.objectContaining({ message: 'Pane "owner.pane" has no live instance' }),
  )
  expect(ran).toBe(false)
})

it("focuses an available Pane before running its Command", async () => {
  const order: string[] = []
  const host = new CommandHost(
    new Diagnostics(),
    panes({
      focus: (id) => {
        order.push(`focus:${id}`)
      },
    }),
  )
  host.register("owner", {
    id: "owner.command",
    title: "Pane command",
    pane: "owner.pane",
    run: () => {
      order.push("run")
    },
  })

  await host.execute("owner.command")
  expect(order).toEqual(["focus:owner.pane", "run"])
})

it("runs a contextual Command against the RowSource selection at dispatch", async () => {
  const order: string[] = []
  const rows = createRowSource<{ readonly name: string; readonly enabled: boolean }>({
    pane: "provider.rows",
    key: (row) => row.name,
  })
  const host = new CommandHost(
    new Diagnostics(),
    panes({
      focus: (id) => order.push(`focus:${id}`),
    }),
  )
  host.register("consumer", {
    id: "consumer.act",
    source: rows.api,
    title: "Act on row",
    keys: "a",
    when: (row) => row.enabled,
    run: (row) => {
      order.push(`run:${row.name}`)
    },
  })

  expect(host.getSnapshot()).toEqual([])
  rows.setSelected({ name: "one", enabled: false })
  await Promise.resolve()
  expect(host.getSnapshot()).toEqual([])

  rows.setSelected({ name: "two", enabled: true })
  await Promise.resolve()
  expect(host.getSnapshot().map((command) => command.id)).toEqual(["consumer.act"])

  await host.execute("consumer.act")
  expect(order).toEqual(["focus:provider.rows", "run:two"])
})

it("rechecks conditional availability when a Command handle refreshes", async () => {
  let available = false
  let ran = false
  const host = new CommandHost(new Diagnostics(), panes())
  const handle = host.register("owner", {
    id: "owner.conditional",
    title: "Conditional",
    when: () => available,
    run: () => {
      ran = true
    },
  })

  expect(host.getSnapshot()).toEqual([])
  expect(await rejectionOf(host.execute("owner.conditional"))).toEqual(
    expect.objectContaining({ message: 'Command "owner.conditional" is unavailable' }),
  )

  available = true
  handle.refresh()
  expect(host.getSnapshot().map((command) => command.id)).toEqual(["owner.conditional"])
  await host.execute("owner.conditional")
  expect(ran).toBe(true)
})

it("resolves key ownership before availability so a condition never changes a key's meaning", () => {
  let laterAvailable = false
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const host = new CommandHost(new Diagnostics(), panes())
  host.register("first", { id: "first.act", title: "First", keys: "a", run: () => {} })
  const later = host.register("later", {
    id: "later.act",
    title: "Later",
    keys: "a",
    when: () => laterAvailable,
    run: () => {},
  })

  expect(host.getSnapshot().map((command) => [command.id, command.keys])).toEqual([["first.act", []]])
  laterAvailable = true
  later.refresh()
  expect(host.getSnapshot().map((command) => [command.id, command.keys])).toEqual([
    ["first.act", []],
    ["later.act", ["a"]],
  ])
  errorSpy.mockRestore()
})

it("diagnoses and notifies Command run errors while resolving execution", async () => {
  const diagnostics = new Diagnostics()
  const notifications: Notification[] = []
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const host = new CommandHost(diagnostics, panes(), (notification) => notifications.push(notification))
  host.register("owner", {
    id: "owner.command",
    title: "Refresh data",
    run: () => {
      throw "command exploded"
    },
  })

  await host.execute("owner.command")
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({
      extension: "owner",
      phase: "command",
      message: "owner.command: command exploded",
    }),
  ])
  expect(notifications).toEqual([
    {
      extension: "owner",
      message: "Refresh data: command exploded",
      level: "error",
    },
  ])
  errorSpy.mockRestore()
})

it("contains diagnostic and notifier failures", async () => {
  let notified = false
  const diagnostics = {
    report() {
      throw new Error("diagnostic observer exploded")
    },
  } as unknown as Diagnostics
  const host = new CommandHost(diagnostics, panes(), () => {
    notified = true
    throw new Error("notification publisher exploded")
  })
  host.register("owner", {
    id: "owner.command",
    title: "Broken command",
    async run() {
      throw new Error("command exploded")
    },
  })

  await host.execute("owner.command")
  expect(notified).toBe(true)
})

it("gives a key to the later registration, leaving the loser its palette row", () => {
  const diagnostics = new Diagnostics()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const host = new CommandHost(diagnostics, panes())

  host.register("first", { id: "first.stage", title: "Stage", keys: "s", run: () => {} })
  host.register("second", { id: "second.stash", title: "Stash", keys: ["s", "shift+s"], run: () => {} })

  expect(host.getSnapshot().map((entry) => [entry.id, entry.keys])).toEqual([
    ["first.stage", []],
    ["second.stash", ["s", "shift+s"]],
  ])
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ phase: "command", message: 'Key "s" moved from "first.stage" to "second.stash"' }),
  ])
  errorSpy.mockRestore()
})

it("resolves a case-variant of a key as the same stroke, last registration winning", () => {
  // A bare letter binds its lowercase stroke, so `"D"` and `"d"` are one physical key: without
  // case-folding the collision is silent and the keymap decides the winner instead.
  const diagnostics = new Diagnostics()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const host = new CommandHost(diagnostics, panes())

  host.register("first", { id: "first.discard", title: "Discard", keys: "d", run: () => {} })
  host.register("second", { id: "second.delete", title: "Delete", keys: "D", run: () => {} })

  expect(host.getSnapshot().map((entry) => [entry.id, entry.keys])).toEqual([
    ["first.discard", []],
    ["second.delete", ["D"]],
  ])
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ phase: "command", message: 'Key "D" moved from "first.discard" to "second.delete"' }),
  ])
  errorSpy.mockRestore()
})

it("binds a stroke a Command spells two ways only once, keeping the first spelling", () => {
  const host = new CommandHost(new Diagnostics(), panes())
  // `"d"` and `"D"` are the same stroke; the Command keeps its first spelling and no
  // spurious self-conflict is reported.
  host.register("owner", { id: "owner.discard", title: "Discard", keys: ["d", "D"], run: () => {} })

  expect(host.getSnapshot()[0]?.keys).toEqual(["d"])
})

it("keeps a key the user set in config out of a later Command's declared default", () => {
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const host = new CommandHost(new Diagnostics(), panes())
  host.setKeybindings(new Map([["first.quit", ["s"]]]))

  host.register("first", { id: "first.quit", title: "Quit", keys: "q", run: () => {} })
  host.register("second", { id: "second.stage", title: "Stage", keys: "s", run: () => {} })

  expect(host.getSnapshot().map((entry) => [entry.id, entry.keys])).toEqual([
    ["first.quit", ["s"]],
    ["second.stage", []],
  ])
  errorSpy.mockRestore()
})

it("lets a Pane claim one key in each mode, because the two layers never run together", () => {
  const host = new CommandHost(new Diagnostics(), panes())

  host.register("editor", { id: "editor.close", title: "Close", keys: "escape", pane: "editor", run: () => {} })
  host.register("editor", {
    id: "editor.cancel",
    title: "Cancel edit",
    keys: "escape",
    pane: "editor",
    capture: true,
    run: () => {},
  })

  expect(host.getSnapshot().map((entry) => [entry.id, entry.keys, entry.capture])).toEqual([
    ["editor.close", ["escape"], false],
    ["editor.cancel", ["escape"], true],
  ])
})

it("ignores capture on a Command with no Pane, and says so", () => {
  const diagnostics = new Diagnostics()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const host = new CommandHost(diagnostics, panes())

  host.register("editor", { id: "editor.submit", title: "Submit", keys: "mod+s", capture: true, run: () => {} })

  expect(host.getSnapshot()[0]?.capture).toBe(false)
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ phase: "command", message: "editor.submit: capture needs a pane and was ignored" }),
  ])
  errorSpy.mockRestore()
})

it("binds a key a Command claims twice only once", () => {
  const host = new CommandHost(new Diagnostics(), panes())
  host.register("owner", { id: "owner.one", title: "One", keys: ["j", "j"], run: () => {} })

  expect(host.getSnapshot()[0]?.keys).toEqual(["j"])
})

it("offers the palette only visible Commands whose Pane is live", () => {
  const host = new CommandHost(new Diagnostics(), panes({ isLive: (paneId) => paneId === "files" }))
  host.register("owner", { id: "owner.global", title: "Global", run: () => {} })
  host.register("owner", { id: "owner.hidden", title: "Hidden", hidden: true, run: () => {} })
  host.register("owner", { id: "owner.live", title: "Live", pane: "files", run: () => {} })
  host.register("owner", { id: "owner.dead", title: "Dead", pane: "gone", run: () => {} })

  expect(host.availableEntries().map((entry) => entry.id)).toEqual(["owner.global", "owner.live"])
})

it("adapts one contained notifier to PopupToolkit.notify", () => {
  const notifications: Notification[] = []
  const notify = bindNotifier(
    createNotifier((notification) => notifications.push(notification)),
    "owner",
  )

  notify("Saved")
  notify("Failed", "error")

  expect(notifications).toEqual([
    { extension: "owner", message: "Saved", level: "info" },
    { extension: "owner", message: "Failed", level: "error" },
  ])

  const broken = createNotifier(() => {
    throw new Error("publisher exploded")
  })
  expect(() => broken({ extension: "owner", message: "Ignored", level: "warning" })).not.toThrow()
})
