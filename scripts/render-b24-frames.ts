import { writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, ids, tempDir } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import { b24Report } from "./b24-fixture"

export async function renderB24Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const state of ["off", "running", "accepted", "blocked", "unreviewed-revision"] as const) {
      const sessionId = ids("session")
      const report = b24Report(state, sessionId)
      const h = appHarness({ width, height, sessionId, dataDir: tempDir(), directory: "/work/mendcode", reply: (command) => ({ ok: true, ...(command.type === "compound.get" ? { result: { report } } : {}) }) })
      h.app.applySettings({ onboarded: true })
      await h.type("/compound\r")
      await h.app.onKey("\x1b[B")
      await h.app.onKey("\x1b[B")
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`overflow: compound-${state} ${size}`)
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error("ANSI in B24 frame")
      writeFileSync(path.join(directory, `compound-${state}-${size}.txt`), `${rows.join("\n")}\n`)
      await h.app.onKey("\x1b")
      await h.app.onKey("\x03")
    }
  }
}
