import { writeFileSync } from "node:fs"
import path from "node:path"
import { b40Harness, B40_REPORT } from "../apps/cli/test/b40-harness"
import { NOW } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB40Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b40Harness(width, height)
    const save = (name: string, scene = h) => {
      scene.app.render()
      const rows = scene.text()
      if (rows.length !== height || rows.some((row) => row.includes("\x1b") || textWidth(row) > width)) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), scene.frames.at(-1)!.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n") + "\n")
    }
    await h.type("/release-channel\r")
    save("release-inspect")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\r")
    save("release-channel-saved")
    await h.app.onKey("c")
    save("release-update-available")
    await h.app.onKey("a")
    save("release-notify")
    h.setReport({ ...B40_REPORT, latest: "v0.0.2", status: "installed", recovery: { current: "v0.0.2", previous: "v0.0.1" } })
    await h.app.onKey("r")
    save("release-recovery")
    h.error("Release provenance verification failed; install blocked")
    await h.app.onKey("c")
    save("release-error")
    await h.app.onKey("\x1b")
    h.app.onGlobal({ type: "release.available", version: "v0.0.2", channel: "stable", installed: false, gseq: 1, at: NOW })
    save("update-notification")
    const remote = b40Harness(width, height, true)
    await remote.type("/release-channel\r")
    save("release-read-only", remote)
    await remote.app.onKey("\x03")
    await h.app.onKey("\x03")
  }
}
