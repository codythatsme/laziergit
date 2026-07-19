import type { Disposable, EventMap } from "laziergit"

import { normalizeError, type Diagnostics } from "./diagnostics"

interface Subscription {
  readonly owner: string
  readonly handler: (payload: unknown) => void | Promise<void>
}

export class EventHost {
  readonly #diagnostics: Diagnostics
  readonly #subscriptions = new Map<string, Set<Subscription>>()
  #tail = Promise.resolve()

  constructor(diagnostics: Diagnostics) {
    this.#diagnostics = diagnostics
  }

  subscribe<K extends keyof EventMap & string>(
    owner: string,
    event: K,
    handler: (payload: EventMap[K]) => void | Promise<void>,
  ): Disposable {
    const subscriptions = this.#subscriptions.get(event) ?? new Set<Subscription>()
    const subscription: Subscription = { owner, handler: handler as Subscription["handler"] }
    subscriptions.add(subscription)
    this.#subscriptions.set(event, subscriptions)

    return {
      dispose: () => {
        subscriptions.delete(subscription)
        if (subscriptions.size === 0) this.#subscriptions.delete(event)
      },
    }
  }

  emit(event: string, payload: unknown): void {
    this.#tail = this.#tail.then(async () => {
      for (const subscription of this.#subscriptions.get(event) ?? []) {
        try {
          await subscription.handler(payload)
        } catch (error) {
          const normalized = normalizeError(error)
          this.#diagnostics.report({
            extension: subscription.owner,
            phase: "event",
            message: `${event}: ${normalized.message}`,
            error: normalized,
          })
        }
      }
    })
  }

  async drain(): Promise<void> {
    await this.#tail
  }
}
