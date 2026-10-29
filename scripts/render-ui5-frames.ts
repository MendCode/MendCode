import { writeFileSync } from "node:fs"
import path from "node:path"
import { UI5_PAGES, ui5Harness } from "../apps/cli/test/ui-5-harness"
import { ui4Harness } from "../apps/cli/test/ui-4-harness"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderUi5Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["60x20", "100x30", "160x45", "220x60", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = ui5Harness(width, height)
    const save = (name: string, source: Pick<typeof h, "app" | "frames"> = h) => {
      source.app.render()
      const frame = source.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.type("/usage\r")
    save("usage-overview")
    await h.app.onKey("\x1b[H")
    save("usage-first-day")
    await h.app.onKey("\x1b[F")
    for (let tab = 2; tab <= 6; tab++) {
      await h.app.onKey(String(tab))
      save(`usage-${["limits", "tokens", "models", "tools", "sessions"][tab - 2]}`)
    }
    await h.app.onKey("1")
    await h.app.onKey("\x1b[6~")
    save("usage-overview-scrolled")
    await h.app.onKey("\x1b")
    for (const page of UI5_PAGES) {
      await h.type(`/${page}\r`)
      save(page)
      await h.app.onKey("\x1b")
    }
    await h.type("/customize\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("usageClock"); i++) await h.app.onKey("\x1b[B")
    save("customize-usage-clock")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
    await h.app.onKey("\x03")
    const widgets = ui4Harness(width, height, [{ type: "context", options: {} }, { type: "usage", options: {} }, { type: "clock", options: {} }, { type: "text", options: { text: "Local checks" } }])
    if (width < 110) await widgets.app.onKey("\x1b]")
    save("sidebar-widgets", widgets)
    await widgets.app.onKey("\x1b}")
    await widgets.app.onKey("\x1b[6~")
    save("sidebar-widgets-scrolled", widgets)
    await widgets.app.onKey("\x03")
    await widgets.app.onKey("\x03")
  }
}
