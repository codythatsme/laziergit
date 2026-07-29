import { expect, it } from "bun:test"

import { filterMatchIndices, searchMatchIndices, smartCaseIncludes } from "./list-query"

it("uses smart case for substring matching", () => {
  expect(smartCaseIncludes("Feature/APPLE", "apple")).toBe(true)
  expect(smartCaseIncludes("Feature/APPLE", "Apple")).toBe(false)
  expect(smartCaseIncludes("Feature/Apple", "Apple")).toBe(true)
})

it("filters by required whitespace-separated terms without reordering the source", () => {
  const items = ["integration-testing", "test integration", "integrated fixture", "unit test"]

  expect(filterMatchIndices(items, "int test", (item) => item)).toEqual([0, 1])
  expect(filterMatchIndices(items, "TEST int", (item) => item)).toEqual([])
  expect(filterMatchIndices(items, "", (item) => item)).toEqual([0, 1, 2, 3])
})

it("joins an item's fields before filtering", () => {
  const items = [
    { name: "feature", upstream: "origin/main" },
    { name: "main", upstream: "origin/main" },
  ]

  expect(filterMatchIndices(items, "feature origin", (item) => [item.name, item.upstream])).toEqual([0])
})

it("searches for one contiguous smart-case string", () => {
  const items = ["one", "two words", "words two", "THREE"]

  expect(searchMatchIndices(items, "two w", (item) => item)).toEqual([1])
  expect(searchMatchIndices(items, "three", (item) => item)).toEqual([3])
  expect(searchMatchIndices(items, "Three", (item) => item)).toEqual([])
  expect(searchMatchIndices(items, "", (item) => item)).toEqual([])
})
