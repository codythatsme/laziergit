import { expect, it } from "bun:test"
import { option } from "laziergit"

import { defaultTheme } from "../extension/theme"
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
  expect(loaded.core.layout).toEqual({ columns: [{ weight: 1, cells: [["status"]] }] })
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
  expect(`${loaded.core.theme}`).toBe("[object Object]")
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

it("produces total defaults for an Extension with no config section", () => {
  const resolved = resolveExtensionConfig("branch-age", { days: option.number({ default: 30 }) }, undefined)

  expect(resolved).toEqual({ values: { days: 30 }, problems: [] })
})
