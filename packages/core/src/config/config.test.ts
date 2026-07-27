import { expect, it } from "bun:test"
import { option } from "laziergit"

import { defaultTheme, findThemePreset } from "../extension/theme"
import { loadConfig, resolveExtensionConfig, type ConfigDocument } from "./config"

function documents(global: string | null, repo: string | null): readonly ConfigDocument[] {
  return [
    { path: "/global/config.jsonc", text: global },
    { path: "/repo/config.jsonc", text: repo },
  ]
}

it("merges repo settings over global ones, replacing arrays and merging objects", () => {
  const loaded = loadConfig(
    documents(
      `{
        "layout": { "columns": [["status", "files"], ["diff"]] },
        "keybindings": { "files.stage": "s", "sync.push": "P" },
        "theme": { "accent": "#111111" },
        "extensions": { "gh-workflows": { "limit": 15, "view": "unified" } }
      }`,
      `{
        "layout": { "columns": [["status"]] },
        "keybindings": { "sync.push": null },
        "extensions": { "gh-workflows": { "limit": 30 } }
      }`,
    ),
  )

  expect(loaded.problems).toEqual([])
  expect(loaded.core.layout).toEqual({ columns: [{ weight: 1, cells: [["status"]] }], focus: null })
  expect(loaded.core.keybindings.get("files.stage")).toEqual(["s"])
  expect(loaded.core.keybindings.get("sync.push")).toEqual([])
  expect(loaded.core.theme.accent).toBe("#111111")
  expect(loaded.core.theme.text).toBe(defaultTheme.text)
  expect(loaded.extensions.get("gh-workflows")).toEqual({ limit: 30, view: "unified" })
})

it("reads both Layout column forms and tab groups", () => {
  const loaded = loadConfig(
    documents(
      `{
        "layout": {
          "columns": [
            ["status", ["files", "stash"]],
            { "weight": 2, "cells": ["diff"] }
          ]
        }
      }`,
      null,
    ),
  )

  expect(loaded.problems).toEqual([])
  expect(loaded.core.layout).toEqual({
    columns: [
      { weight: 1, cells: [["status"], ["files", "stash"]] },
      { weight: 2, cells: [["diff"]] },
    ],
    focus: null,
  })
})

it("degrades every rejected value to its default and keeps the rest of the document", () => {
  const loaded = loadConfig(
    documents(
      `{
        "layout": { "columns": [["ok"], 7, { "cells": ["fine"], "weight": -1 }] },
        "keybindings": { "a.b": 3 },
        "theme": { "accent": "#222222", "nonsense": "#000000" },
        "statusline": { "left": "status", "hidden": ["noisy"] },
        "leader": "",
        "typo": true
      }`,
      null,
    ),
  )

  expect(loaded.problems.map((problem) => problem.path)).toEqual([
    "typo",
    "layout.columns[1]",
    "layout.columns[2].weight",
    "keybindings.a.b",
    "theme.nonsense",
    "statusline.left",
    "leader",
  ])
  expect(loaded.core.layout).toEqual({
    columns: [
      { weight: 1, cells: [["ok"]] },
      { weight: 1, cells: [["fine"]] },
    ],
    focus: null,
  })
  expect(loaded.core.theme.accent).toBe("#222222")
  expect(loaded.core.statusline).toEqual({ left: [], right: [], hidden: new Set(["noisy"]) })
  expect(loaded.core.leader).toBe("space")
})

it("skips an unparseable file and still applies the other one", () => {
  const loaded = loadConfig(documents(`{ "leader": }`, `{ "leader": "comma" }`))

  expect(loaded.problems).toEqual([
    { path: "/global/config.jsonc", message: 'Unexpected "}" where a value was expected (line 1, column 13)' },
  ])
  expect(loaded.core.leader).toBe("comma")
})

