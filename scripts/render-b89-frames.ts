import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ptyChatHarness } from "../apps/cli/test/b89-harness"
import { cleanTemps } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB89Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid frame size: ${size}`)
      const width = Number(match[1]), height = Number(match[2]), h = await ptyChatHarness(width, height)
      try {
        const save = (name: string) => {
          h.app.render()
          const rows = h.frames.at(-1)!
          if (rows.length !== height || rows.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow ${name} ${size}`)
          const lines = rows.map((row) => fit(row, width).map((span) => span.text).join(""))
          if (lines.some((row) => row.includes("\x1b"))) throw new Error("ANSI in frame")
          writeFileSync(path.join(directory, `${name}-${size}.txt`), `${lines.join("\n")}\n`)
        }
        save("pty-chat")
        h.resize()
        save("pty-resized-chat")
      } finally { h.close(); await h.app.onKey("\x03") }
    }
  } finally { cleanTemps() }
}
