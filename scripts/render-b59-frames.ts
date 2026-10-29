import { writeFileSync } from "node:fs"
import path from "node:path"
import { b59Harness } from "../apps/cli/test/b59-harness"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB59Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b59Harness(width, height)
    await h.app.extensionsReady
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width) || rows.some((line) => /[\x00-\x1f]/.test(line))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.type("/compaction\r")
    save("compaction-empty")
    await h.app.onKey("\x1b")
    h.chat.exchange("Compact the context", "The next turn will pack the transcript into memory.")
    h.begin()
    save("chat-cockpit-writing")
    for (const compactionStyle of ["minimal", "quiet"] as const) {
      h.profile({ compactionStyle })
      save(`chat-${compactionStyle}-writing`)
    }
    h.profile({ compactionStyle: "cockpit" })
    await h.type("/customize\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("compactionStyle"); i++) await h.app.onKey("\x1b[B")
    save("customize-compaction")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\x1b[B")
    save("customize-compaction-scratchpad")
    await h.app.onKey("\x1b")
    await h.type("/compaction\r")
    save("compaction-writing")
    await h.app.onKey("e")
    await h.type("\x1b[200~Run the local tests.\nThen review the panel frames.\x1b[201~")
    save("compaction-editing")
    await h.app.onKey("\x1b")
    h.finish()
    save("compaction-packed-folded")
    await h.app.onKey("m")
    save("compaction-packed-memory")
    for (let i = 0; i < 100; i++) await h.app.onKey("\x1b[B")
    save("compaction-packed-scrolled")
    await h.app.onKey("\x1b")
    save("chat-cockpit-packed")
    for (const compactionStyle of ["minimal", "quiet"] as const) {
      h.profile({ compactionStyle })
      save(`chat-${compactionStyle}-packed`)
    }
    h.profile({ compactionStyle: "cockpit" })
    h.begin()
    await h.type("/compaction\r")
    await h.app.onKey("e")
    await h.type("\x1b[200~" + Array.from({ length: 24 }, (_, i) => `Line ${i}: retain this note.`).join("\n") + "\x1b[201~")
    save("compaction-editing-scrollbar")
    await h.app.onKey("\x1b")
    h.finish("cancelled")
    save("compaction-cancelled")
    await h.app.onKey("[")
    save("compaction-previous")
    await h.app.onKey("\x03")
  }
}
