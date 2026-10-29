import { writeFileSync } from "node:fs"
import path from "node:path"
import { b08Harness } from "../apps/cli/test/b08-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB08Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid frame size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = b08Harness(width, height)
    const key = async (value: string) => { await h.app.onKey(value); await h.type("") }
    const save = (name: string, required: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      const text = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow ${name} at ${size}`)
      if (!text.join("\n").includes(required)) throw new Error(`Missing ${required}: ${name} at ${size}`)
      if (text.some((row) => row.includes("\x1b"))) throw new Error(`ANSI in ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text.join("\n") + "\n")
    }
    await h.type("/memory\r")
    for (const [tab, name, label] of [["1", "pending", "Pending"], ["2", "saved", "Saved"], ["3", "archived", "Archived"], ["4", "dream", "Dream"], ["5", "graph", "Memory graph"], ["6", "policies", "Policies"], ["7", "evolution", "Evolution"], ["8", "extraction", "Memory controls"], ["9", "sharing-disabled", "Disabled"]]) {
      await key(tab!)
      save(`memory-${name}`, label!)
    }
    await key("e")
    save("sharing-enable-project", "Type ENABLE PROJECT")
    await h.type("ENABLE PROJECT\r")
    save("sharing-project-enabled", "project · Enabled")
    await key("o")
    save("sharing-export", "1 exported")
    h.conflicts(true)
    await key("i")
    save("sharing-conflict", "Internal revision changed")
    h.conflicts(false)
    await key("i")
    save("sharing-import", "1 proposals")
    await key("1")
    save("sharing-review", "Run focused tests")
    await key("9")
    await key("s")
    save("sharing-user-disabled", "user · Disabled")
    await key("e")
    save("sharing-enable-user", "Type ENABLE USER")
    await h.type("ENABLE USER\r")
    await key("o")
    save("sharing-user-export", "1 exported")
    await key("d")
    save("sharing-disable-user", "user · Disabled")
    h.error("Sharing directory must not be a link")
    await key("e")
    await h.type("ENABLE USER\r")
    save("sharing-error", "must not be a link")
    h.statusError(true)
    await key("r")
    save("sharing-status-error", "Unavailable")
    h.statusError(false)
    await key("2")
    await key("w")
    save("workspaces-current", "Current project")
    for (let i = 0; i < 3; i++) await key("\x1b[B")
    save("workspaces-origin", "historical-session")
    await key("\r")
    save("workspaces-selected", "API responses")
    await key("w")
    await key("\x1b[A")
    await key("\r")
    save("workspaces-all", "All projects")
    await key("5")
    save("workspaces-union-graph", "3 memories")
    await key("w")
    await key("\x1b[A")
    await key("\r")
    await key("2")
    save("workspaces-user", "User memories")
  }
}
