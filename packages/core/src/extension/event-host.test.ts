import { expect, it, spyOn } from "bun:test"
import type { EventMap } from "laziergit"

import { Diagnostics } from "./diagnostics"
import { EventHost } from "./event-host"

const event = "app.pane.focused"
type Payload = EventMap[typeof event]

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function settleSoon(promise: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Promise did not settle")), 1_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function payload(paneId: string): Payload {
  return { paneId, previous: null }
}

it("snapshots subscriptions synchronously when an event is emitted", async () => {
  const host = new EventHost(new Diagnostics())
  const received: string[] = []

  host.subscribe("early", event, (value) => {
    received.push(`early:${value.paneId}`)
  })
  host.emit(event, payload("one"))
  host.subscribe("late", event, (value) => {
    received.push(`late:${value.paneId}`)
  })

  await host.drain()
  expect(received).toEqual(["early:one"])
})

it("preserves FIFO per subscription without blocking other subscriptions", async () => {
  const host = new EventHost(new Diagnostics())
  const releaseFirst = deferred()
  const slow: string[] = []
  const fast: string[] = []

  host.subscribe("slow", event, async (value) => {
    slow.push(`start:${value.paneId}`)
    if (value.paneId === "one") await releaseFirst.promise
    slow.push(`end:${value.paneId}`)
  })
  host.subscribe("fast", event, (value) => {
    fast.push(value.paneId)
  })

  host.emit(event, payload("one"))
  host.emit(event, payload("two"))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(slow).toEqual(["start:one"])
  expect(fast).toEqual(["one", "two"])

  releaseFirst.resolve()
  await host.drain()
  expect(slow).toEqual(["start:one", "end:one", "start:two", "end:two"])
})

it("retires parked handlers and skips their queued deliveries on disposal", async () => {
  const host = new EventHost(new Diagnostics())
  const parked = new Promise<void>(() => {})
  const started = deferred()
  const oldCalls: string[] = []
  const newCalls: string[] = []

  const old = host.subscribe("old-generation", event, async (value) => {
    oldCalls.push(value.paneId)
    started.resolve()
    await parked
  })

  host.emit(event, payload("old-started"))
  await started.promise
  host.emit(event, payload("old-queued"))
  old.dispose()

  host.subscribe("new-generation", event, (value) => {
    newCalls.push(value.paneId)
  })
  host.emit(event, payload("new"))

  await settleSoon(host.drain())
  expect(oldCalls).toEqual(["old-started"])
  expect(newCalls).toEqual(["new"])
})

it("diagnoses handler errors and heals the subscription queue", async () => {
  const diagnostics = new Diagnostics()
  const host = new EventHost(diagnostics)
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  const calls: string[] = []

  host.subscribe("broken", event, (value) => {
    calls.push(value.paneId)
    if (value.paneId === "one") throw "handler exploded"
  })
  host.emit(event, payload("one"))
  host.emit(event, payload("two"))

  await host.drain()
  expect(calls).toEqual(["one", "two"])
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({
      extension: "broken",
      phase: "event",
      message: "app.pane.focused: handler exploded",
    }),
  ])
  errorSpy.mockRestore()
})

it("heals the subscription queue when diagnostic reporting fails", async () => {
  const diagnostics = {
    report() {
      throw new Error("diagnostic observer exploded")
    },
  } as unknown as Diagnostics
  const host = new EventHost(diagnostics)
  const calls: string[] = []

  host.subscribe("owner", event, (value) => {
    calls.push(value.paneId)
    if (value.paneId === "one") throw new Error("handler exploded")
  })
  host.emit(event, payload("one"))
  host.emit(event, payload("two"))

  await host.drain()
  expect(calls).toEqual(["one", "two"])
})

it("drains only work queued before the call and releases retired work", async () => {
  const host = new EventHost(new Diagnostics())
  const releaseFirst = deferred()
  const secondStarted = deferred()
  const parked = new Promise<void>(() => {})

  const subscription = host.subscribe("owner", event, async (value) => {
    if (value.paneId === "one") await releaseFirst.promise
    else {
      secondStarted.resolve()
      await parked
    }
  })

  host.emit(event, payload("one"))
  const draining = host.drain()
  host.emit(event, payload("two"))
  releaseFirst.resolve()

  await settleSoon(draining)
  await secondStarted.promise
  subscription.dispose()
  await settleSoon(host.drain())
})
