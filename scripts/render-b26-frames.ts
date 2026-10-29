import { writeFileSync } from "node:fs"
import path from "node:path"
import { b26Harness } from "../apps/cli/test/b26-harness"
import { cleanTemps } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB26Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const state of ["found", "empty", "invalid"] as const) {
      const h = await b26Harness(width, height, state)
      const save = (name: string) => {
        h.app.render()
        const frame = h.frames.at(-1)!
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
        const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI ${name}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      save(`discovery-${state}`)
      await h.type("\x0f")
      save(`discovery-${state}-expanded`)
      await h.type("\x03")
      cleanTemps()
    }
  }
}
