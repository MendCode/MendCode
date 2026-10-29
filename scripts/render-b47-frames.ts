import { writeFileSync } from "node:fs"
import path from "node:path"
import { b47Harness } from "../apps/cli/test/b47-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB47Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const save = (h: ReturnType<typeof b47Harness>, name: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (frame.length !== height || rows.some((line) => textWidth(line) > width || /[\x00-\x1f]/.test(line))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const h = b47Harness(width, height)
    await h.app.extensionsReady
    await h.type("/mcps")
    await h.key("\r")
    save(h, "mcp-servers")
    await h.key("x")
    save(h, "mcp-resources")
    await h.key("r")
    save(h, "mcp-resource-content")
    await h.key("\t")
    save(h, "mcp-prompts")
    await h.key("\t")
    save(h, "mcp-resource-templates")
    await h.key("\x1b")
    await h.key("\x1b")
    await h.type("Use @docs:")
    await h.key("")
    save(h, "mcp-mention-picker")
    h.app.editor.clear()
    await h.type("/docs:")
    await h.key("")
    save(h, "mcp-prompt-picker")
    h.app.editor.replaceAll("/docs:review_code")
    await h.key("\r")
    save(h, "mcp-prompt-missing-argument")
    for (const variant of ["empty", "failed", "partial"] as const) {
      const other = b47Harness(width, height, { [variant]: true })
      await other.open()
      save(other, `mcp-catalog-${variant}`)
      await other.key("\x03")
      await other.key("\x03")
    }
    await h.key("\x03")
    await h.key("\x03")
  }
}
