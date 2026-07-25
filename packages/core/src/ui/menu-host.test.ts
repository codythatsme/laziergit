import { expect, it, spyOn } from "bun:test"

import { Diagnostics } from "../extension/diagnostics"
import type { Notification } from "../extension/notifier"
import { MenuHost, type MenuHostGroup } from "./menu-host"
import { PopupHost, type ActionsPopup } from "./popup-host"

function createHost() {
  const diagnostics = new Diagnostics()
  const notifications: Notification[] = []
  const popups = new PopupHost()
  return { diagnostics, notifications, popups, menus: new MenuHost(diagnostics, popups, (n) => notifications.push(n)) }
}

function openMenu(popups: PopupHost): ActionsPopup {
  const popup = popups.top
  if (popup?.kind !== "actions") throw new Error(`Expected a menu, found ${popup?.kind ?? "an empty stack"}`)
  return popup
}

function labels(popup: ActionsPopup): readonly string[] {
  return popup.groups.flatMap((group) => group.items.map((item) => `${group.title ?? "-"}/${item.key}/${item.label}`))
}

function group(title: string | undefined, ...items: readonly { key: string; label: string }[]): MenuHostGroup {
  return { id: title, title, items: items.map((item) => ({ ...item, run: () => undefined })) }
}

it("refuses a menu id outside the owning Extension's scope, and a duplicate id", () => {
  const { menus } = createHost()
  const spec = { id: "branches.actions", title: () => "Branch", groups: [] }

  expect(() => menus.register("files", spec)).toThrow(
    'Extension "files" cannot register id "branches.actions"; expected "files" or "files.*"',
  )
  menus.register("branches", spec)
  expect(() => menus.register("branches", spec)).toThrow('Menu "branches.actions" is already registered')
})

it("appends a splice to the named group and derives the title from the target", () => {
  const { menus, popups } = createHost()
  menus.register("branches", {
    id: "branches.actions",
    title: (target) => `Branch: ${String(target)}`,
    groups: [group("Manage", { key: "d", label: "Delete" })],
  })
  menus.extend("github-prs", "branches.actions", {
    group: "Manage",
    items: [{ key: "o", label: "Open PR", run: () => undefined }],
  })

  menus.open("branches", "branches.actions", "main")
  const popup = openMenu(popups)

  expect(popup.title).toBe("Branch: main")
  expect(labels(popup)).toEqual(["Manage/d/Delete", "Manage/o/Open PR"])
})

it("puts a splice with no group, or an unknown one, in a trailing group of its own", () => {
  const { menus, popups } = createHost()
  menus.register("branches", {
    id: "branches.actions",
    title: () => "Branch",
    groups: [group("Manage", { key: "d", label: "Delete" })],
  })
  menus.extend("a", "branches.actions", { items: [{ key: "x", label: "Loose", run: () => undefined }] })
  menus.extend("b", "branches.actions", {
    group: "GitHub",
    items: [{ key: "o", label: "Open PR", run: () => undefined }],
  })

  menus.open("branches", "branches.actions", null)

  expect(labels(openMenu(popups))).toEqual(["Manage/d/Delete", "-/x/Loose", "GitHub/o/Open PR"])
})

it("resolves a key claimed twice across the whole menu, not group by group", () => {
  const { menus, popups, diagnostics } = createHost()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  menus.register("branches", {
    id: "branches.actions",
    title: () => "Branch",
    groups: [group("Manage", { key: "d", label: "Delete branch" })],
  })
  menus.extend("github-prs", "branches.actions", {
    group: "GitHub",
    items: [{ key: "d", label: "Draft PR", run: () => undefined }],
  })

  menus.open("branches", "branches.actions", null)

  expect(labels(openMenu(popups))).toEqual(["GitHub/d/Draft PR"])
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({
      phase: "menu",
      message: 'Menu "branches.actions" key "d" moved from "Delete branch" to "Draft PR"',
    }),
  ])
  errorSpy.mockRestore()
})

it("reports a standing key conflict once, however often the menu is opened", () => {
  const { menus, diagnostics } = createHost()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  menus.register("branches", {
    id: "branches.actions",
    title: () => "Branch",
    groups: [group("Manage", { key: "d", label: "Delete branch" })],
  })
  menus.extend("github-prs", "branches.actions", {
    group: "GitHub",
    items: [{ key: "d", label: "Draft PR", run: () => undefined }],
  })

  menus.open("branches", "branches.actions", null)
  menus.open("branches", "branches.actions", null)
  menus.open("branches", "branches.actions", null)

  expect(diagnostics.getSnapshot()).toHaveLength(1)
  errorSpy.mockRestore()
})

