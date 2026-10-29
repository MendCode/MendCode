import { writeFileSync } from "node:fs"
import path from "node:path"
import { automationLedgerHarness } from "../apps/cli/test/automation-ledger-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB69Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = automationLedgerHarness(width, height)
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error(`ANSI ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    try {
      for (const scope of ["workflow", "loop"] as const) {
        await h.type(scope === "workflow" ? "/workflows\r" : "/loops\r")
        save(`${scope}-list`)
        await h.type("b")
        save(`${scope}-events`)
        await h.type("2")
        save(`${scope}-artifacts`)
        await h.type("3")
        save(`${scope}-receipt`)
        await h.type("e")
        save(`${scope}-export-json`)
        await h.type("\x1b")
        await h.type("m")
        save(`${scope}-export-markdown`)
        for (let i = 0; i < 3; i++) await h.app.onKey("\x1b")
      }
    } finally { await h.close() }
  }
}
