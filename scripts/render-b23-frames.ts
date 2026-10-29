import { writeFileSync } from "node:fs"
import path from "node:path"
import { compactionB23Harness } from "../apps/cli/test/b23-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB23Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const method of ["legacy", "incremental", "native", "fallback"]) {
      const h = compactionB23Harness(width, height, method === "fallback" ? "incremental" : method, method === "fallback" ? "http" : undefined)
      await h.app.extensionsReady
      const save = (screen: string) => {
        h.app.render()
        const frame = h.frames.at(-1) ?? []
        const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
        if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width) || rows.some((line) => /[\x00-\x1f]/.test(line))) throw new Error(`invalid frame: ${screen} ${size}`)
        writeFileSync(path.join(directory, `${screen}-${method}-${size}.txt`), rows.join("\n") + "\n")
      }
      save("chat-writing")
      await h.type("/compaction\r")
      save("compaction-writing")
      h.finish()
      await h.app.onKey("m")
      save("compaction-packed")
      await h.app.onKey("\x1b")
      await h.app.onKey("\x03")
    }
  }
}
