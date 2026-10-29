import { writeFileSync } from "node:fs"
import path from "node:path"
import { memoryControlHarness } from "../apps/cli/test/memory-control-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB19Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid frame size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = memoryControlHarness(width, height)
    const key = async (input: string) => { await h.app.onKey(input); await h.type("") }
    const save = (name: string, required: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b") || !text.includes(required)) throw new Error(`Invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text + "\n")
    }
    await h.type("/memory\r")
    save("memory-import-pending", "Use pnpm")
    await key("e")
    save("memory-edit", "Use pnpm")
    await key("\x1b")
    await key("a")
    await key("2")
    save("memory-applied", "Use pnpm")
    await key("x")
    await key("3")
    save("memory-archived", "Use pnpm")
    await key("4")
    save("dream-status", "consolidation preview")
    await key("v")
    save("dream-report", "0 applied")
    await key("\x1b")
    await key("\x1b")
  }
}
