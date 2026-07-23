import { Effect, Exit, Scope } from "effect"
import { StaleContextError, type Disposable, type StaleReason } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"

type Finalizer = () => void | Promise<void>
type FinalizerState = "pending" | "running" | "done" | "detached"

interface FinalizerRecord {
  finalizer: Finalizer | undefined
  state: FinalizerState
  completion: Promise<void> | undefined
}

const completed = Promise.resolve()

export class ActivationScope {
  readonly #controller = new AbortController()
  readonly #effectScope = Scope.makeUnsafe("sequential")
  readonly #diagnostics: Diagnostics
  readonly #finalizers: FinalizerRecord[] = []
  readonly extension: string
  #reason: StaleReason | undefined
  #closePromise: Promise<void> | undefined

  constructor(extension: string, diagnostics: Diagnostics) {
    this.extension = extension
    this.#diagnostics = diagnostics

    Effect.runSync(
      Scope.addFinalizer(
        this.#effectScope,
        Effect.promise(() => this.#drain()),
      ),
    )
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get active(): boolean {
    return this.#reason === undefined
  }

  assertActive(): void {
    if (this.#reason !== undefined) throw new StaleContextError(this.extension, this.#reason)
  }

  track(finalizer: Finalizer): Disposable {
    this.assertActive()
    const record = this.#register(finalizer)

    return {
      dispose: () => {
        void this.#run(record)
      },
    }
  }

  supervise<T>(promise: PromiseLike<T>, cancel?: () => void): Promise<T> {
    this.assertActive()

    return new Promise<T>((resolve, reject) => {
      let settlement: { resolve(value: T): void; reject(error: unknown): void } | undefined = {
        resolve,
        reject,
      }
      const registration = this.#register(() => {
        settlement = undefined
        return cancel?.()
      })

      Promise.resolve(promise).then(
        (value) => {
          const current = settlement
          if (!current || !this.active || !this.#detach(registration)) return
          settlement = undefined
          current.resolve(value)
        },
        (error: unknown) => {
          const current = settlement
          if (!current || !this.active || !this.#detach(registration)) return
          settlement = undefined
          current.reject(error)
        },
      )
    })
  }

  /**
   * Runs a fully-provided Effect under this activation's lifetime — the one door behind
   * `ctx.effect.runPromise`. The scope's AbortSignal is handed to the runtime, so closing
   * the scope interrupts the fiber for real (finalizers included) rather than merely
   * abandoning its result; {@link supervise} then parks the promise, so the interruption
   * never surfaces as a rejection in Extension code.
   */
  runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
    this.assertActive()
    const running = Effect.runPromise(effect, { signal: this.#controller.signal })
    // Tracked as a finalizer as well as supervised, so `close()` waits for the fiber to
    // finish unwinding — an interrupted fiber's own finalizers (a killed child process,
    // a released resource) must complete before the extension is declared torn down.
    const settled = this.track(() => running.then(undefined, () => undefined))
    return this.supervise(running.finally(() => settled.dispose()))
  }

  close(reason: StaleReason): Promise<void> {
    if (this.#closePromise) return this.#closePromise

    this.#reason = reason
    const closePromise = Promise.resolve().then(() => Effect.runPromise(Scope.close(this.#effectScope, Exit.void)))
    this.#closePromise = closePromise
    this.#controller.abort(reason)
    return closePromise
  }

  guard<T extends object>(target: T, staleNoops: readonly PropertyKey[] = []): T {
    const noops = new Set(staleNoops)
    const assertActive = () => this.assertActive()
    const isActive = () => this.active

    return new Proxy(target, {
      get(value, property, receiver) {
        if (!isActive() && noops.has(property)) return () => undefined
        assertActive()
        const member = Reflect.get(value, property, receiver) as unknown

        if (typeof member !== "function") return member

        return (...args: unknown[]) => {
          if (!isActive() && noops.has(property)) return undefined
          assertActive()
          return Reflect.apply(member, value, args) as unknown
        }
      },
      apply(value, thisArg, args) {
        assertActive()
        return Reflect.apply(value as (...values: unknown[]) => unknown, thisArg, args) as unknown
      },
    })
  }

  #register(finalizer: Finalizer): FinalizerRecord {
    const record: FinalizerRecord = {
      finalizer,
      state: "pending",
      completion: undefined,
    }
    this.#finalizers.push(record)
    return record
  }

  #detach(record: FinalizerRecord): boolean {
    if (record.state !== "pending") return false

    record.state = "detached"
    record.finalizer = undefined
    this.#remove(record)
    return true
  }

  #remove(record: FinalizerRecord): void {
    const index = this.#finalizers.indexOf(record)
    if (index !== -1) this.#finalizers.splice(index, 1)
  }

  #run(record: FinalizerRecord): Promise<void> {
    if (record.state === "running") return record.completion ?? completed
    if (record.state !== "pending") return completed

    record.state = "running"
    const finalizer = record.finalizer
    record.finalizer = undefined

    let resolveCompletion: () => void = () => undefined
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    record.completion = completion

    const finish = () => {
      this.#remove(record)
      record.state = "done"
      record.completion = undefined
      resolveCompletion()
    }

    try {
      Promise.resolve(finalizer?.()).then(finish, (error: unknown) => {
        this.#reportFinalizerFailure(error)
        finish()
      })
    } catch (error) {
      this.#reportFinalizerFailure(error)
      finish()
    }

    return completion
  }

  async #drain(): Promise<void> {
    while (this.#finalizers.length > 0) {
      const record = this.#finalizers.pop()
      if (record) await this.#run(record)
    }
  }

  #reportFinalizerFailure(error: unknown): void {
    try {
      const normalized = normalizeError(error)
      this.#diagnostics.report({
        extension: this.extension,
        phase: "dispose",
        message: normalized.message,
        error: normalized,
      })
    } catch {
      // Cleanup must continue even if diagnostics itself fails.
    }
  }
}
