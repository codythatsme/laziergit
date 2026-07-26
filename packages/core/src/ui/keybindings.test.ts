import { expect, it, spyOn } from "bun:test"
import { createTestKeymap } from "@opentui/keymap/testing"

import type { CommandEntry } from "../extension/command-host"
import { Diagnostics } from "../extension/diagnostics"
import { installKeymap, KeybindingHost, type LiveBinding } from "./keybindings"

function entry(id: string, keys: readonly string[], pane?: string, capture = false): CommandEntry {
  return { id, owner: id.split(".")[0] ?? id, title: id, hint: id, pane, hidden: false, capture, keys }
}

function harness() {
  const keymapHarness = createTestKeymap()
  const { keymap, host } = keymapHarness
  const diagnostics = new Diagnostics()
  const uninstall = installKeymap(keymap, { diagnostics })
  const ran: string[] = []
  const bindings = new KeybindingHost(keymap, diagnostics, (id) => ran.push(id))

  return {
    host,
    diagnostics,
    keymapDiagnostics: keymapHarness.diagnostics,
    ran,
    bindings,
    /** Layer rebuilds and Command dispatch are both deferred by one microtask. */
    async flush() {
      await Promise.resolve()
      await Promise.resolve()
    },
    cleanup() {
      bindings.stop()
      uninstall()
      keymapHarness.cleanup()
    },
  }
}

it("runs the Command a global key is bound to", async () => {
  const test = harness()
  test.bindings.sync([entry("app.palette", ["mod+p"])])
  await test.flush()

  test.host.press("p", { ctrl: true })
  expect(test.ran).toEqual([])

  await test.flush()
  expect(test.ran).toEqual(["app.palette"])
  test.cleanup()
})

it("binds a Pane Command only while that Pane is focused", async () => {
  const test = harness()
  test.bindings.sync([entry("files.stage", ["s"], "files")])
  await test.flush()

  test.host.press("s")
  await test.flush()
  expect(test.ran).toEqual([])

  test.bindings.setFocusedPane("files")
  test.host.press("s")
  await test.flush()
  expect(test.ran).toEqual(["files.stage"])

  test.bindings.setFocusedPane("branches")
  test.host.press("s")
  await test.flush()
  expect(test.ran).toEqual(["files.stage"])
  test.cleanup()
})

it("goes inert while a modal owns the screen and comes back when it closes", async () => {
  const test = harness()
  test.bindings.sync([entry("app.quit", ["q"]), entry("files.stage", ["s"], "files")])
  test.bindings.setFocusedPane("files")
  await test.flush()

  test.bindings.setModalOpen(true)
  test.host.press("q")
  test.host.press("s")
  await test.flush()
  expect(test.ran).toEqual([])

  test.bindings.setModalOpen(false)
  test.host.press("q")
  await test.flush()
  expect(test.ran).toEqual(["app.quit"])
  test.cleanup()
})

it("hands the whole keyboard to a capturing Pane, except to a popup", async () => {
  const test = harness()
  test.bindings.sync([
    entry("app.quit", ["q"]),
    entry("files.stage", ["s"], "files"),
    entry("files.submit", ["ctrl+s"], "files", true),
  ])
  test.bindings.setFocusedPane("files")
  await test.flush()

  // The capture Command is inert until the Pane actually captures, so `capture: true` is
  // not a way to smuggle a key past the Pane's own mode.
  test.host.press("s", { ctrl: true })
  await test.flush()
  expect(test.ran).toEqual([])

  test.bindings.setCapturingPane("files")
  test.host.press("q")
  test.host.press("s")
  test.host.press("s", { ctrl: true })
  await test.flush()
  expect(test.ran).toEqual(["files.submit"])

  // A popup opened mid-edit outranks the capture, exactly as it outranks a Pane layer.
  test.bindings.setModalOpen(true)
  test.host.press("s", { ctrl: true })
  await test.flush()
  expect(test.ran).toEqual(["files.submit"])

  test.bindings.setModalOpen(false)
  test.bindings.setCapturingPane(null)
  test.host.press("q")
  test.host.press("s")
  await test.flush()
  expect(test.ran).toEqual(["files.submit", "app.quit", "files.stage"])
  test.cleanup()
})

it("stops enforcing a capture the moment its Pane loses focus", async () => {
  const test = harness()
  test.bindings.sync([entry("app.quit", ["q"]), entry("files.submit", ["ctrl+s"], "files", true)])
  test.bindings.setFocusedPane("files")
  test.bindings.setCapturingPane("files")
  await test.flush()

  // Nothing can leave a capturing Pane by keyboard, so this is the other door: an
  // Extension focusing elsewhere must not leave a background Pane holding the keyboard.
  test.bindings.setFocusedPane("branches")
  test.host.press("s", { ctrl: true })
  test.host.press("q")
  await test.flush()

  expect(test.ran).toEqual(["app.quit"])
  expect(test.bindings.capturingPaneId).toBeNull()
  test.cleanup()
})

it("dispatches a multi-key sequence, and a prefix on its own after the ambiguity window", async () => {
  const test = harness()
  test.bindings.sync([entry("commits.top", ["gg"], "commits"), entry("commits.open", ["g"], "commits")])
  test.bindings.setFocusedPane("commits")
  await test.flush()

  test.host.press("g")
  test.host.press("g")
  await test.flush()

  expect(test.ran).toEqual(["commits.top"])
  expect(test.keymapDiagnostics.errors).toEqual([])
  test.cleanup()
})

