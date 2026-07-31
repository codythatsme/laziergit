import { expect, it } from "bun:test"

import {
  PopupHost,
  type ChoosePopup,
  type ComposePopup,
  type ConfirmPopup,
  type Popup,
  type PromptPopup,
} from "./popup-host"

function confirmPopup(popup: Popup | undefined): ConfirmPopup {
  if (popup?.kind !== "confirm") throw new Error(`Expected a confirm popup, found ${popup?.kind ?? "an empty stack"}`)
  return popup
}

function promptPopup(popup: Popup | undefined): PromptPopup {
  if (popup?.kind !== "prompt") throw new Error(`Expected a prompt popup, found ${popup?.kind ?? "an empty stack"}`)
  return popup
}

function composePopup(popup: Popup | undefined): ComposePopup {
  if (popup?.kind !== "compose") throw new Error(`Expected a compose popup, found ${popup?.kind ?? "an empty stack"}`)
  return popup
}

function choosePopup(popup: Popup | undefined): ChoosePopup {
  if (popup?.kind !== "choose") throw new Error(`Expected a choose popup, found ${popup?.kind ?? "an empty stack"}`)
  return popup
}

function titles(host: PopupHost): readonly string[] {
  return host.getSnapshot().map((popup) => popup.title)
}

it("stacks a confirm popup and resolves it with the confirmed outcome", async () => {
  const host = new PopupHost()

  const handle = host.confirm("owner", { title: "Discard changes", message: "This cannot be undone", danger: true })
  const popup = confirmPopup(host.top)

  expect(host.getSnapshot()).toEqual([popup])
  expect(popup).toEqual(
    expect.objectContaining({ title: "Discard changes", message: "This cannot be undone", danger: true }),
  )
  popup.confirm()

  expect(await handle.promise).toBe(true)
  expect(host.getSnapshot()).toEqual([])
})

it("defaults a confirm's label and danger flag, and forwards the caller's validator", () => {
  const host = new PopupHost()

  host.confirm("owner", { title: "Push" })
  const confirm = confirmPopup(host.top)
  expect(confirm).toEqual(expect.objectContaining({ confirmLabel: "Confirm", danger: false, message: undefined }))
  confirm.dismiss()

  host.prompt("owner", { title: "Name", validate: (value) => (value === "" ? "Required" : null) })
  const validated = promptPopup(host.top)
  expect(validated.validate("")).toBe("Required")
  expect(validated.validate("ok")).toBeNull()
  expect(validated.initial).toBe("")
  validated.dismiss()

  host.prompt("owner", { title: "Anything" })
  expect(promptPopup(host.top).validate("")).toBeNull()
})

it("stacks a prompt popup and resolves it with the submitted value", async () => {
  const host = new PopupHost()

  const handle = host.prompt("owner", { title: "Branch name", placeholder: "feature/…", initial: "feature/" })
  const popup = promptPopup(host.top)

  expect(host.getSnapshot()).toEqual([popup])
  expect(popup).toEqual(
    expect.objectContaining({ title: "Branch name", placeholder: "feature/…", initial: "feature/" }),
  )
  popup.submit("feature/popups")

  expect(await handle.promise).toBe("feature/popups")
  expect(host.getSnapshot()).toEqual([])
})

it("composes a summary and description while reporting draft changes", async () => {
  const host = new PopupHost()
  const drafts: string[] = []
  const handle = host.compose("owner", {
    title: "Commit",
    summaryTitle: "Commit summary",
    descriptionTitle: "Commit description",
    initial: "subject\n\nbody",
    validate: (value) => (value.trim().length === 0 ? "Required" : null),
    onChange: (value) => drafts.push(value),
  })
  const popup = composePopup(host.top)

  expect(popup).toEqual(
    expect.objectContaining({
      title: "Commit",
      summaryTitle: "Commit summary",
      descriptionTitle: "Commit description",
      initial: "subject\n\nbody",
    }),
  )
  expect(popup.validate("")).toBe("Required")
  popup.change("new subject\n\nnew body")
  popup.submit("new subject\n\nnew body")

  expect(drafts).toEqual(["new subject\n\nnew body"])
  expect(await handle.promise).toBe("new subject\n\nnew body")
  expect(host.getSnapshot()).toEqual([])
})

