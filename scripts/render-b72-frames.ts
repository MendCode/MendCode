import { writeFileSync } from "node:fs"
import path from "node:path"
import { b72Harness, b72Report } from "../apps/cli/test/b72-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB72Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2]), h = b72Harness(width, height)
    const save = (name: string, harness = h) => {
      harness.app.render()
      const frame = harness.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} at ${size}`)
      const text = frame.map((line) => fit(line, width).map((span) => span.text).join("")).join("\n") + "\n"
      if (text.includes("\x1b")) throw new Error(`ANSI: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text)
    }
    try {
      await h.type("/ts")
      save("commands-tsm")
      await h.type("\t\r")
      save("status-inactive")
      await h.keys("\x1b[B", "\r")
      save("workspace")
      await h.reopen()
      await h.keys("\x1b[B", "\x1b[B", "\r")
      save("adapter-details")
      await h.reopen("/tsm setup")
      save("setup-plan")
      await h.reopen("/tsm activate --mux kitty")
      save("status-active")
      await h.reopen("/tsm open main")
      save("open-preview")
      await h.reopen("/tsm create client --branch mend/client")
      save("create-preview")
      await h.reopen("/tsm doctor")
      save("doctor")
      await h.reopen("/tsm deactivate")
      save("status-deactivated")
      await h.reopen("/tsm remove")
      save("remove-confirm")
      await h.keys("y")
      save("scaffold-recycled")
      h.setReport(b72Report("not-installed"))
      await h.reopen()
      save("status-missing")
      await h.reopen("/tsm activate")
      save("activation-blocked")
      h.setReport(b72Report("degraded"))
      await h.reopen("/tsm doctor")
      save("doctor-degraded")
      const sync = b72Report("active")
      sync.policy.liveSync = true
      h.setReport(sync)
      await h.reopen("/tsm doctor")
      save("doctor-sync-blocked")
      h.error("TSM registry unavailable")
      await h.keys("r")
      save("adapter-error")
    } finally { await h.app.onKey("\x03") }
    const readOnly = b72Harness(width, height, true)
    try { await readOnly.type("/tsm\r"); save("adapter-read-only", readOnly) }
    finally { await readOnly.app.onKey("\x03") }
  }
}
