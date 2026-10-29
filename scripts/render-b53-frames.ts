import { writeFileSync } from "node:fs"
import path from "node:path"
import { planHarness } from "../apps/cli/test/plan-review-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB53Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = await planHarness(width, height)
    const save = (name: string, harness = h) => {
      harness.app.render()
      const rows = harness.frames.at(-1)!
      if (rows.length !== height || rows.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const text = rows.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error(`ANSI: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    save("plan-preview")
    await h.app.onKey("t")
    save("plan-destination")
    await h.app.onKey("e")
    save("plan-edit")
    await h.app.onKey("\x1b")
    await h.app.onKey("c")
    await h.type("Keep retries bounded and preserve queued work.")
    save("plan-comments")
    await h.app.onKey("\x1b")
    await h.app.onKey("r")
    await h.type("Add a duplicate-reply regression before applying.")
    save("plan-reject")
    await h.app.onKey("\x1b")
    await h.app.onKey("\r")
    await h.type("/plan-review\r")
    save("plan-saved")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
    const only = await planHarness(width, height, "plan")
    save("plan-only", only)
    await only.app.onKey("\r")
    await only.type("/plan-review\r")
    save("plan-accepted", only)
    await only.app.onKey("\x1b")
    await only.app.onKey("\x03")
    const failed = await planHarness(width, height, "implementation", true)
    await failed.app.onKey("e")
    await failed.type("\nKeep this edit.")
    await failed.app.onKey("\x0f")
    save("plan-reply-error", failed)
    await failed.app.onKey("\x1b")
  }
}
