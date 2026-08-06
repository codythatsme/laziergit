import { describe, expect, it } from "bun:test"

import { authorColor, authorInitials } from "./authors"

describe("author initials", () => {
  it.each([
    ["Jesse Duffield", "JD"],
    ["Jesse Duffield Man", "JD"],
    ["JesseDuffield", "Je"],
    ["J", "J"],
    ["六书六書", "六"],
    ["書", "書"],
    ["", ""],
  ])("matches lazygit for %j", (author, expected) => {
    expect(authorInitials(author)).toBe(expected)
  })

  it("keeps a wide grapheme together", () => {
    expect(authorInitials("👩🏽‍💻 Ada")).toBe("👩🏽‍💻")
  })
})

describe("author colors", () => {
  it("matches lazygit's stable MD5/HSL truecolors", () => {
    expect(authorColor("Ada Lovelace")).toBe("#eb5a2d")
    expect(authorColor("Grace Hopper")).toBe("#cb0cdc")
    expect(authorColor("Jesse Duffield")).toBe("#2fe402")
  })

  it("keeps one author stable while distinguishing different authors", () => {
    expect(authorColor("Ada Lovelace")).toBe(authorColor("Ada Lovelace"))
    expect(authorColor("Ada Lovelace")).not.toBe(authorColor("Grace Hopper"))
  })
})
