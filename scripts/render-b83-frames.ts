import { writeFileSync } from "node:fs"
import path from "node:path"
import { b83Harness } from "../apps/cli/test/b83-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB83Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b83Harness(width, height)
    const save = (name: string) => {
      h.app.render()
      const rows = h.text().split("\n")
      if (rows.length !== height || rows.some((line) => textWidth(line) > width || /[\x00-\x1f]/.test(line))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.open()
    save("mcp-connected")
    await h.update({ enabled: false, state: "stopped", tools: 0 })
    save("mcp-disconnected")
    await h.update({ enabled: true, state: "failed", auth: "needs_auth", lastError: "Authorization required" })
    save("mcp-needs-auth")
    await h.key("a")
    await h.update({ auth: "pending" })
    save("mcp-auth-pending")
    await h.update({ state: "running", auth: "authorized", tools: 4, lastError: undefined })
    save("mcp-authorized")
    await h.key("\x03"); await h.key("\x03")
  }
}
