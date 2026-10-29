import { writeFileSync } from "node:fs"
import path from "node:path"
import { b30Harness, b30Report } from "../apps/cli/test/b30-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB30Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const harness = b30Harness(width, height)
    const save = (name: string, frameHarness = harness) => {
      frameHarness.app.render()
      const frame = frameHarness.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} at ${size}`)
      const text = frame.map((line) => fit(line, width).map((span) => span.text).join("")).join("\n") + "\n"
      if (text.includes("\x1b")) throw new Error(`ANSI: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text)
    }
    try {
      await harness.type("/worktr")
      save("commands-worktrees")
      await harness.type("\t\r")
      save("manager-status")
      await harness.type("d")
      save("manager-doctor")
      await harness.type("c")
      await harness.type("client\tmend/client-v2\tmain\t/tmp/b30-data/client-v2\tclaude")
      save("manager-create-form")
      await harness.type("\r")
      save("manager-create-preview")
      await harness.keys("\x1b", "\x1b[B", "\r")
      save("manager-open-preview")
      await harness.keys("\x1b", "x")
      save("manager-remove-external")
      await harness.keys("\x1b", "a")
      save("manager-adopted")
      await harness.type("x")
      save("manager-remove-preview")
      await harness.keys("\x1b", "z")
      save("manager-reset-preview")
      await harness.keys("\x1b", "\x1b[B", "z")
      save("manager-reset-dirty")
      await harness.keys("\x1b", "\x1b")
      await harness.type("/war")
      save("commands-warp")
      await harness.type("\t\r")
      save("workspace-picker")
      await harness.type("\r")
      save("workspace-create")
      await harness.keys("\x1b", "\x1b[B", "\r")
      save("workspace-local")
      await harness.type("\x1b[B\x1b[B\r")
      save("workspace-switch-unavailable")
      await harness.keys("\x1b", "\x1b")
      const unavailable = b30Report()
      unavailable.ok = false
      unavailable.records = []
      unavailable.workspace.repoRoot = null
      unavailable.failures = ["Project is not an available Git checkout"]
      harness.setReport(unavailable)
      await harness.type("/warp\r")
      save("workspace-unavailable")
      harness.error("Registry unavailable")
      await harness.type("r")
      save("workspace-error")
    } finally { await harness.app.onKey("\x03") }
    const readOnly = b30Harness(width, height, true)
    try {
      await readOnly.type("/worktrees\r\x1b[Ba")
      save("manager-read-only", readOnly)
    } finally { await readOnly.app.onKey("\x03") }
  }
}
