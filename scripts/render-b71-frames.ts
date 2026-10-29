import { writeFileSync } from "node:fs"
import path from "node:path"
import { b71Harness } from "../apps/cli/test/b71-harness"
import { cleanTemps } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB71Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const state of ["selected", "denied", "invalid", "syntax"] as const) {
      const h = await b71Harness(width, height, state)
      const save = (name: string) => {
        h.app.render()
        const frame = h.frames.at(-1)!
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
        const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI ${name}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      save(`code-${state}`)
      await h.type("\x0f")
      save(`code-${state}-expanded`)
      await h.type("\x03")
      cleanTemps()
    }
  }
}
