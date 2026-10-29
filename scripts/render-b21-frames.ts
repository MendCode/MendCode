import { writeFileSync } from "node:fs"
import path from "node:path"
import { b21Harness } from "../apps/cli/test/b21-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB21Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const save = (name: string, h: ReturnType<typeof b21Harness>) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const text = frame.map((line) => fit(line, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b") || !text.includes("┌")) throw new Error(`Invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text + "\n")
    }
    const live = b21Harness(width, height)
    await live.type("/workflows\r")
    save("workflows-revision", live)
    await live.app.onKey("x")
    save("workflows-stop-confirm", live)
    await live.app.onKey("\x1b")
    await live.app.onKey("\x1b")
    const failed = b21Harness(width, height, "failed")
    await failed.type("/workflows\r")
    save("workflows-failed", failed)
    await failed.app.onKey("\x1b")
    const empty = b21Harness(width, height, "running", true)
    await empty.type("/workflows\r")
    save("workflows-empty", empty)
    await empty.app.onKey("\x1b")
  }
}
