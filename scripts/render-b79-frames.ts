import { writeFileSync } from "node:fs"
import path from "node:path"
import { b79Harness, B79_SELECTION } from "../apps/cli/test/b79-harness"
import { conversation } from "../apps/cli/test/session-ui-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { fit } from "../apps/cli/src/view/deck"

export async function renderB79Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const h = b79Harness({ width: Number(match[1]), height: Number(match[2]) })
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      const text = frame.map((row) => fit(row, h.size.width).map((span) => span.text).join("")).join("\n")
      if (frame.length !== h.size.height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > h.size.width) || text.includes("\x1b")) throw new Error(`invalid frame ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    try {
      await h.type("/ide\r")
      save("ide-off")
      let loaded!: () => void
      h.control.queryGate = new Promise<void>((resolve) => { loaded = resolve })
      await h.app.onKey("\x1b")
      const opening = h.app.onInput("/ide\r")
      await Bun.sleep(1)
      save("ide-loading")
      loaded()
      await opening
      delete h.control.queryGate
      await h.app.onKey("e")
      save("ide-pending")
      await h.app.onKey("\x1b[6~")
      save("ide-selection-scrolled")
      await h.app.onKey("\x1b[5~")
      await h.app.onKey("\x1b")
      save("chat-ide-pending")
      await h.type("Review the selected authorization code\r")
      conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Review the selected authorization code", "The current check accepts any nonempty token. Validate its signature and expiry.")
      save("chat-ide-sent")
      await h.type("/ide\r")
      save("ide-sent")
      await h.app.onKey("c")
      save("ide-cleared")
      await h.app.onKey("\x1b")
      save("chat-ide-cleared")
      h.control.report.selection = { ...structuredClone(B79_SELECTION), ranges: [{ text: "", selection: { start: { line: 29, character: 3 }, end: { line: 29, character: 3 } } }] }
      await h.type("/ide\r")
      save("ide-cursor")
      h.control.report = { editor: "zed", enabled: true, status: "unavailable", message: "Zed database cannot be read" }
      await h.app.onKey("r")
      save("ide-unavailable")
      h.control.report = { editor: "zed", enabled: true, status: "empty" }
      await h.app.onKey("r")
      save("ide-empty")
      h.control.report = { editor: "zed", enabled: true, status: "connected", selection: structuredClone(B79_SELECTION) }
      await h.app.onKey("r")
      h.control.openError = true
      await h.app.onKey("o")
      save("ide-open-unavailable")
    } finally { await h.close(); await h.close() }
  }
}
