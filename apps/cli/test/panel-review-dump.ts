import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { reviewFixture } from "./panel-review-fixture"
import { PANEL_PRESETS } from "../src/view/sidebar-spec"
import { readTuiProfile } from "../src/view/tui-profile"
import { presetOf } from "../src/view/sidebar-spec"
import { cleanTemps } from "./session-ui-harness"

const out = process.env.PANEL_OUT ?? "/tmp/panel-review"
mkdirSync(out, { recursive: true })
// Frame dump for the panel review: bun apps/cli/test/panel-review-dump.ts (PANEL_OUT=<dir> PANEL_TIERS=full,balanced,minimalist).
const sizes: Array<[number, number]> = [[60, 20], [100, 30], [180, 50], [200, 60], [220, 60]]
const tiers = (process.env.PANEL_TIERS ?? "full").split(",") as Array<"minimalist" | "balanced" | "full">
const log: string[] = []
for (const tier of tiers) for (const session of ["home", "active"] as const) for (const [width, height] of sizes) {
  const h = reviewFixture({ width, height, tier, session })
  await Bun.sleep(12)
  const notice = () => h.text().filter((row) => /panel:|needs|Presets|Use \/panel|Galaxy/.test(row)).map((row) => row.trim()).join(" | ")
  const dump = async (name: string) => {
    await Bun.sleep(20)
    h.app.render()
    writeFileSync(path.join(out, `${tier}-${session}-${width}x${height}-${name}.txt`), `${h.text().join("\n")}\n`)
  }
  const step = async (command: string, name: string) => {
    await h.type(`${command}\r`)
    await dump(name)
    const profile = readTuiProfile(h.dataDir)
    log.push(`${tier} ${session} ${width}x${height} ${command.padEnd(14)} -> preset=${presetOf(profile.sidebarWidgets)} on=${profile.rightSidebar} notice=${notice()}`)
  }
  await step("/panel", "toggle1")
  for (let index = 0; index < 8; index++) await step("/panel next", `next${index}`)
  for (const preset of PANEL_PRESETS) await step(`/panel ${preset}`, preset)
  await step("/panel off", "off")
  await step("/panel", "toggle2")
  await step("/panel galaxy", "galaxy-again")
  await step("/sidebar right", "alias-right")
  await step("/sidebar preset crew", "alias-preset")
  await step("/panel reset", "reset")
  await step("/panel next", "next-after-reset")
  if (tier === "full") {
    await step("/panel galaxy", "galaxy-final")
    await h.type("\x1b}")
    await h.type("\t")
    await dump("galaxy-focused-tab")
    await h.type("]")
    await dump("galaxy-event")
    await h.type("\x1b")
  }
}
writeFileSync(path.join(out, "log.txt"), `${log.join("\n")}\n`)
cleanTemps()
