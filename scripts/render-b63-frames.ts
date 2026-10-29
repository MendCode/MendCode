import { writeFileSync } from "node:fs"
import path from "node:path"
import { b63Harness } from "../apps/cli/test/b63-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB63Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid frame size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = b63Harness(width, height)
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow ${name} at ${size}`)
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI in ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.type("/memory\r")
    for (const [tab, name] of [["1", "pending"], ["2", "saved"], ["3", "archived"], ["4", "dream"], ["5", "graph"], ["6", "policies"], ["7", "evolution"], ["8", "extraction"], ["9", "sharing"]]) {
      await h.type(tab!)
      save(`memory-${name}`)
    }
    await h.type("2")
    await h.type("t")
    save("assistant-empty")
    await h.app.onKey("\x1b")
    h.thread({ messages: [{ role: "user", text: "Explain this validation rule" }], busy: true, proposals: [] })
    await h.type("t")
    save("assistant-answering")
    await h.app.onKey("\x0c")
    await h.type("")
    await h.type("Explain this validation rule")
    save("assistant-question")
    await h.type("\r")
    save("assistant-answer")
    await h.app.onKey("\x12")
    await h.type("")
    save("assistant-pending")
    await h.type("t")
    save("assistant-reopened")
    await h.app.onKey("\x18")
    await h.type("")
    save("assistant-canceled")
    await h.app.onKey("\x0c")
    await h.type("")
    save("assistant-cleared")
    h.error("Memory assistant needs a configured native completion provider")
    await h.type("Explain this rule\r")
    save("assistant-unavailable")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    await h.type("/model\r")
    for (let row = 0; row < 10; row++) await h.app.onKey("\x1b[B")
    await h.type("")
    save("model-role-memory-assistant")
  }
}
