import { writeFileSync } from "node:fs"
import path from "node:path"
import { b78Harness, B78_SCREENS } from "../apps/cli/test/b78-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB78Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const screen of B78_SCREENS) {
      const current = b78Harness(width, height, screen)
      try {
        await current.type(screen === "preview" ? "/workflows b78\r" : "/workflows\r")
        current.app.render()
        const frame = current.frames.at(-1)!
        if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${screen} ${size}`)
        const text = frame.map((line) => fit(line, width).map((span) => span.text).join("")).join("\n")
        if (text.includes("\x1b") || screen !== "preview" && !text.includes("┌")) throw new Error(`Invalid frame: ${screen} ${size}`)
        writeFileSync(path.join(directory, `workflow-${screen}-${size}.txt`), text + "\n")
      } finally { await current.app.onKey("\x1b") }
    }
  }
}