it("keeps the other file when one is unreadable, and reports why", () => {
  const loaded = loadConfig([
    { path: "/global/config.jsonc", text: null, unreadable: "EACCES: permission denied" },
    { path: "/repo/config.jsonc", text: `{ "leader": "comma" }` },
  ])

  expect(loaded.problems).toEqual([{ path: "/global/config.jsonc", message: "EACCES: permission denied" }])
  expect(loaded.core.leader).toBe("comma")
})

it("treats an empty or comments-only file as contributing nothing", () => {
  const loaded = loadConfig(documents(`{ "leader": "comma" }`, "// nothing configured yet\n"))

  expect(loaded.problems).toEqual([])
  expect(loaded.core.leader).toBe("comma")
  expect(loadConfig(documents("", "")).core.leader).toBe("space")
})

it("cannot be made to reparent the merged document with a __proto__ key", () => {
  const loaded = loadConfig(documents(`{ "leader": "comma" }`, `{ "__proto__": { "leader": "x", "typo": 1 } }`))

  expect(loaded.core.leader).toBe("comma")
  expect(loaded.problems.map((problem) => problem.path)).toEqual(["__proto__"])
  expect(Object.getPrototypeOf({})).toBe(Object.prototype)
})

it("rejects an inherited property name as a theme token", () => {
  const loaded = loadConfig(documents(`{ "theme": { "toString": "#ff0000" } }`, null))

  expect(loaded.problems).toEqual([{ path: "theme.toString", message: "Unknown theme token" }])
  expect(Object.prototype.toString.call(loaded.core.theme)).toBe("[object Object]")
})

it("bases a theme on the named preset and applies token overrides on top of it", () => {
  const beacon = findThemePreset("beacon")
  if (beacon === undefined) throw new Error("the beacon preset should be registered")

  const loaded = loadConfig(documents(`{ "theme": { "preset": "beacon", "accent": "#123456" } }`, null))

  expect(loaded.problems).toEqual([])
  // The preset supplies every token the user did not name...
  expect(loaded.core.theme.background).toBe(beacon.tokens.background)
  expect(loaded.core.theme.text).toBe(beacon.tokens.text)
  // ...and the override wins over the preset, not merely over the default.
  expect(loaded.core.theme.accent).toBe("#123456")
  expect(loaded.core.theme.accent).not.toBe(beacon.tokens.accent)
})

it("falls back to the default palette when the named preset does not exist", () => {
  const loaded = loadConfig(documents(`{ "theme": { "preset": "vaporwave", "accent": "#123456" } }`, null))

  expect(loaded.problems).toHaveLength(1)
  expect(loaded.problems[0]?.path).toBe("theme.preset")
  expect(loaded.problems[0]?.message).toContain("nocturne")
  // A typo costs the user that field: the rest come from the default rather than nothing.
  expect(loaded.core.theme.accent).toBe("#123456")
  expect(loaded.core.theme.background).toBe(defaultTheme.background)
})

it("reports a misspelled key in the Layout, in a Layout column, and in the status line", () => {
  const loaded = loadConfig(
    documents(
      null,
      `{
        "layout": { "colums": [["status", "files"]], "columns": [{ "cells": ["diff"], "wieght": 2 }] },
        "statusline": { "lft": ["branch"] }
      }`,
    ),
  )

  // The published schema closes all three of these sections, so a typo the editor underlines
  // must not load as a silently empty Layout with nothing said about it.
  expect(loaded.problems).toEqual([
    { path: "layout.colums", message: "Unknown Layout setting" },
    { path: "layout.columns[0].wieght", message: "Unknown Layout column setting" },
    { path: "statusline.lft", message: "Unknown statusline setting" },
  ])
})

