import { expect, it } from "bun:test"
import type { HostListQueryState } from "laziergit/host"

import { ListQueryHost } from "./list-query-host"

const inactive: HostListQueryState = {
  mode: "filter",
  value: "",
  editing: false,
  matchCount: 3,
  totalCount: 3,
  currentMatch: null,
}

it("publishes only the focused Pane's active query", () => {
  const host = new ListQueryHost()
  const files = host.register("files", "files", () => undefined, inactive)
  host.register("branches", "branches", () => undefined, {
    ...inactive,
    value: "main",
    matchCount: 1,
  })

  host.setFocusedPane("files")
  expect(host.getSnapshot()).toBeNull()

  files.update({ ...inactive, editing: true })
  expect(host.getSnapshot()).toMatchObject({ paneId: "files", id: "files", editing: true })

  host.setFocusedPane("branches")
  expect(host.getSnapshot()).toMatchObject({ paneId: "branches", value: "main" })
})

it("retires a registration idempotently and contains throwing observers", () => {
  const host = new ListQueryHost()
  host.setFocusedPane("files")
  let healthy = 0
  host.subscribe(() => {
    throw new Error("observer failed")
  })
  host.subscribe(() => {
    healthy += 1
  })

  const registration = host.register("files", "files", () => undefined, { ...inactive, editing: true })
  expect(healthy).toBe(1)
  registration.dispose()
  registration.dispose()
  expect(healthy).toBe(2)
  expect(host.getSnapshot()).toBeNull()
})

it("refuses duplicate ids within one Pane", () => {
  const host = new ListQueryHost()
  host.register("files", "files", () => undefined, inactive)
  expect(() => host.register("files", "files", () => undefined, inactive)).toThrow(
    'List query "files" is already registered in Pane "files"',
  )
})
