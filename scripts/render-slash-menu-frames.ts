import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SLASH_LAYOUTS } from "@mendcode/protocol/wire"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../apps/cli/src/view/tui-profile"
import { textWidth } from "../apps/cli/src/view/wrap"
import { saveSlashRecent } from "../apps/cli/src/view/slash-recents"
import { appHarness, scratch } from "../apps/cli/test/extensions-harness"

const output = process.argv[2]
if (!output) throw new Error("usage: render-slash-menu-frames.ts <directory>")
mkdirSync(output, { recursive: true })
let count = 0
for (const [width, height] of [[60, 20], [100, 30], [180, 50]] as const) {
  for (const ascii of [false, true]) {
    for (const scenario of [...SLASH_LAYOUTS, "search", "tabs-session", "tabs-more", "tabs-recent", "groups-closed"] as const) {
      const layout = scenario === "tabs-session" || scenario === "tabs-more" || scenario === "tabs-recent" ? "tabs" : scenario === "groups-closed" ? "groups" : scenario
      const temporary = scratch()
      try {
        writeTuiProfile(temporary.dataDir, { ...DEFAULT_TUI_PROFILE, slashMenu: layout === "search" ? "tabs" : layout, ...(ascii ? { promptChrome: "ascii-box" } : {}) })
        if (scenario === "tabs-recent") saveSlashRecent(temporary.dataDir, "help", 1)
        const h = await appHarness({ dataDir: temporary.dataDir, directory: temporary.project, width, height })
        await h.start({ onboarded: true, tier: "full" })
        await h.type(layout === "search" ? "/comp" : "/")
        if (scenario === "tabs-session" || scenario === "tabs-more") {
          for (let i = 0; i < (scenario === "tabs-session" ? 1 : 7); i++) await h.key("\t")
        } else if (scenario !== "groups-closed" && (layout === "groups" || layout === "columns" && width < 90)) {
          for (let i = 0; i < 6; i++) await h.key("\x1b[B")
          await h.key("\x1b[C")
        } else if (layout === "columns") await h.key("\t")
        const rows = h.rows()
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`invalid frame ${layout} ${width}x${height}`)
        const name = `${scenario}-${width}x${height}${ascii ? "-ascii" : ""}`
        writeFileSync(path.join(output, name + ".txt"), rows.join("\n") + "\n")
        writeFileSync(path.join(output, name + ".json"), JSON.stringify(h.frames.at(-1), null, 2) + "\n")
        count++
        await h.key("\x03")
        await h.key("\x03")
      } finally { temporary.cleanup() }
    }
  }
}
process.stdout.write(`${count} frames written (text + styled spans)\n`)
