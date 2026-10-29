import { writeFileSync } from "node:fs"
import path from "node:path"
import { b45Harness } from "../apps/cli/test/b45-harness"
import { MODEL_PAGE_ROWS } from "../apps/cli/src/view/model-page"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB45Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const save = (h: ReturnType<typeof b45Harness>, name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const text = frame.map((line) => fit(line, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b") || !text.includes("┌")) throw new Error(`Invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text + "\n")
    }
    const live = b45Harness(width, height)
    await live.type("/workflows\r")
    save(live, "workflows-routing")
    await live.app.onKey("\x1b")
    const failed = b45Harness(width, height, true)
    await failed.type("/workflows\r")
    save(failed, "workflows-budget-failed")
    await failed.app.onKey("\x1b")
    const models = b45Harness(width, height)
    await models.type("/model\r")
    for (let n = 1; n < MODEL_PAGE_ROWS.length; n++) await models.app.onKey("\x1b[B")
    save(models, "model-workflow-role")
    await models.app.onKey("\x1b")
  }
}
