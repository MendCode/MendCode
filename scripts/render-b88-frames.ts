import { writeFileSync } from "node:fs"
import path from "node:path"
import { b88Harness } from "../apps/cli/test/b88-harness"
import { b63Harness } from "../apps/cli/test/b63-fixtures"
import type { Harness } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB88Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const save = (name: string, h: Pick<Harness, "app" | "frames">) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    for (const kind of ["permission", "question", "plan-review"] as const) {
      const h = await b88Harness(kind, width, height)
      save(`${kind}-pending`, h)
      await h.reply(kind === "permission" ? { reply: "once" } : kind === "question" ? { answers: [["Retry"], ["Socket", "Queue"]] } : { action: "edit", markdown: "# Reviewed recovery\n\nKeep retries bounded.\nPreserve queued work and add a duplicate-reply regression.", comments: "Keep the socket test local" })
      if (kind === "plan-review") await h.type("/plan-review\r")
      save(`${kind}-resolved`, h)
      await h.app.onKey("\x1b")
      await h.app.onKey("\x03")
    }
    const memory = b63Harness(width, height)
    await memory.type("/memory\r")
    await memory.type("2")
    await memory.type("t")
    save("memory-assistant-existing", memory)
    await memory.app.onKey("\x1b")
    await memory.app.onKey("\x1b")
    await memory.app.onKey("\x03")
  }
}
