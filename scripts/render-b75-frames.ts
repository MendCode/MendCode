import { writeFileSync } from "node:fs"
import path from "node:path"
import { packageAuthoringHarness } from "../apps/cli/test/package-authoring-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB75Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid frame size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = packageAuthoringHarness(width, height)
    const save = (name: string) => {
      h.app.render()
      const rows = (h.frames.at(-1) ?? []).map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.length !== height || rows.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
    }
    h.author("create")
    await h.type("/marketplace\r")
    save("authored-catalog")
    await h.app.onKey("\r")
    save("authored-preview")
    await h.app.onKey("\x1b")
    h.author("update", "0.0.1")
    await h.app.onKey("r")
    await Bun.sleep(5)
    save("updated-catalog")
    await h.app.onKey("\r")
    save("updated-preview")
    await h.app.onKey("\x1b")
    h.deleteLocal()
    await h.app.onKey("r")
    await Bun.sleep(5)
    save("deleted-catalog")
    await h.app.onKey("\x03")
  }
}
