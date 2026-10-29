import { writeFileSync } from "node:fs"
import path from "node:path"
import { b38Harness } from "../apps/cli/test/b38-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB38Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = await b38Harness(width, height)
    try {
      const save = (screen: string) => {
        h.app.render()
        const frame = h.frames.at(-1) ?? []
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`frame exceeds ${size}: ${screen}`)
        const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (rows.some((row) => row.includes("\x1b"))) throw new Error("ANSI in frame")
        writeFileSync(path.join(directory, `${screen}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      save("plugin-slot")
      await h.type("/extensions\r")
      await h.key("\r")
      save("extensions-plugin-metadata")
      await h.key("\x1b")
      await h.type("/plugin-review\r")
      save("plugin-route")
    } finally { await h.cleanup() }
  }
}
