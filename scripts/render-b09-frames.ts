import { writeFileSync } from "node:fs"
import path from "node:path"
import { lspCases, lspScene } from "../apps/cli/test/lsp-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB09Frames(directory: string, sizes: string[]) {
  const cases = await lspCases()
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const scene of cases) {
      const h = lspScene(scene, width, height)
      const save = (screen: string) => {
        h.app.render()
        const frame = h.frames.at(-1)!
        if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${screen} ${size}`)
        const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
        if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${screen}`)
        writeFileSync(path.join(directory, `${screen}-${size}.txt`), rows.join("\n") + "\n")
      }
      save(`chat-lsp-${scene.name}`)
      await h.type("/history\r")
      await h.type("t")
      await h.type("\r")
      save(`history-lsp-${scene.name}`)
      await h.app.onKey("\x03")
      await h.app.onKey("\x03")
    }
  }
}
