import { writeFileSync } from "node:fs"
import path from "node:path"
import { b42Harness } from "../apps/cli/test/b42-harness"
import { conversation } from "../apps/cli/test/session-ui-harness"
import { MODEL_PAGE_ROWS } from "../apps/cli/src/view/model-page"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB42Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = await b42Harness(width, height)
    const save = (name: string) => {
      h.app.render()
      const rows = h.frames.at(-1)!
      if (rows.length !== height || rows.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const text = rows.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error(`ANSI: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    await h.type("/agent\r")
    save("agent")
    await h.type("\x1b")
    await h.type("/model\r")
    save("model")
    for (let i = 0; i < MODEL_PAGE_ROWS.indexOf("summary"); i++) await h.app.onKey("\x1b[B")
    save("model-summary")
    await h.type("\x1b")
    conversation(h.sessionId, h.app.onEvent).exchange("Review the configuration", "The selected agent's sampling, variant and output limits now apply to model calls.")
    save("chat-agent-color")
    await h.app.onKey("\x03")
    await h.app.onKey("\x03")
  }
}
