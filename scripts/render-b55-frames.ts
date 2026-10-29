import { writeFileSync } from "node:fs"
import path from "node:path"
import { b55Harness } from "../apps/cli/test/b55-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB55Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const save = (name: string, h: ReturnType<typeof b55Harness>) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error(`ANSI: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    const h = b55Harness(width, height)
    await h.type("/undo\r")
    save("undo", h)
    await h.type("\x18r")
    save("redo", h)
    await h.app.onKey("\x1b")
    await h.type("/changes session\r")
    save("changes-session", h)
    await h.app.onKey("\x1b")
    await h.type("/changes message 2\r")
    save("changes-message", h)
    await h.type("\x03")
    const repeated = b55Harness(width, height)
    await repeated.type("\x18u\x18u\x18r")
    save("redo-remaining", repeated)
    await repeated.type("\x03")
    const conflict = b55Harness(width, height, { conflict: true })
    await conflict.type("/undo\r")
    save("undo-conflict", conflict)
    await conflict.app.onKey("\x1b")
    await conflict.type("/redo\r")
    save("redo-conflict", conflict)
    await conflict.type("\x03")
    const external = b55Harness(width, height, { external: true, partial: true })
    await external.type("/undo\r")
    save("undo-external-history", external)
    await external.app.onKey("\x1b")
    await external.app.onKey("\x03")
    await external.type("/changes session\r")
    save("changes-partial", external)
    await external.type("\x03")
  }
}
