import { writeFileSync } from "node:fs"
import path from "node:path"
import { b56Harness } from "../apps/cli/test/b56-harness"
import { cleanTemps } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB56Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = b56Harness({ width, height })
    const save = (screen: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${screen} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${screen}`)
      writeFileSync(path.join(directory, `${screen}-${size}.txt`), `${rows.join("\n")}\n`)
    }
    save("chat-clickable-messages")
    await h.type("/messages\r")
    save("message-picker")
    await h.type("\r")
    save("message-actions")
    await h.type("\x1b")
    await h.type("\x1b")
    await h.type("/copy pick\r")
    save("response-picker")
    await h.type("\x1b")
    h.turns[1]!.items[1]!.truncated = true
    await h.type("/copy pick\r\r")
    save("response-truncated")
    h.turns[1]!.items[1]!.truncated = false
    await h.type("\x1b")
    await h.type("/timeline\r")
    save("timeline-actions")
    await h.type("\x1b")
    await h.type("/fork pick\r")
    save("fork-picker")
    await h.type("\x1b")
    await h.type("/export\r")
    save("export-options")
    for (let i = 0; i < 6; i++) await h.type("\t")
    await h.type(" ")
    save("export-editor")
    await h.type(" ")
    save("export-clipboard")
    await h.type("\x1b")
    await h.type(`/export\r\x15${"folder/".repeat(30)}notes.md`)
    for (let i = 0; i < 7; i++) await h.type("\t")
    save("export-long-filename")
    await h.type("\x1b")
    await h.type("/export\r\x15\r")
    save("export-error")
    await h.type("\x1b")
    await h.type("\x03")
    cleanTemps()
  }
}
