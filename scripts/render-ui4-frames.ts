import { writeFileSync } from "node:fs"
import path from "node:path"
import { ui4Harness } from "../apps/cli/test/ui-4-harness"
import { cleanTemps, ids, NOW } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderUi4Frames(directory: string, sizes: string[]) {
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const h = ui4Harness(width, height)
      const save = (name: string) => {
        h.app.render()
        const frame = h.frames.at(-1)!
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
        const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      await Bun.sleep(5)
      save("right-off")
      await h.type("/btw\r")
      await Bun.sleep(5)
      save("sidechat-empty")
      await h.type("/btw question\r")
      await Bun.sleep(5)
      save("sidechat-answer")
      await h.app.onKey("\x1d")
      await h.type("follow up")
      save("sidechat-focus")
      h.app.onGlobal({ type: "aside.changed", sessionId: h.sessionId, gseq: 0, at: NOW, thread: { messages: [{ role: "user", text: "Explain the layout" }, { role: "assistant", text: "The answer streams into the right panel" }], busy: true } })
      save("sidechat-streaming")
      h.app.onGlobal({ type: "aside.changed", sessionId: h.sessionId, gseq: 0, at: NOW, thread: { messages: [{ role: "user", text: "Explain the layout" }], busy: false, error: "Provider unavailable. Try again." } })
      save("sidechat-error")
      await h.app.onKey("\x1b]")
      const widgets = ["context", "usage", "todos", "changes", "jobs", "git", "mcp", "session", "clock", "text"].map((type) => ({ type, options: type === "text" ? { text: "## Review\nRun local checks before delivery." } : {} }))
      // The daemon wrote the shared profile before publishing the notification.
      const { updateSidebar } = await import("../packages/daemon/src/sidebar")
      updateSidebar(h.dataDir, h.directory, { action: "set", widgets })
      h.app.onGlobal({ type: "sidebar.changed", gseq: 1, at: NOW, widgets })
      await Bun.sleep(5)
      const turnId = ids("turn")
      h.chat.emit({ type: "usage.recorded", turnId, provider: "local", model: "local-fake-model", input: 24_000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
      h.app.onGlobal({ type: "quota.snapshot", gseq: 2, at: NOW, provider: "local", windows: [{ id: "weekly", label: "weekly", usedPercent: 23 }], fetchedAt: NOW, source: "frame fixture" })
      await Bun.sleep(5)
      save("sidebar-built")
      await h.type("/sidebar edit\r")
      save("sidebar-editor")
      await h.type("a")
      save("sidebar-editor-add")
      await h.app.onKey("\x1b")
      await h.app.onKey("\x1b")
      await h.app.onKey("\x1b}")
      await h.app.onKey("\x1b[6~")
      save("sidebar-scrolled")
      await h.app.onKey("\x1b")
      await h.type("/sidebar reset\r")
      await h.type("/sidebar edit\r")
      save("sidebar-editor-empty")
      await h.app.onKey("\x1b")
      await h.type("/btw clear\r")
      await Bun.sleep(5)
      save("sidechat-cleared")
      await h.app.onKey("\x03")
    }
  } finally { cleanTemps() }
}
