import { writeFileSync } from "node:fs"
import path from "node:path"
import { b86Harness } from "../apps/cli/test/b86-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB86Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2]), h = await b86Harness(width, height)
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error("ANSI in frame")
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    try {
      await h.type("/workflows\r")
      save("rest-workflow-running")
      await h.request(`/workflow/${h.workflowId}/pause`, { reason: "Review first" })
      save("rest-workflow-paused")
      await h.request(`/workflow/${h.workflowId}/permission-mode`, { mode: "report-only", sessionMode: "approval" })
      await h.type("b")
      save("rest-workflow-events")
      await h.type("2")
      save("rest-workflow-artifacts")
      await h.type("\x1b")
      await h.request(`/workflow/${h.workflowId}/stop`, {})
      save("rest-workflow-stopped")
    } finally { await h.close() }
  }
}
