import { writeFileSync } from "node:fs"
import path from "node:path"
import { b41Harness } from "../apps/cli/test/b41-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB41Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b41Harness(width, height)
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((s) => s.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((s) => s.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.type("/usage\r")
    const tabs = ["overview", "limits", "tokens", "models", "tools", "sessions"]
    for (const scope of ["global", "project", "directory"]) {
      for (let tab = 1; tab <= 6; tab++) {
        await h.app.onKey(String(tab))
        save(`usage-${scope}-${tabs[tab - 1]}`)
      }
      await h.app.onKey("1")
      await h.app.onKey("g")
      save(`usage-${scope}-weekly`)
      await h.app.onKey("g")
      save(`usage-${scope}-cumulative`)
      await h.app.onKey("g")
      await h.app.onKey("\x1b[6~")
      save(`usage-${scope}-scrolled`)
      await h.app.onKey("s")
    }
    await h.app.onKey("\x1b")
    await h.type("/stats-project\r")
    save("stats-project")
    await h.app.onKey("p")
    save("usage-selected-project")
    await h.app.onKey("p")
    save("usage-empty-project")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
  }
}
