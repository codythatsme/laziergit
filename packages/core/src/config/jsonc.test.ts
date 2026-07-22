import { expect, it } from "bun:test"

import { JsoncSyntaxError, parseJsonc } from "./jsonc"

it("reads JSON with comments, trailing commas, and escapes", () => {
  const document = parseJsonc(`﻿{
    // the leading comment
    "layout": { "columns": [["status"], ["diff"],] }, /* inline */
    "quoted": "a \\"b\\" /* not a comment */ \\u00e9\\n",
    "numbers": [0, -1.5, 2e3, 1E-2],
    "flags": { "on": true, "off": false, "missing": null },
  }`)

  expect(document).toEqual({
    layout: { columns: [["status"], ["diff"]] },
    quoted: 'a "b" /* not a comment */ é\n',
    numbers: [0, -1.5, 2000, 0.01],
    flags: { on: true, off: false, missing: null },
  })
})

it("gives objects a null prototype so a __proto__ key cannot reach Object.prototype", () => {
  const document = parseJsonc(`{ "__proto__": { "polluted": true } }`)

  expect(Object.getPrototypeOf(document)).toBeNull()
  expect(Object.keys({}).length).toBe(0)
  expect(Object.entries(document as Record<string, unknown>)).toEqual([["__proto__", { polluted: true }]])
})

it.each([
  ["{ 'single': 1 }", 1, 3],
  ['{ "a": 1 "b": 2 }', 1, 10],
  ['{ "a": }', 1, 8],
  ['{ "a": 1 }\n{ "b": 2 }', 2, 1],
  ['{\n  "a": "unterminated\n}', 2, 21],
  ['{ "a": 1 } /* open', 1, 12],
  ['{ "a": 01 }', 1, 9],
])("reports %p at line %p column %p", (source, line, column) => {
  try {
    parseJsonc(source)
    throw new Error("Expected a syntax error")
  } catch (error) {
    expect(error).toBeInstanceOf(JsoncSyntaxError)
    expect(error).toMatchObject({ line, column })
  }
})
