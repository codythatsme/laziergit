import type { PopupToolkit } from "laziergit"

export type NotificationLevel = NonNullable<Parameters<PopupToolkit["notify"]>[1]>

export interface Notification {
  readonly extension: string
  readonly message: string
  readonly level: NotificationLevel
}

export type NotificationPublisher = (notification: Notification) => void
export type Notifier = (notification: Notification) => void

function publishToConsole(notification: Notification): void {
  console.error(`[${notification.extension}] ${notification.level}: ${notification.message}`)
}

export function createNotifier(publish: NotificationPublisher = publishToConsole): Notifier {
  return (notification) => {
    try {
      publish(notification)
    } catch {
      // Notifications are best-effort until M2 supplies a toast publisher.
    }
  }
}

export function bindNotifier(notifier: Notifier, extension: string): PopupToolkit["notify"] {
  return (message, level = "info") => {
    notifier({ extension, message, level })
  }
}