it("validates an Extension section against its own schema, falling back per option", () => {
  const schema = {
    limit: option.number({ default: 15, min: 1, max: 100 }),
    view: option.enum(["unified", "split"], { default: "unified" }),
    labels: option.stringArray({ default: ["ci"] }),
    enabled: option.boolean({ default: true }),
  }

  const resolved = resolveExtensionConfig("gh-workflows", schema, {
    limit: 500,
    view: "split",
    labels: ["a", 2],
    stray: 1,
  })

  expect(resolved.values).toEqual({ limit: 15, view: "split", labels: ["ci"], enabled: true })
  expect(resolved.problems).toEqual([
    { path: "extensions.gh-workflows.limit", message: "Must be at most 100" },
    { path: "extensions.gh-workflows.labels", message: "Expected an array of strings" },
    { path: "extensions.gh-workflows.stray", message: "Unknown option" },
  ])
})

it("defaults the git section, and degrades each of its settings on its own", () => {
  expect(loadConfig(documents(null, null)).core.git).toEqual({ refreshIntervalMs: 2000, commitLimit: 200 })

  const loaded = loadConfig(documents(`{ "git": { "refreshIntervalMs": 10, "commitLimit": 50, "typo": 1 } }`, null))

  // A rejected interval must not also drag the perfectly good commit window back to its default.
  expect(loaded.core.git).toEqual({ refreshIntervalMs: 2000, commitLimit: 50 })
  expect(loaded.problems).toEqual([
    { path: "git.typo", message: "Unknown git setting" },
    { path: "git.refreshIntervalMs", message: "Must be at least 250" },
  ])
})

it("rejects a git section that is not an object, and a fractional interval", () => {
  expect(loadConfig(documents(`{ "git": 5 }`, null)).problems).toEqual([
    { path: "git", message: "git must be an object of git settings" },
  ])
  expect(loadConfig(documents(`{ "git": { "commitLimit": 1.5 } }`, null)).problems).toEqual([
    { path: "git.commitLimit", message: "Expected a whole number" },
  ])
})

it("does not read an Extension option off Object.prototype", () => {
  // Through `loadConfig`, because the hazard is the section object the loader rebuilds: an
  // object literal here would carry the prototype whatever the loader does.
  const loaded = loadConfig(documents(null, `{ "extensions": { "labels": { "limit": 5 } } }`))
  const resolved = resolveExtensionConfig(
    "labels",
    { toString: option.string({ default: "plain" }), limit: option.number({ default: 15 }) },
    loaded.extensions.get("labels"),
  )

  expect(resolved.values).toEqual({ toString: "plain", limit: 5 })
  expect(resolved.problems).toEqual([])
})

it("produces total defaults for an Extension with no config section", () => {
  const resolved = resolveExtensionConfig("branch-age", { days: option.number({ default: 30 }) }, undefined)

  expect(resolved).toEqual({ values: { days: 30 }, problems: [] })
})

it("reads the startup focus, and rejects one that is not a Pane id", () => {
  const loaded = loadConfig(documents(null, `{ "layout": { "columns": [["status"], ["files"]], "focus": "files" } }`))

  expect(loaded.problems).toEqual([])
  expect(loaded.core.layout?.focus).toBe("files")

  const rejected = loadConfig(documents(null, `{ "layout": { "columns": [["status"]], "focus": 3 } }`))
  expect(rejected.problems.map((problem) => problem.path)).toEqual(["layout.focus"])
  // Degraded by one setting, never by the whole section: the columns still apply.
  expect(rejected.core.layout?.columns).toHaveLength(1)
  expect(rejected.core.layout?.focus).toBeNull()
})

it("keeps a Layout that says only where to start, leaving placement to the hints", () => {
  const loaded = loadConfig(documents(null, `{ "layout": { "focus": "files" } }`))

  // With no `columns`, every Pane still lands on its Extension's hint and this only says
  // which one opens focused.
  expect(loaded.problems).toEqual([])
  expect(loaded.core.layout).toEqual({ columns: [], focus: "files" })
})

it("still reports a columns value it cannot use", () => {
  const loaded = loadConfig(documents(null, `{ "layout": { "columns": "left and right" } }`))

  expect(loaded.problems.map((problem) => problem.path)).toEqual(["layout.columns"])
  expect(loaded.core.layout).toBeNull()
})