it("replaces an owner's open composer and settles the displaced call", async () => {
  const host = new PopupHost()
  const first = host.compose("owner", { title: "First" })
  const second = host.compose("owner", { title: "Second" })

  expect(await first.promise).toBeUndefined()
  expect(titles(host)).toEqual(["Second"])

  second.dismiss()
  expect(await second.promise).toBeUndefined()
})

it("stacks a choose popup and resolves it with the chosen index", async () => {
  const host = new PopupHost()

  const handle = host.choose("owner", { title: "Checkout", choices: [{ label: "main" }, { label: "wip" }] })
  const popup = choosePopup(host.top)

  expect(host.getSnapshot()).toEqual([popup])
  expect(popup.choices).toEqual([{ label: "main" }, { label: "wip" }])
  popup.choose(1)

  expect(await handle.promise).toBe(1)
  expect(host.getSnapshot()).toEqual([])
})

it("reports choose highlights and clears a preview when the popup settles", async () => {
  const host = new PopupHost()
  const highlights: Array<number | undefined> = []
  const chosen = host.choose("owner", {
    title: "Theme",
    choices: [{ label: "Nocturne" }, { label: "Daybreak" }],
    onHighlight: (index) => highlights.push(index),
  })
  const popup = choosePopup(host.top)

  popup.highlight(0)
  popup.highlight(1)
  popup.choose(1)
  popup.highlight(0)

  expect(await chosen.promise).toBe(1)
  expect(highlights).toEqual([0, 1, undefined])
})

it("clears a choose preview exactly once on cancellation and contains observer failures", async () => {
  const host = new PopupHost()
  const highlights: Array<number | undefined> = []
  const cancelled = host.choose("owner", {
    title: "Theme",
    choices: [{ label: "Nocturne" }],
    onHighlight: (index) => {
      highlights.push(index)
      throw new Error("preview failed")
    },
  })
  const popup = choosePopup(host.top)

  popup.highlight(0)
  cancelled.dismiss()
  cancelled.dismiss()

  expect(await cancelled.promise).toBeUndefined()
  expect(highlights).toEqual([0, undefined])
  expect(host.getSnapshot()).toEqual([])
})

it("stacks an actions popup carrying its groups until it is closed", async () => {
  const host = new PopupHost()
  const groups = [{ title: "Branch", items: [{ key: "d", label: "Delete", run: () => undefined }] }]

  const handle = host.actions("owner", { title: "Branch menu", groups })
  const popup = host.top

  expect(host.getSnapshot()).toEqual([expect.objectContaining({ kind: "actions", title: "Branch menu", groups })])
  popup?.dismiss()

  expect(await handle.promise).toBeUndefined()
  expect(host.getSnapshot()).toEqual([])
})

it("stacks a cheat sheet popup carrying its sections until it is closed", async () => {
  const host = new PopupHost()
  const sections = [{ title: "Files", entries: [{ keys: ["space"], title: "Stage" }] }]

  const handle = host.cheatSheet("owner", "Keybindings", sections)
  const popup = host.top

  expect(host.getSnapshot()).toEqual([expect.objectContaining({ kind: "cheatsheet", title: "Keybindings", sections })])
  popup?.dismiss()

  expect(await handle.promise).toBeUndefined()
  expect(host.getSnapshot()).toEqual([])
})

it("resolves every popup kind with its cancelled outcome when dismissed", async () => {
  const host = new PopupHost()
  const confirm = host.confirm("owner", { title: "Confirm" })
  const prompt = host.prompt("owner", { title: "Prompt" })
  const compose = host.compose("owner", { title: "Compose" })
  const choose = host.choose("owner", { title: "Choose", choices: [{ label: "only" }] })
  const actions = host.actions("owner", { title: "Actions", groups: [] })
  const cheatSheet = host.cheatSheet("owner", "Cheat sheet", [])

  for (const handle of [confirm, prompt, compose, choose, actions, cheatSheet]) handle.dismiss()

  expect(await confirm.promise).toBe(false)
  expect(await prompt.promise).toBeUndefined()
  expect(await compose.promise).toBeUndefined()
  expect(await choose.promise).toBeUndefined()
  expect(await actions.promise).toBeUndefined()
  expect(await cheatSheet.promise).toBeUndefined()
  expect(host.getSnapshot()).toEqual([])
})

