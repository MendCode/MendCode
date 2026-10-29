import { writeFileSync } from "node:fs"
import path from "node:path"
import { b14Cases, b14Scene } from "../apps/cli/test/stack-formatters-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB14Frames(directory: string, sizes: string[]) {
  const cases = await b14Cases()
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const scene of cases) {
      const harness = b14Scene(scene, width, height)
      const save = (screen: string) => {
        harness.app.render()
        const frame = harness.frames.at(-1)!
        if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${screen} ${size}`)
        const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
        if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${screen}`)
        writeFileSync(path.join(directory, `${screen}-${size}.txt`), rows.join("\n") + "\n")
      }
      save(`chat-${scene.name}`)
      await harness.type("\x0f")
      save(`chat-expanded-${scene.name}`)
      await harness.type("/history\r")
      await harness.type("t")
      await harness.type("\r")
      save(`history-${scene.name}`)
      await harness.app.onKey("\x03")
      await harness.app.onKey("\x03")
    }
  }
}
