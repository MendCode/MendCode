import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { b05Harness } from "../apps/cli/test/b05-harness"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { SETUP_ROWS } from "../apps/cli/src/view/setup-page"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB05Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b05Harness(width, height)
    const save = (name: string, page: string) => {
      if (h.app.page !== page) throw new Error(`${name}: expected ${page}, got ${h.app.page}`)
      h.app.render()
      const rows = h.text()
      if (rows.length !== height || rows.some((row) => textWidth(row) > width || /[\x00\x1b]/.test(row))) throw new Error(`Invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    for (const mode of ["minimal", "focus", "full"] as const) {
      h.modes.set(h.directory, { mode })
      await h.type("/prompt-mode\r")
      save(`prompt-mode-${mode}`, "prompt-mode")
      await h.app.onKey("\x1b")
    }
    await h.type("/prompt-mode\r")
    await h.app.onKey("2")
    for (let i = 0; i < 5; i++) await h.app.onKey("\x1b[B")
    save("prompt-mode-family", "prompt-mode")
    await h.app.onKey("\x1b")
    h.modes.set(h.directory, { mode: "custom" })
    await h.type("/prompt-mode\r")
    save("prompt-mode-unavailable", "prompt-mode")
    await h.app.onKey("\x1b")
    const file = path.join(h.directory, ".mendcode", "prompts", "custom.md")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "---\nname: API work\n---\nRead the request. Apply focused patches and verify the API contract.")
    await h.type("/prompt-mode\r")
    save("prompt-mode-custom", "prompt-mode")
    await h.app.onKey("\x1b")
    await h.type("/setup\r")
    for (let i = 0; i < SETUP_ROWS.indexOf("promptContext"); i++) await h.app.onKey("\x1b[B")
    save("setup-prompt-context", "setup")
    await h.app.onKey("\x1b")
    await h.type("/customize\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("promptContext"); i++) await h.app.onKey("\x1b[B")
    save("customize-prompt-context", "customize")
    await h.app.onKey("\x1b")
    await h.type("/prompt-mode\r")
    h.refuse("Mode was not saved")
    await h.app.onKey("\r")
    save("prompt-mode-error", "prompt-mode")
    await h.app.onKey("\x1b")
    await h.type("/prompt-mo\t")
    save("prompt-completion", "chat")
    h.app.editor.clear()
    await h.app.onKey("\x03")
    await h.app.onKey("\x03")
  }
}
