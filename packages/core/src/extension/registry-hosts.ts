import type { Disposable, StatusSegmentSpec } from "laziergit"

import { assertScopedId } from "./id"

export class MenuHost {
  readonly #menus = new Map<string, { owner: string; spec: { readonly id: string } }>()
  readonly #splices = new Set<{ owner: string; id: string; splice: unknown }>()

  register(owner: string, spec: { readonly id: string }): Disposable {
    assertScopedId(owner, spec.id)
    if (this.#menus.has(spec.id)) throw new Error(`Menu "${spec.id}" is already registered`)
    const entry = { owner, spec }
    this.#menus.set(spec.id, entry)
    return {
      dispose: () => {
        if (this.#menus.get(spec.id) === entry) this.#menus.delete(spec.id)
      },
    }
  }

  extend(owner: string, id: string, splice: unknown): Disposable {
    const entry = { owner, id, splice }
    this.#splices.add(entry)
    return { dispose: () => this.#splices.delete(entry) }
  }
}

export class StatuslineHost {
  readonly #segments = new Map<string, { owner: string; spec: StatusSegmentSpec }>()

  register(owner: string, spec: StatusSegmentSpec): Disposable {
    assertScopedId(owner, spec.id)
    if (this.#segments.has(spec.id)) throw new Error(`Status segment "${spec.id}" is already registered`)
    const entry = { owner, spec }
    this.#segments.set(spec.id, entry)
    return {
      dispose: () => {
        if (this.#segments.get(spec.id) === entry) this.#segments.delete(spec.id)
      },
    }
  }
}
