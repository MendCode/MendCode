import { writeFileSync } from "node:fs"
import path from "node:path"
import { USAGE_WIDGET_IDS } from "@mendcode/protocol/wire"
import { b77Harness } from "../apps/cli/test/b77-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB77Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const save = (h: ReturnType<typeof b77Harness>, name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => /[\x00-\x1f\x7f]/.test(row))) throw new Error(`control in frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const h = b77Harness({ width, height })
    await h.type("/usage\r")
    save(h, "usage-core")
    await h.app.onKey("c")
    save(h, "usage-widget-picker")
    for (let i = 0; i < 5; i++) await h.app.onKey("\x1b[B")
    save(h, "usage-weather-selected")
    await h.app.onKey("\x1b")
    await h.app.onKey("w")
    await h.type("Example City")
    save(h, "usage-weather-region")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
    for (const status of ["ready", "off", "unavailable", "error", "loading", "empty"] as const) {
      let release: ((report: { status: "error" }) => void) | undefined
      const scene = b77Harness({ width, height, profile: { usageWidgets: status === "ready" || status === "empty" ? [...USAGE_WIDGET_IDS] : ["weather"], usageWeatherEnabled: status !== "off", usageWeatherRegion: "Example City" }, empty: status === "empty",
        ...(status === "unavailable" || status === "error" ? { weather: (region: string) => ({ status, region }) } : status === "loading" ? { weather: () => new Promise<{ status: "error" }>((resolve) => { release = resolve }) } : {}) })
      const opening = scene.type("/usage\r")
      if (status === "loading") {
        await Bun.sleep(10)
        if (width < 110) for (let i = 0; i < 20; i++) await scene.app.onKey("\x1b[6~")
        save(scene, "usage-weather-loading")
        release?.({ status: "error" })
      }
      await opening
      if (status !== "ready" && status !== "empty" && width < 110) for (let i = 0; i < 20; i++) await scene.app.onKey("\x1b[6~")
      if (status !== "loading") save(scene, status === "ready" ? "usage-all-widgets" : `usage-weather-${status}`)
      if (status === "ready") {
        for (let i = 1; i <= (width < 110 ? 7 : 2); i++) { await scene.app.onKey("\x1b[6~"); save(scene, `usage-widgets-scroll-${i}`) }
        for (const scope of ["project", "directory"]) { await scene.app.onKey("s"); save(scene, `usage-widgets-${scope}`) }
      }
      await scene.app.onKey("\x1b")
      await scene.app.onKey("\x03")
    }
  }
}
