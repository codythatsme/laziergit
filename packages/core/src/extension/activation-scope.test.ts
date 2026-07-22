import { describe, expect, it, spyOn } from "bun:test"
import { StaleContextError } from "laziergit"

import { ActivationScope } from "./activation-scope"
import { Diagnostics } from "./diagnostics"

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => undefined
  let reject: Deferred<T>["reject"] = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function promiseLike<T>(
  executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void,
): PromiseLike<T> {
  return {
    // oxlint-disable-next-line unicorn/no-thenable -- This fixture intentionally exercises PromiseLike support.
    then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return new Promise<T>(executor).then(onfulfilled, onrejected)
    },
  }
}

function createScope(extension = "example") {
  const diagnostics = new Diagnostics()
  return { diagnostics, scope: new ActivationScope(extension, diagnostics) }
}

function superviseCapturedCancellation(scope: ActivationScope, promise: PromiseLike<void>) {
  const captured = { marker: true }
  return {
    reference: new WeakRef(captured),
    supervised: scope.supervise(promise, () => {
      if (!captured.marker) throw new Error("unreachable")
    }),
  }
}

async function expectCollected(reference: WeakRef<object>): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    Bun.gc(true)
    await Bun.sleep(0)
    if (reference.deref() === undefined) return
    await Bun.sleep(0)
  }
  expect(reference.deref()).toBeUndefined()
}

describe("ActivationScope finalizers", () => {
  it("starts early async disposal synchronously and close awaits the same run", async () => {
    const { scope } = createScope()
    const release = deferred<void>()
    let starts = 0
    const disposable = scope.track(async () => {
      starts += 1
      await release.promise
    })

    expect(() => disposable.dispose()).not.toThrow()
    expect(starts).toBe(1)
    expect(() => disposable.dispose()).not.toThrow()
    expect(starts).toBe(1)

    let closed = false
    const close = scope.close("deactivated")
    void close.then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)

    release.resolve(undefined)
    await close
    expect(closed).toBe(true)
    expect(starts).toBe(1)
    expect(() => disposable.dispose()).not.toThrow()
    expect(starts).toBe(1)
  })

  it("makes failing early disposal never throw and diagnoses it once", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const { diagnostics, scope } = createScope()
      let runs = 0
      const disposable = scope.track(() => {
        runs += 1
        throw new Error("early cleanup exploded")
      })

      expect(() => disposable.dispose()).not.toThrow()
      expect(() => disposable.dispose()).not.toThrow()
      await scope.close("deactivated")

      expect(runs).toBe(1)
      expect(
        diagnostics
          .getSnapshot()
          .filter((entry) => entry.phase === "dispose" && entry.message === "early cleanup exploded"),
      ).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("drains remaining finalizers sequentially in LIFO order and isolates failures", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const { diagnostics, scope } = createScope()
      const order: string[] = []
      scope.track(() => {
        order.push("first")
      })
      const failed = scope.track(() => {
        order.push("second")
        throw new Error("cleanup exploded")
      })
      scope.track(async () => {
        order.push("third:start")
        await Promise.resolve()
        order.push("third:end")
      })

      await scope.close("quit")
      failed.dispose()

      expect(order).toEqual(["third:start", "third:end", "second", "first"])
      expect(
        diagnostics.getSnapshot().filter((entry) => entry.phase === "dispose" && entry.message === "cleanup exploded"),
      ).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("memoizes close, keeps the first reason, and becomes stale before abort and finalizers", async () => {
    const { scope } = createScope("ordered")
    const observations: string[] = []

    scope.signal.addEventListener("abort", () => {
      observations.push(`abort:${scope.active}:${String(scope.signal.reason)}`)
      expect(() => scope.assertActive()).toThrow(StaleContextError)
    })
    scope.track(() => {
      observations.push(`finalizer:${scope.active}:${String(scope.signal.reason)}`)
      expect(() => scope.assertActive()).toThrow(StaleContextError)
    })

    const first = scope.close("reload")
    const second = scope.close("quit")

    expect(first).toBe(second)
    expect(scope.active).toBe(false)
    expect(scope.signal.aborted).toBe(true)
    expect(scope.signal.reason).toBe("reload")
    expect(observations).toEqual(["abort:false:reload"])

    let staleError: unknown
    try {
      scope.assertActive()
    } catch (error) {
      staleError = error
    }
    expect(staleError).toBeInstanceOf(StaleContextError)
    expect(staleError).toMatchObject({ extension: "ordered", reason: "reload" })
    expect(() => scope.track(() => undefined)).toThrow(StaleContextError)

    await first
    expect(observations).toEqual(["abort:false:reload", "finalizer:false:reload"])
  })
})

describe("ActivationScope supervision", () => {
  it("propagates normal resolution and rejection from PromiseLike values without cancelling", async () => {
    const { scope } = createScope()
    let cancellations = 0
    const cancel = () => {
      cancellations += 1
    }

    const value = await scope.supervise(
      promiseLike<number>((resolve) => resolve(42)),
      cancel,
    )
    expect(value).toBe(42)

    const failure = new Error("source rejected")
    let rejection: unknown
    try {
      await scope.supervise(
        promiseLike<never>((_resolve, reject) => reject(failure)),
        cancel,
      )
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBe(failure)

    await scope.close("deactivated")
    expect(cancellations).toBe(0)
  })

  it("cancels once on close, parks forever, and consumes a late rejection", async () => {
    const { scope } = createScope()
    const source = deferred<number>()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    try {
      let cancellations = 0
      let settled = false
      const supervised = scope.supervise(source.promise, () => {
        cancellations += 1
      })
      void supervised.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )

      const close = scope.close("quit")
      expect(close).toBe(scope.close("reload"))
      await close
      expect(cancellations).toBe(1)
      expect(settled).toBe(false)

      source.reject(new Error("late rejection"))
      await Bun.sleep(0)
      await Bun.sleep(0)

      expect(cancellations).toBe(1)
      expect(settled).toBe(false)
      expect(unhandled).toEqual([])
      expect(
        await Promise.race([
          supervised.then(
            () => "settled",
            () => "settled",
          ),
          Promise.resolve("pending"),
        ]),
      ).toBe("pending")
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("releases detached cancellation closures after normal settlement", async () => {
    const { scope } = createScope()
    const source = deferred<void>()

    const { reference, supervised } = superviseCapturedCancellation(scope, source.promise)

    source.resolve(undefined)
    await supervised
    await expectCollected(reference)
    await scope.close("deactivated")
  })
})
