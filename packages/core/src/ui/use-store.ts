import { useSyncExternalStore } from "react"

/**
 * The shape every laziergit host exposes for React: a snapshot plus a subscription.
 * Both are declared `this: void` because {@link useSyncExternalStore} calls them
 * unbound — which is exactly why the hosts define them as bound arrow properties.
 */
export interface ExternalStore<T> {
  getSnapshot(this: void): T
  subscribe(this: void, listener: () => void): () => void
}

export function useStore<T>(store: ExternalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
