import type { Notification, NotificationLevel } from "../extension/notifier"

export interface Toast {
  readonly id: number
  readonly extension: string
  readonly message: string
  readonly level: NotificationLevel
}

const defaultLifetimeMs = 4_000
const maxVisible = 4

/**
 * The `ctx.popups.notify` queue: transient, never focus-stealing, and capped so a
 * misbehaving Extension cannot paper over the screen. Toasts expire on a timer that is
 * cleared at shutdown, because a pending timer would keep the process alive after quit.
 */
export class NotificationHost {
  readonly #listeners = new Set<() => void>()
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>()
  readonly #lifetimeMs: number
  #toasts: readonly Toast[] = []
  #nextId = 1
  #stopped = false

  constructor(lifetimeMs: number = defaultLifetimeMs) {
    this.#lifetimeMs = lifetimeMs
  }

  getSnapshot = (): readonly Toast[] => this.#toasts

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  publish = (notification: Notification): void => {
    if (this.#stopped) return

    const toast: Toast = { id: this.#nextId++, ...notification }
    const kept = [...this.#toasts, toast].slice(-maxVisible)
    for (const dropped of this.#toasts) {
      if (!kept.includes(dropped)) this.#clearTimer(dropped.id)
    }
    this.#toasts = kept

    const timer = setTimeout(() => this.dismiss(toast.id), this.#lifetimeMs)
    timer.unref?.()
    this.#timers.set(toast.id, timer)
    this.#publish()
  }

  dismiss(id: number): void {
    this.#clearTimer(id)
    const remaining = this.#toasts.filter((toast) => toast.id !== id)
    if (remaining.length === this.#toasts.length) return
    this.#toasts = remaining
    this.#publish()
  }

  stop(): void {
    this.#stopped = true
    for (const id of Array.from(this.#timers.keys())) this.#clearTimer(id)
    this.#toasts = []
    this.#publish()
  }

  #clearTimer(id: number): void {
    const timer = this.#timers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#timers.delete(id)
  }

  #publish(): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // Snapshot observers cannot poison the notification queue.
      }
    }
  }
}
