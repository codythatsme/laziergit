import { expect, test } from "bun:test"
import { NativeImage } from "@opentui/core"

import { githubMarkSource } from "./github-mark"

test("embeds contrasting light and dark GitHub marks", async () => {
  const light = githubMarkSource("#ffffff")
  const dark = githubMarkSource("#000000")
  expect(light).not.toBe(dark)

  const images = await Promise.all([NativeImage.load(light), NativeImage.load(dark)])
  try {
    expect(images.map((image) => [image.width, image.height])).toEqual([
      [32, 32],
      [32, 32],
    ])
  } finally {
    for (const image of images) image.dispose()
  }
})
