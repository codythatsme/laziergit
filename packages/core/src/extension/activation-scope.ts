import { Effect, Exit, Scope } from "effect"
import { StaleContextError, type Disposable, type StaleReason } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"

type Finalizer = () => void | Promise<void>

export class ActivationScope {
  readonly #controller = new AbortController()
  readonly #effectScope = Scope.makeUnsafe("sequential")
  readonly #diagnostics: Diagnostics
  readonly extension: string
  #reason: StaleReason | undefined

  constructor(extension: string, diagnostics: Diagnostics) {
    this.extension = extension
    this.#diagnostics = diagnostics
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get active(): boolean {
    return this.#reason === undefined
  }

  assertActive(): void {
    if (this.#reason) throw new StaleContextError(this.extension, this.#reason)
  }

  track(finalizer: Finalizer): Disposable {
    let disposed = false
    const run = async () => {
      if (disposed) return
      disposed = true
      try {
        await finalizer()
      } catch (error) {
        const normalized = normalizeError(error)
        this.#diagnostics.report({
          extension: this.extension,
          phase: "dispose",
          message: normalized.message,
          error: normalized,
        })
      }
    }

    Effect.runSync(Scope.addFinalizer(this.#effectScope, Effect.promise(run)))

    return {
      dispose() {
        void run()
      },
    }
  }

  supervise<T>(promise: Promise<T>, cancel?: () => void): Promise<T> {
    this.assertActive()

    return new Promise<T>((resolve, reject) => {
      let parked = false
      const registration = this.track(() => {
        parked = true
        cancel?.()
      })

      promise.then(
        (value) => {
          registration.dispose()
          if (!parked && this.active) resolve(value)
        },
        (error: unknown) => {
          registration.dispose()
          if (!parked && this.active) reject(error)
        },
      )
    })
  }

  async close(reason: StaleReason): Promise<void> {
    if (this.#reason) return
    this.#controller.abort(reason)
    await Effect.runPromise(Scope.close(this.#effectScope, Exit.void))
    this.#reason = reason
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
    })
  }
}