it("stops binding a key the catalog no longer claims", async () => {
  const test = harness()
  test.bindings.sync([entry("app.quit", ["q"])])
  await test.flush()

  test.bindings.sync([entry("app.quit", [])])
  await test.flush()
  test.host.press("q")
  await test.flush()

  expect(test.ran).toEqual([])
  test.cleanup()
})

it("coalesces a burst of catalog changes into one rebuild", async () => {
  const test = harness()
  test.bindings.sync([entry("a.one", ["a"])])
  test.bindings.sync([entry("a.one", ["a"]), entry("a.two", ["b"])])
  test.bindings.sync([entry("a.one", ["a"]), entry("a.two", ["b"]), entry("a.three", ["c"])])
  await test.flush()

  test.host.press("a")
  test.host.press("b")
  test.host.press("c")
  await test.flush()

  expect(test.ran).toEqual(["a.one", "a.two", "a.three"])
  test.cleanup()
})

it("keeps a scope working when one of its key specs is malformed", async () => {
  const test = harness()
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
  test.bindings.sync([entry("a.broken", ["ctrl+"]), entry("a.fine", ["f"])])
  await test.flush()

  test.host.press("f")
  await test.flush()

  expect(test.ran).toEqual(["a.fine"])
  expect(test.diagnostics.getSnapshot()).toEqual([
    expect.objectContaining({ phase: "keymap", message: expect.stringContaining('Invalid key "ctrl+"') }),
  ])
  errorSpy.mockRestore()
  test.cleanup()
})

it("releases every layer on stop", async () => {
  const test = harness()
  test.bindings.sync([entry("app.quit", ["q"])])
  await test.flush()

  test.bindings.stop()
  test.host.press("q")
  await test.flush()

  expect(test.ran).toEqual([])
  test.cleanup()
})

/**
 * The live-binding snapshot the hint bar reads, as `key label` pairs. Typed by the store
 * shape rather than by the host, so the harness's keymap generics stay out of it.
 */
function live(host: { getSnapshot(): readonly LiveBinding[] }): string[] {
  return host.getSnapshot().map((binding) => `${binding.key} ${binding.hint ?? binding.title}`)
}

it("publishes the focused Pane's keys, then the globals it did not shadow", () => {
  const test = harness()
  test.bindings.sync([
    entry("sync.pull", ["p"]),
    entry("app.quit", ["q"]),
    entry("stash.pop", ["p"], "stash"),
    entry("stash.drop", ["d"], "stash"),
  ])

  expect(live(test.bindings)).toEqual(["p sync.pull", "q app.quit"])

  test.bindings.setFocusedPane("stash")
  // `p` is the stash Pane's, because its layer outranks the global one — so the bar must
  // say "pop" rather than the "pull" the same key means everywhere else. `q` is claimed by
  // nobody else and stays: focusing a Pane narrows the bar, it does not empty it of
  // everything the app can still do.
  expect(live(test.bindings)).toEqual(["p stash.pop", "d stash.drop", "q app.quit"])
  test.cleanup()
})

it("keeps the layer matchers and the live set answering with one voice", async () => {
  const test = harness()
  test.bindings.sync([entry("sync.pull", ["p"]), entry("stash.pop", ["p"], "stash")])
  test.bindings.setFocusedPane("stash")
  await test.flush()

  // The bar says the stash Pane owns `p`; pressing it must run what the bar named. The two
  // read one rule, and this is the assertion that would catch them drifting apart.
  expect(live(test.bindings)[0]).toBe("p stash.pop")
  test.host.press("p")
  await test.flush()
  expect(test.ran).toEqual(["stash.pop"])
  test.cleanup()
})

it("leaves an unfocused Pane's keys out of the live set", () => {
  const test = harness()
  test.bindings.sync([entry("files.stage", ["s"], "files"), entry("branches.delete", ["d"], "branches")])

  test.bindings.setFocusedPane("files")
  expect(live(test.bindings)).toEqual(["s files.stage"])
  test.cleanup()
})

it("collapses the live set to the capturing Pane's capture Commands", () => {
  const test = harness()
  test.bindings.sync([
    entry("app.quit", ["q"]),
    entry("commit-flow.menu", ["x"], "commit-flow"),
    entry("commit-flow.submit", ["ctrl+s"], "commit-flow", true),
  ])
  test.bindings.setFocusedPane("commit-flow")
  test.bindings.setCapturingPane("commit-flow")

  expect(live(test.bindings)).toEqual(["ctrl+s commit-flow.submit"])
  test.cleanup()
})

it("empties the live set while a modal owns the screen", () => {
  const test = harness()
  test.bindings.sync([entry("app.quit", ["q"])])
  test.bindings.setModalOpen(true)
  expect(live(test.bindings)).toEqual([])

  test.bindings.setModalOpen(false)
  expect(live(test.bindings)).toEqual(["q app.quit"])
  test.cleanup()
})

it("notifies live-binding subscribers when focus moves", () => {
  const test = harness()
  let notified = 0
  const unsubscribe = test.bindings.subscribe(() => {
    notified += 1
  })
  test.bindings.sync([entry("files.stage", ["s"], "files")])
  const afterSync = notified

  test.bindings.setFocusedPane("files")
  expect(notified).toBeGreaterThan(afterSync)
  unsubscribe()
  test.cleanup()
})
