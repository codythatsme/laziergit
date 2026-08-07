import { describe, expect, it } from "bun:test"

import {
  availableSides,
  chooseConflict,
  createConflictSession,
  moveConflict,
  moveSide,
  parseConflicts,
  replaceConflictSession,
  splitLines,
  undoConflict,
} from "./conflicts"

const ordinary = `before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nafter\n`

function present<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value")
  return value
}

describe("conflict parser", () => {
  it("finds multiple ordinary and diff3 blocks", () => {
    const parsed = parseConflicts(
      ordinary + `<<<<<<< ours\ncurrent\n||||||| base\nancestor\n=======\nincoming\n>>>>>>> theirs\n`,
    )
    expect(parsed.kind).toBe("ready")
    if (parsed.kind !== "ready") return
    expect(parsed.conflicts).toHaveLength(2)
    expect(availableSides(present(parsed.conflicts[1] ?? null))).toEqual(["current", "ancestor", "incoming"])
  })

  it("preserves CRLF and a missing final newline", () => {
    expect(splitLines("a\r\nb")).toEqual(["a\r\n", "b"])
    const session = createConflictSession("<<<<<<< a\r\nA\r\n=======\r\nB\r\n>>>>>>> b")
    expect(session).not.toBeNull()
    const selected = chooseConflict(present(session), "incoming")
    expect(selected.session).toBeNull()
    expect(selected.content).toBe("B\r\n")
  })

  it("rejects nested, mismatched, and unclosed markers", () => {
    expect(parseConflicts("<<<<<<< a\n<<<<<<< b\n").kind).toBe("malformed")
    expect(parseConflicts("<<<<<<< a\n=======\n>>>>>>>> b\n").kind).toBe("malformed")
    expect(parseConflicts("<<<<<<< a\n=======\n").kind).toBe("malformed")
  })
})

describe("conflict session", () => {
  it("chooses current, incoming, and both without marker lines", () => {
    const current = present(createConflictSession(ordinary))
    expect(chooseConflict(current, "current")).toEqual({ content: "before\nours\nafter\n", session: null })

    const both = present(
      createConflictSession(ordinary + `<<<<<<< ours\ntop\n||||||| base\nold\n=======\nbottom\n>>>>>>> theirs\n`),
    )
    const first = present(chooseConflict(both, "both").session)
    expect(first.content).toContain("ours\ntheirs\n")
    expect(first.content).not.toContain("<<<<<<< HEAD")
    const next = chooseConflict(first, "both")
    expect(next.session).toBeNull()
    expect(next.content).toContain("top\nbottom\n")
    expect(next.content).not.toContain("old\n")
  })

  it("clamps navigation and retains the preferred side", () => {
    const session = present(createConflictSession(ordinary + ordinary, "incoming"))
    expect(moveSide(session, 10).side).toBe("incoming")
    expect(moveSide(session, -10).side).toBe("current")
    expect(moveConflict(session, 10).conflictIndex).toBe(1)
    expect(moveConflict(session, -10).conflictIndex).toBe(0)
  })

  it("undoes a pick after another conflict remains", () => {
    const session = present(createConflictSession(ordinary + ordinary))
    const picked = present(chooseConflict(session, "incoming").session)
    expect(picked.conflicts).toHaveLength(1)
    const undone = undoConflict(picked)
    expect(undone.content).toBe(session.content)
    expect(undone.conflicts).toHaveLength(2)
  })

  it("keeps navigation and undo across unchanged refreshes, but drops stale undo after an external edit", () => {
    const original = moveConflict(present(createConflictSession(ordinary + ordinary + ordinary, "incoming")), 2)
    const picked = present(chooseConflict(original, "incoming").session)
    expect(picked.conflictIndex).toBe(1)
    expect(picked.undo).toHaveLength(1)

    expect(replaceConflictSession(picked, picked.content)).toBe(picked)

    const changed = present(replaceConflictSession(picked, `${picked.content}external\n`))
    expect(changed.conflictIndex).toBe(1)
    expect(changed.side).toBe("incoming")
    expect(changed.undo).toEqual([])
  })
})
