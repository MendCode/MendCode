import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { b74Harness } from "../apps/cli/test/b74-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB74Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error("Invalid B74 frame size")
    const width = Number(match[1]), height = Number(match[2])
    const save = (name: string, h: ReturnType<typeof b74Harness>) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`B74 frame overflow: ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error("ANSI in B74 text frame")
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text + "\n")
    }
    const disabled = b74Harness({ width, height, enabled: false })
    try {
      await disabled.type("/console\r"); save("console-disabled", disabled)
      await disabled.keys("s"); save("console-setup", disabled)
    } finally { await disabled.app.onKey("\x03") }
    const h = b74Harness({ width, height })
    try {
      await h.type("/console\r"); save("console-organizations", h)
      await h.keys("\x1b[B", "\r"); save("console-switched", h)
      await h.keys("l"); save("console-login", h)
      await h.keys("p"); save("console-login-success", h)
      await h.keys("d"); save("console-logout-confirm", h)
      await h.keys("y"); save("console-logged-out", h)
      if (h.text().join("\n").includes("Logged in as") || h.text().join("\n").includes("42 / 100")) throw new Error("Stale account state in logout frame")
      h.failNext(); await h.keys("r"); save("console-error", h)
      await h.keys("\x1b"); await h.type("/share\r"); save("share-disabled", h)
      await h.keys("\r"); save("share-disabled-error", h)
      await h.keys("m", "\r"); save("share-created", h)
      h.failNext(); await h.keys("s"); save("share-error", h)
      await h.keys("r", "u"); save("share-unshare-confirm", h)
      await h.keys("y"); save("share-removed", h)
    } finally { await h.app.onKey("\x03") }
    const remote = b74Harness({ width, height, remote: { host: "127.0.0.1", readOnly: true } })
    try { await remote.type("/org\r"); save("console-remote-blocked", remote); await remote.keys("\x1b"); await remote.type("/share\r"); save("share-remote-metadata", remote) }
    finally { await remote.app.onKey("\x03") }
  }
}
