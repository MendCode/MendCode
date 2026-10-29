import { writeFileSync } from "node:fs"
import path from "node:path"
import { drawImageScene, imageSceneResult, IMAGE_SCENES } from "../apps/cli/test/image-generation-fixture"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB501Frames(directory: string, sizes: string[]) {
  for (const scene of IMAGE_SCENES) {
    const result = await imageSceneResult(scene)
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const h = drawImageScene(width, height, scene, result), frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${scene} ${size}`)
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${scene}`)
      writeFileSync(path.join(directory, `${scene}-${size}.txt`), `${rows.join("\n")}\n`)
      await h.app.onKey("\x03")
      await h.app.onKey("\x03")
    }
  }
}