it("ignores every dismissal after a popup has already settled", async () => {
  const host = new PopupHost()
  const handle = host.confirm("owner", { title: "Discard changes" })
  const popup = confirmPopup(host.top)
  let publishes = 0
  host.subscribe(() => {
    publishes += 1
  })

  popup.confirm()
  handle.dismiss()
  popup.dismiss()
  handle.dismiss()

  expect(await handle.promise).toBe(true)
  expect(host.getSnapshot()).toEqual([])
  expect(publishes).toBe(1)
})

it("closes only the top of the stack, leaving the popup underneath open", async () => {
  const host = new PopupHost()
  const under = host.confirm("owner", { title: "Under" })
  const over = host.prompt("owner", { title: "Over" })

  host.dismissTop()

  expect(await over.promise).toBeUndefined()
  expect(titles(host)).toEqual(["Under"])

  host.dismissTop()

  expect(await under.promise).toBe(false)
  expect(host.top).toBeUndefined()
})

it("closes a popup when any of its contributing Extensions goes down, sparing the others", async () => {
  const host = new PopupHost()
  const unrelated = host.confirm("other", { title: "Unrelated" })
  const spliced = host.actions("a", { title: "Menu", groups: [], contributors: ["b"] })

  host.closeForExtension("b")

  expect(await spliced.promise).toBeUndefined()
  expect(titles(host)).toEqual(["Unrelated"])

  const reopened = host.actions("a", { title: "Menu", groups: [], contributors: ["b"] })
  host.closeForExtension("a")

  expect(await reopened.promise).toBeUndefined()
  expect(titles(host)).toEqual(["Unrelated"])

  host.closeForExtension("other")

  expect(await unrelated.promise).toBe(false)
  expect(host.getSnapshot()).toEqual([])
})

it("empties the stack when everything is closed at once", async () => {
  const host = new PopupHost()
  const confirm = host.confirm("a", { title: "Confirm" })
  const prompt = host.prompt("b", { title: "Prompt" })

  host.closeAll()

  expect(host.getSnapshot()).toEqual([])
  expect(await confirm.promise).toBe(false)
  expect(await prompt.promise).toBeUndefined()
})

it("reports the screen modal on the first popup and clear after the last one, containing listener failures", async () => {
  const host = new PopupHost()
  const modal: boolean[] = []
  host.setModalListener((open) => {
    modal.push(open)
    throw new Error("modal listener exploded")
  })

  const under = host.confirm("owner", { title: "Under" })
  const over = host.confirm("owner", { title: "Over" })
  expect(titles(host)).toEqual(["Under", "Over"])

  over.dismiss()
  under.dismiss()

  expect(await over.promise).toBe(false)
  expect(await under.promise).toBe(false)
  expect(host.getSnapshot()).toEqual([])
  expect(modal).toEqual([true, true, true, false])
})

it("isolates snapshot listener failures", async () => {
  const host = new PopupHost()
  let healthyCalls = 0
  host.subscribe(() => {
    throw new Error("snapshot listener exploded")
  })
  host.subscribe(() => {
    healthyCalls += 1
  })

  const handle = host.confirm("owner", { title: "Discard changes" })
  expect(healthyCalls).toBe(1)
  expect(titles(host)).toEqual(["Discard changes"])

  handle.dismiss()

  expect(healthyCalls).toBe(2)
  expect(await handle.promise).toBe(false)
  expect(host.getSnapshot()).toEqual([])
})

it("resolves choose with the index into the original choices, not the filtered view", async () => {
  const host = new PopupHost()
  const choices = [{ label: "main" }, { label: "release" }, { label: "renovate", hint: "remote" }]

  const handle = host.choose("owner", { title: "Checkout", choices, placeholder: "Filter branches" })
  const popup = choosePopup(host.top)
  const filtered = popup.choices.filter((choice) => choice.label.startsWith("re"))
  const picked = filtered[1]
  if (picked === undefined) throw new Error("Expected the filter to keep two choices")
  popup.choose(popup.choices.indexOf(picked))

  expect(await handle.promise).toBe(2)
})
