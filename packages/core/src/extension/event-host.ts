import type { Disposable, EventMap } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"

interface Subscription {
  readonly owner: string
  readonly handler: (payload: unknown) => void | Promise<void>
  readonly disposed: Promise<void>
  resolveDisposed(): void
  tail: Promise<void>
  isDisposed: boolean
}

export class EventHost {
  readonly #diagnostics: Diagnostics
  readonly #subscriptions = new Map<string, Set<Subscription>>()
  readonly #pending = new Set<Promise<void>>()

  constructor(diagnostics: Diagnostics) {
    this.#diagnostics = diagnostics
  }

  subscribe<K extends keyof EventMap & string>(
    owner: string,
    event: K,
    handler: (payload: EventMap[K]) => void | Promise<void>,
  ): Disposable {
    const subscriptions = this.#subscriptions.get(event) ?? new Set<Subscription>()
    let resolveDisposed = () => {}
    const disposed = new Promise<void>((resolve) => {
      resolveDisposed = resolve
    })
    const subscription: Subscription = {
      owner,
      handler: handler as Subscription["handler"],
      disposed,
      resolveDisposed,
      tail: Promise.resolve(),
      isDisposed: false,
    }
    subscriptions.add(subscription)
    this.#subscriptions.set(event, subscriptions)

    return {
      dispose: () => {
        if (subscription.isDisposed) return
        subscription.isDisposed = true
        subscriptions.delete(subscription)
        if (subscriptions.size === 0) this.#subscriptions.delete(event)
        subscription.resolveDisposed()
      },
    }
  }

  emit(event: string, payload: unknown): void {
    const subscriptions = [...(this.#subscriptions.get(event) ?? [])]
    for (const subscription of subscriptions) this.#enqueue(subscription, event, payload)
  }

  async drain(): Promise<void> {
    await Promise.all(this.#pending)
  }

  #enqueue(subscription: Subscription, event: string, payload: unknown): void {
    const delivery = subscription.tail.then(async () => {
      if (subscription.isDisposed) return

      let result: void | Promise<void>
      try {
        result = subscription.handler(payload)
      } catch (error) {
        this.#reportHandlerError(subscription.owner, event, error)
        return
      }

      const handled = Promise.resolve(result).catch((error: unknown) => {
        this.#reportHandlerError(subscription.owner, event, error)
      })
      await Promise.race([handled, subscription.disposed])
    })

    subscription.tail = delivery
    this.#pending.add(delivery)
    void delivery.then(() => this.#pending.delete(delivery))
  }

  #reportHandlerError(owner: string, event: string, error: unknown): void {
    const normalized = normalizeError(error)
    try {
      this.#diagnostics.report({
        extension: owner,
        phase: "event",
        message: `${event}: ${normalized.message}`,
        error: normalized,
      })
    } catch {
      // Diagnostics are best-effort and must never poison a subscription queue.
    }
  }
}