it("hides an item whose `when` says no, and treats a throwing `when` as hidden", () => {
  const { menus, popups, diagnostics } = createHost()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  menus.register("branches", {
    id: "branches.actions",
    title: () => "Branch",
    groups: [
      {
        title: "Manage",
        items: [
          { key: "d", label: "Delete", when: () => false, run: () => undefined },
          {
            key: "e",
            label: "Explode",
            when: () => {
              throw new Error("when exploded")
            },
            run: () => undefined,
          },
          { key: "k", label: "Keep", run: () => undefined },
        ],
      },
    ],
  })

  menus.open("branches", "branches.actions", null)

  expect(labels(openMenu(popups))).toEqual(["Manage/k/Keep"])
  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ phase: "menu", message: expect.stringContaining("when(): when exploded") }),
  ])
  errorSpy.mockRestore()
})

it("lets an item hidden by `when` leave its key to another item", () => {
  const { menus, popups } = createHost()
  menus.register("branches", {
    id: "branches.actions",
    title: () => "Branch",
    groups: [
      {
        title: "Manage",
        items: [
          { key: "d", label: "Delete", run: () => undefined },
          { key: "d", label: "Discard", when: () => false, run: () => undefined },
        ],
      },
    ],
  })

  menus.open("branches", "branches.actions", null)

  expect(labels(openMenu(popups))).toEqual(["Manage/d/Delete"])
})

it("closes the menu for every Extension whose items are showing", () => {
  const { menus, popups } = createHost()
  menus.register("branches", {
    id: "branches.actions",
    title: () => "Branch",
    groups: [group("Manage", { key: "d", label: "Delete" })],
  })
  menus.extend("github-prs", "branches.actions", {
    group: "GitHub",
    items: [{ key: "o", label: "Open PR", run: () => undefined }],
  })

  menus.open("files", "branches.actions", null)
  popups.closeForExtension("github-prs")

  expect(popups.getSnapshot()).toEqual([])
})

it("reports an item that throws while running, without breaking the menu", async () => {
  const { menus, popups, diagnostics, notifications } = createHost()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  menus.register("branches", {
    id: "branches.actions",
    title: () => "Branch",
    groups: [
      {
        title: "Manage",
        items: [
          {
            key: "d",
            label: "Delete",
            run: () => {
              throw new Error("delete exploded")
            },
          },
        ],
      },
    ],
  })

  menus.open("branches", "branches.actions", null)
  const item = openMenu(popups).groups[0]?.items[0]
  await item?.run()

  expect(diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ phase: "menu", message: expect.stringContaining("delete exploded") }),
  ])
  expect(notifications).toEqual([{ extension: "branches", message: "Delete: delete exploded", level: "error" }])
  errorSpy.mockRestore()
})

it("refuses to open an id nothing has registered", () => {
  const { menus } = createHost()

  expect(() => menus.open("files", "branches.actions", null)).toThrow('No menu registered for "branches.actions"')
})

it("keeps a splice for an owner that registers later, and drops it with the splicer", () => {
  const { menus, popups } = createHost()
  const splice = menus.extend("github-prs", "branches.actions", {
    group: "GitHub",
    items: [{ key: "o", label: "Open PR", run: () => undefined }],
  })
  menus.register("branches", { id: "branches.actions", title: () => "Branch", groups: [] })

  menus.open("branches", "branches.actions", null)
  expect(labels(openMenu(popups))).toEqual(["GitHub/o/Open PR"])
  popups.closeAll()

  splice.dispose()
  menus.open("branches", "branches.actions", null)
  expect(openMenu(popups).groups).toEqual([])
})

it("renders a one-off menu with the same rules and no registry entry", () => {
  const { menus, popups } = createHost()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)

  menus.adhoc("files", "Pick", [group("Group", { key: "a", label: "First" }, { key: "a", label: "Second" })])

  expect(openMenu(popups).title).toBe("Pick")
  expect(labels(openMenu(popups))).toEqual(["Group/a/Second"])
  errorSpy.mockRestore()
})
