import { writeFileSync } from "node:fs"
import path from "node:path"
import { catalogHarness } from "../apps/cli/test/package-catalog-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { fit } from "../apps/cli/src/view/deck"

export async function renderB37Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const [width, height] = size.split("x").map(Number)
    if (!width || !height) throw new Error(`invalid frame size: ${size}`)
    const h = catalogHarness(width, height)
    const save = (name: string, harness = h) => {
      harness.app.render()
      const rows = (harness.frames.at(-1) ?? []).map((line) => fit(line, width).map((span) => span.text).join(""))
      if (rows.length !== height || rows.some((line) => textWidth(line) !== width || /\x1b\[/.test(line))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
    }
    await h.type("/packages\r")
    save("packages")
    await h.app.onKey("d")
    save("packages-remove")
    await h.app.onKey("\x1b")
    await h.app.onKey("x")
    save("packages-deselect-all")
    await h.app.onKey("\x1b")
    await h.app.onKey("m")
    save("marketplace")
    await h.app.onKey("/")
    await h.type("terminal")
    save("marketplace-search")
    await h.app.onKey("\r")
    await h.app.onKey("\r")
    save("marketplace-preview")
    await h.app.onKey("i")
    save("marketplace-install-confirm")
    await h.app.onKey("\x1b")
    await h.app.onKey("s")
    save("marketplace-sources")
    await h.app.onKey("\r")
    save("marketplace-source-detail")
    await h.app.onKey("\r")
    await h.app.onKey("a")
    await h.type("extra")
    save("marketplace-source-id")
    await h.app.onKey("\r")
    await h.type("/catalog/extra")
    save("marketplace-source-folder")
    await h.app.onKey("\r")
    await h.app.onKey("j")
    await h.app.onKey("j")
    await h.app.onKey("d")
    save("marketplace-remove-source")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    await h.type("/mend-assets\r")
    save("mend-assets")
    const failed = catalogHarness(width, height, true)
    await failed.type("/marketplace\r")
    save("marketplace-error", failed)
    await failed.app.onKey("\x03")
    await h.app.onKey("\x03")
  }
}
