import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { TraceSample } from "@mendcode/protocol"
import { appHarness, conversation, tempDir } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB52Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const samples: TraceSample[] = []
    const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project", trace: (sample) => { samples.push(sample) } })
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
    }
    try {
      h.app.applySettings({ onboarded: true })
      await Bun.sleep(5)
      save("home-trace")
      conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Inspect the local trace", "Diagnostics contain IDs, timings and token counts.")
      save("chat-trace")
      if (!samples.length || samples.some((sample) => sample.metadata.cols !== width || sample.metadata.rows !== height)) throw new Error(`trace observer missing: ${size}`)
    } finally { await h.app.onKey("\x03") }
  }
}
