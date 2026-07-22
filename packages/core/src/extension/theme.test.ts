import { describe, expect, it } from "bun:test"
import type { Theme } from "laziergit"

import { defaultTheme, ThemeStore } from "./theme"

function createTheme(overrides: Partial<Theme> = {}): Theme {
  return { ...defaultTheme, ...overrides }
}

describe("ThemeStore", () => {
  it("keeps a frozen copy of each supplied Theme", () => {
    const initial = { ...defaultTheme }
    const store = new ThemeStore(initial)
    const initialSnapshot = store.getSnapshot()

    expect(initialSnapshot).toEqual(initial)
    expect(initialSnapshot).not.toBe(initial)
    expect(Object.isFrozen(initialSnapshot)).toBe(true)

    initial.text = "#000000"
    expect(store.getSnapshot().text).toBe(defaultTheme.text)

    const replacement = { ...initial, accent: "#ffffff" }
    store.replace(replacement)
    const replacementSnapshot = store.getSnapshot()

    expect(replacementSnapshot).toEqual(replacement)
    expect(replacementSnapshot).not.toBe(replacement)
    expect(Object.isFrozen(replacementSnapshot)).toBe(true)

    replacement.accent = "#111111"
    expect(store.getSnapshot().accent).toBe("#ffffff")
  })

  it("does not notify when replacing with the identical source or snapshot", () => {
    const initial = createTheme()
    const store = new ThemeStore(initial)
    let notifications = 0
    store.subscribe(() => notifications++)

    store.replace(initial)
    store.replace(store.getSnapshot())

    expect(notifications).toBe(0)

    store.replace(createTheme())
    expect(notifications).toBe(1)
  })

  it("isolates listener failures and supports unsubscription", () => {
    const store = new ThemeStore()
    const calls: string[] = []
    const unsubscribe = store.subscribe(() => calls.push("unsubscribed"))
    unsubscribe()
    store.subscribe(() => {
      calls.push("throwing")
      throw new Error("listener exploded")
    })
    store.subscribe(() => calls.push("survivor"))

    expect(() => store.replace(createTheme({ accent: "#ffffff" }))).not.toThrow()
    expect(calls).toEqual(["throwing", "survivor"])
  })

  it("keeps Theme state isolated between store instances", () => {
    const first = new ThemeStore()
    const second = new ThemeStore()
    let secondNotifications = 0
    second.subscribe(() => secondNotifications++)

    expect(first.getSnapshot()).not.toBe(second.getSnapshot())
    first.replace(createTheme({ background: "#ffffff" }))

    expect(first.getSnapshot().background).toBe("#ffffff")
    expect(second.getSnapshot().background).toBe(defaultTheme.background)
    expect(secondNotifications).toBe(0)
  })
})
