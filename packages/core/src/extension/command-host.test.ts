import { expect, it, spyOn } from "bun:test"

import { CommandHost } from "./command-host"
import { Diagnostics } from "./diagnostics"
import { bindNotifier, createNotifier, type Notification } from "./notifier"

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected Promise to reject")
}

it("rejects unknown Commands", async () => {
  const host = new CommandHost(new Diagnostics(), () => {})

  expect(await rejectionOf(host.execute("missing.command"))).toEqual(
    expect.objectContaining({ message: 'Unknown command "missing.command"' }),
  )
})

it("rejects unavailable Pane focus without running the Command", async () => {
  let ran = false
  const host = new CommandHost(new Diagnostics(), (id) => {
    throw new Error(`Pane "${id}" has no live instance`)
  })
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
  const host = new CommandHost(new Diagnostics(), (id) => {
    order.push(`focus:${id}`)
  })
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
  const host = new CommandHost(
    diagnostics,
    () => {},
    (notification) => notifications.push(notification),
  )
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
  const host = new CommandHost(
    diagnostics,
    () => {},
    () => {
      notified = true
      throw new Error("notification publisher exploded")
    },
  )
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
