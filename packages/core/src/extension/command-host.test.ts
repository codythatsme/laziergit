import { expect, it, spyOn } from "bun:test"

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
  host.register("second", { id: "second.stash", title: "Stash", keys: ["s", "S"], run: () => {} })

  expect(host.getSnapshot().map((entry) => [entry.id, entry.keys])).toEqual([
    ["first.stage", []],
    ["second.stash", ["s", "S"]],
  ])
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ phase: "command", message: 'Key "s" moved from "first.stage" to "second.stash"' }),
  ])
  errorSpy.mockRestore()
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
