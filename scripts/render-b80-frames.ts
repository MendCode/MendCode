import { writeFileSync } from "node:fs"
import path from "node:path"
import { b80Harness, B80_SCENES } from "../apps/cli/test/b80-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB80Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const scene of B80_SCENES) {
      const h = await b80Harness(scene, { width, height })
      try {
        const frame = h.frames.at(-1) ?? []
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${scene} ${size}`)
        const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n") + "\n"
        if (text.includes("\x1b")) throw new Error(`ANSI: ${scene}`)
        writeFileSync(path.join(directory, `${scene}-${size}.txt`), text)
      } finally { await h.close() }
    }
  }
}
