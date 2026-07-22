import type { Disposable } from "laziergit"

import { normalizeError, type Diagnostics } from "../extension/diagnostics"
import { assertScopedId } from "../extension/id"
import type { Notifier } from "../extension/notifier"
import type { PopupAction, PopupActionGroup, PopupHandle, PopupHost } from "./popup-host"

/**
 * The Menu types with their target erased. Menus are data, and the data is uniform at
 * runtime; only the public {@link MenuMap} keeps each menu's target type honest at the
 * `register`/`extend`/`open` boundary. `when` and `run` are declared as methods so a
 * typed `MenuItem<Branch>` still satisfies them.
 */
export interface MenuHostItem {
  readonly key: string
  readonly label: string
  when?(target: unknown): boolean
  run(target: unknown): void | Promise<void>
}

export interface MenuHostGroup {
  readonly id?: string
  readonly title?: string
  readonly items: readonly MenuHostItem[]
}

export interface MenuHostSpec {
  readonly id: string
  title(target: unknown): string
  readonly groups: readonly MenuHostGroup[]
}

export interface MenuSplice {
  readonly group?: string
  readonly items: readonly MenuHostItem[]
}

interface RegisteredMenu {
  readonly owner: string
  readonly spec: MenuHostSpec
}

interface RegisteredSplice {
  readonly owner: string
  readonly id: string
  readonly splice: MenuSplice
}

interface OwnedItem {
  readonly owner: string
  readonly item: MenuHostItem
}

interface DraftGroup {
  readonly id: string | undefined
  readonly title: string | undefined
  readonly items: OwnedItem[]
}

function groupKey(group: { readonly id?: string; readonly title?: string }): string | undefined {
  return group.id ?? group.title
}

/**
 * Menus as data. An Extension owns its menu ids; anyone may splice into any id, and a
 * splice is standing data keyed by the id rather than by the menu instance — so it
 * survives the owner's hot reloads and is disposed with the splicer instead.
 */
export class MenuHost {
  readonly #menus = new Map<string, RegisteredMenu>()
  readonly #splices = new Set<RegisteredSplice>()
  readonly #diagnostics: Diagnostics
  readonly #popups: PopupHost
  readonly #notify: Notifier

  constructor(diagnostics: Diagnostics, popups: PopupHost, notify: Notifier) {
    this.#diagnostics = diagnostics
    this.#popups = popups
    this.#notify = notify
  }

  register(owner: string, spec: MenuHostSpec): Disposable {
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

  extend(owner: string, id: string, splice: MenuSplice): Disposable {
    const entry = { owner, id, splice }
    this.#splices.add(entry)
    return { dispose: () => this.#splices.delete(entry) }
  }

  /**
   * Opens a menu for one target. What the user sees is a snapshot of the merged spec
   * taken now, so no later registration can change the keys under their fingers.
   */
  open(opener: string, id: string, target: unknown): PopupHandle<void> {
    const menu = this.#menus.get(id)
    if (!menu) throw new Error(`No menu registered for "${id}"`)

    const rendered = this.#render(id, this.#mergeGroups(menu, id), target)
    return this.#popups.actions(opener, {
      title: this.#titleOf(menu, target, id),
      groups: rendered.groups,
      contributors: new Set([menu.owner, ...rendered.contributors]),
    })
  }

  /**
   * A one-off menu (`ctx.popups.menu`): the same data shape and the same error, key
   * conflict, and visibility handling, without a {@link MenuMap} entry to splice into.
   */
  adhoc(owner: string, title: string, groups: readonly MenuHostGroup[]): PopupHandle<void> {
    const drafts = groups.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.map((item) => ({ owner, item })),
    }))
    const rendered = this.#render(title, drafts, undefined)
    return this.#popups.actions(owner, { title, groups: rendered.groups })
  }

  #render(
    id: string,
    groups: readonly DraftGroup[],
    target: unknown,
  ): { readonly groups: readonly PopupActionGroup[]; readonly contributors: ReadonlySet<string> } {
    const contributors = new Set<string>()
    const rendered: PopupActionGroup[] = []

    // An open menu is one keyspace — every item's key is bound on the same modal layer —
    // so conflicts resolve across the whole merged menu, not group by group. Visibility
    // is settled first: an item `when` hides never contests a key.
    const visible = groups.map((group) => group.items.filter((owned) => this.#isVisible(owned, target, id)))
    const winners = this.#resolveConflicts(visible.flat(), id)

    for (const [index, group] of groups.entries()) {
      const items: PopupAction[] = []
      for (const owned of visible[index] ?? []) {
        if (!winners.has(owned)) continue
        contributors.add(owned.owner)
        items.push(this.#toAction(owned, target, id))
      }
      if (items.length > 0) rendered.push({ title: group.title, items })
    }
    return { groups: rendered, contributors }
  }

  #mergeGroups(menu: RegisteredMenu, id: string): readonly DraftGroup[] {
    const drafts: DraftGroup[] = menu.spec.groups.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.map((item) => ({ owner: menu.owner, item })),
    }))

    for (const splice of this.#splices) {
      if (splice.id !== id) continue
      const owned = splice.splice.items.map((item) => ({ owner: splice.owner, item }))
      const wanted = splice.splice.group
      const existing = wanted === undefined ? undefined : drafts.find((draft) => groupKey(draft) === wanted)

      if (existing) existing.items.push(...owned)
      else drafts.push({ id: wanted, title: wanted, items: owned })
    }
    return drafts
  }

  /** Two items claiming one key: the later registration wins, mirroring the keymap. */
  #resolveConflicts(items: readonly OwnedItem[], id: string): ReadonlySet<OwnedItem> {
    const byKey = new Map<string, OwnedItem>()
    for (const owned of items) {
      const previous = byKey.get(owned.item.key)
      if (previous) {
        this.#report(
          owned.owner,
          `Menu "${id}" key "${owned.item.key}" moved from "${previous.item.label}" to "${owned.item.label}"`,
        )
      }
      byKey.set(owned.item.key, owned)
    }
    return new Set(byKey.values())
  }

  #isVisible(owned: OwnedItem, target: unknown, id: string): boolean {
    try {
      return owned.item.when?.(target) ?? true
    } catch (error) {
      const normalized = normalizeError(error)
      this.#report(owned.owner, `Menu "${id}" item "${owned.item.label}" when(): ${normalized.message}`, normalized)
      return false
    }
  }

  #toAction(owned: OwnedItem, target: unknown, id: string): PopupAction {
    return {
      key: owned.item.key,
      label: owned.item.label,
      run: async () => {
        try {
          await owned.item.run(target)
        } catch (error) {
          const normalized = normalizeError(error)
          this.#report(owned.owner, `Menu "${id}" item "${owned.item.label}": ${normalized.message}`, normalized)
          try {
            this.#notify({
              extension: owned.owner,
              message: `${owned.item.label}: ${normalized.message}`,
              level: "error",
            })
          } catch {
            // Custom notification adapters are isolated from menu dispatch.
          }
        }
      },
    }
  }

  #titleOf(menu: RegisteredMenu, target: unknown, id: string): string {
    try {
      return menu.spec.title(target)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#report(menu.owner, `Menu "${id}" title(): ${normalized.message}`, normalized)
      return id
    }
  }

  #report(owner: string, message: string, error?: Error): void {
    try {
      this.#diagnostics.report({ extension: owner, phase: "menu", message, error })
    } catch {
      // Diagnostics are observers and cannot poison menu rendering.
    }
  }
}
