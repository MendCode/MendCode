import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, tempDir } from "../apps/cli/test/session-ui-harness"
import { onboardingHarness, type Machine } from "../apps/cli/test/onboarding-harness"
import { fit } from "../apps/cli/src/view/deck"

// bun scripts/render-minimalist-preset-frames.ts <directory> [WxH]
// The minimalist preset's first launch (a provider found, none found), its slash menu and /help, and a hidden command typed by hand.
const directory = process.argv[2]
if (!directory) throw new Error("usage: render-minimalist-preset-frames.ts <directory> [WxH]")
const [width, height] = (process.argv[3] ?? "80x24").split("x").map(Number) as [number, number]
mkdirSync(directory, { recursive: true })

async function firstLaunch(machine: Machine) {
  const h = onboardingHarness(machine, { width, height, env: { TERM: "xterm-256color" }, directory: "/work/app", dataDir: tempDir("mendcode-minimalist-frames-") })
  h.app.applySettings({} as never)
  await h.app.openSetupIfFirstRun({}, "minimalist")
  await Bun.sleep(10)
  h.app.render()
  return h
}
const save = (h: Awaited<ReturnType<typeof firstLaunch>>, name: string) => {
  h.app.render()
  const frame = h.frames.at(-1) ?? []
  writeFileSync(path.join(directory, `${name}.txt`), `${frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")}\n`)
}

const found = await firstLaunch({ claude: true, keys: ["anthropic"] })
save(found, "first-launch-provider-found")
await found.type("/")
save(found, "slash-menu")
await found.type("\x03")
await found.type("/help\r")
await Bun.sleep(10)
save(found, "help")
await found.app.onKey("\x1b")
await found.type("/review\r")
save(found, "hidden-command-reply")

const none = await firstLaunch({})
save(none, "first-launch-no-provider")
cleanTemps()
process.stdout.write(`frames written to ${directory}\n`)
