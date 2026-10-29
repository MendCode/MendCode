import { writeFileSync } from "node:fs"
import path from "node:path"
import { b70Harness } from "../apps/cli/test/b70-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB70Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`Invalid size: ${size}`)
    const h = b70Harness(Number(match[1]), Number(match[2]))
    const save = (name: string) => {
      h.app.render()
      const rows = h.text()
      if (h.app.page !== "ai-config" || rows.length !== Number(match[2]) || rows.some((row) => textWidth(row) > Number(match[1]) || /[\x00\x1b]/.test(row))) throw new Error(`Invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.type("/ai-config\r")
    save("inspect")
    await h.app.onKey("\x1b")
    await h.type('/ai-config plan {"intent":"economical","taskKind":"repair","candidates":[{"role":"main"},{"role":"small"}]}\r')
    save("plan")
    await h.app.onKey("]")
    save("alternative")
    await h.app.onKey("v")
    save("validate")
    await h.app.onKey("a")
    save("confirm")
    await h.app.onKey("\r")
    save("applied")
    await h.app.onKey("a")
    save("stale-target")
    await h.app.onKey("\x1b")
    await h.type('/ai-config plan {"intent":"quality","taskKind":"review","candidates":[{"model":"missing"}]}\r')
    save("invalid-candidate")
    await h.app.onKey("\x1b")
    const ro = b70Harness(Number(match[1]), Number(match[2]), true)
    await ro.type("/ai-config\r")
    ro.app.render()
    const rows = ro.text()
    if (rows.length !== Number(match[2]) || rows.some((row) => textWidth(row) > Number(match[1]) || /[\x00\x1b]/.test(row))) throw new Error(`Invalid read-only frame: ${size}`)
    writeFileSync(path.join(directory, `read-only-${size}.txt`), rows.join("\n") + "\n")
    await ro.app.onKey("\x1b")
  }
}
