import { describe, expect, it } from "bun:test"

import { createPatchSession, movePatchCursor, selectPatch, togglePatchMode, togglePatchRange } from "./patch"

const patch = `diff --git a/file.txt b/file.txt
index 123..456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,5 @@
 one
-two
+TWO
 three
+four
 five
`

function present<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value")
  return value
}

describe("patch selection", () => {
  it("selects one addition while retaining old content for unselected removals", () => {
    let session = present(createPatchSession(patch))
    session = movePatchCursor(session, 1)
    expect(selectPatch(session)).toBe(`diff --git a/file.txt b/file.txt
index 123..456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,5 @@
 one
 two
+TWO
 three
 five
`)
  })

  it("selects the complete hunk", () => {
    const session = togglePatchMode(present(createPatchSession(patch)))
    expect(selectPatch(session)).toBe(patch)
  })

  it("selects a contiguous range", () => {
    let session = togglePatchRange(present(createPatchSession(patch)))
    session = movePatchCursor(session, 1)
    const selected = present(selectPatch(session))
    expect(selected).toContain("-two\n+TWO")
    expect(selected).not.toContain("+four")
  })

  it("handles partial new files and no-final-newline metadata", () => {
    const source = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+first
+second
\\ No newline at end of file
`
    const session = present(createPatchSession(source))
    expect(selectPatch(session)).toBe(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+first
`)
  })

  it("turns partial reverse-new and forward-deletion patches into ordinary modifications", () => {
    const added = present(
      createPatchSession(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+first
+second
`),
    )
    expect(selectPatch(added, { reverse: true })).toBe(`diff --git a/new.txt b/new.txt
--- a/new.txt
+++ b/new.txt
@@ -1,1 +1,2 @@
+first
 second
`)

    const deleted = present(
      createPatchSession(`diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
`),
    )
    expect(selectPatch(deleted)).toBe(`diff --git a/old.txt b/old.txt
--- a/old.txt
+++ b/old.txt
@@ -1,2 +1,1 @@
-first
 second
`)
  })

  it("keeps a partial reverse-deletion patch valid by restoring only the selected line", () => {
    const deleted = present(
      createPatchSession(`diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
`),
    )

    expect(selectPatch(deleted, { reverse: true })).toBe(`diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-first
`)
  })
})
