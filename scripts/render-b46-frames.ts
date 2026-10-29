import { writeFileSync } from "node:fs"
import path from "node:path"
import { evolutionHarness } from "../apps/cli/test/evolution-promotion-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB46Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error("Invalid size " + size)
    const width = Number(match[1]), height = Number(match[2])
    const h = evolutionHarness(width, height)
    const key = async (value: string) => { await h.app.onKey(value); await h.type("") }
    const save = (name: string, required: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error("Overflow " + name + " " + size)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b") || !text.includes(required)) throw new Error("Invalid frame " + name + " " + size)
      writeFileSync(path.join(directory, name + "-" + size + ".txt"), text + "\n")
    }
    await h.type("/memory\r")
    await key("7")
    save("evolution-workflow-review", "survey-checks")
    await key("\x1b[B")
    save("evolution-skill-review", "read-checks")
    await key("\x1b[A")
    for (let i = 0; i < 12; i++) await key("\x1b[6~")
    save("evolution-workflow-content", "independent")
    for (let i = 0; i < 12; i++) await key("\x1b[5~")
    await key("a")
    save("evolution-promoted", "Receipt · revision 1")
    await key("\x1b[D")
    await key("\x1b[D")
    save("evolution-off-receipt", "‹ off ›")
    h.failNext()
    await key("r")
    save("evolution-rollback-refused", "manual review")
    await key("r")
    save("evolution-rolled-back", "revision 2")
    await key("\x1b[B")
    await key("x")
    save("evolution-rejected", "rejected")
    h.empty()
    await key("\x1b")
    await h.type("/memory\r")
    await key("7")
    save("evolution-empty-off", "No candidates")
    await key("4")
    await key("v")
    if (height < 30) await key("\x1b[6~")
    save("dream-workflow-report", "1 workflow")
    await key("\x1b")
    await key("\x1b")
  }
}
