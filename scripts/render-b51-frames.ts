import { writeFileSync } from "node:fs"
import path from "node:path"
import { b51Harness } from "../apps/cli/test/b51-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB51Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const save = (h: ReturnType<typeof b51Harness>, name: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (frame.length !== height || rows.some((line) => textWidth(line) > width || /[\x00-\x1f]/.test(line))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    for (const mode of ["after-response", "after-tools", "immediate"] as const) {
      const h = b51Harness(width, height, mode)
      await h.app.extensionsReady
      save(h, `queue-${mode}`)
    }
    const held = b51Harness(width, height, "after-tools", true)
    await held.app.extensionsReady
    save(held, "queue-held")
    held.chat.emit({ type: "queue.changed", queue: [] })
    held.chat.emit({ type: "foreground.state", state: "idle" })
    await held.type("/settings\r")
    for (let row = 0; row < 18; row++) await held.app.onKey("\x1b[B")
    save(held, "queue-settings")
  }
}
