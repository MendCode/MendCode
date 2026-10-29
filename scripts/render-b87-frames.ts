import { writeFileSync } from "node:fs"
import path from "node:path"
import { b87Harness } from "../apps/cli/test/b87-harness"
import { cleanTemps } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB87Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = b87Harness({ width, height })
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
    }
    h.revise(h.answerId, { status: "ok", text: "## Storage revisions\n\nThe transcript now shows the corrected answer. Original events remain in the audit log." })
    save("chat-revised")
    h.revise(h.userId, { status: "ok", text: "Review the revised storage contract", attachments: [] })
    save("chat-part-deleted")
    await h.type("/history\r")
    save("history-revised")
    await h.type("\r")
    save("history-reader-revised")
    h.revise(h.answerId, { status: "ok", text: "" }, true, 2)
    save("history-reader-deleted")
    await h.type("\x1b\x1b")
    save("chat-message-deleted")
    await h.type("/timeline\r")
    save("timeline-revised")
    await h.type("\x1b\x03")
    cleanTemps()
  }
}
