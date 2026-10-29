import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, plain } from "../apps/cli/test/session-ui-harness"
import { onboardingHarness, type Machine } from "../apps/cli/test/onboarding-harness"
import { fit } from "../apps/cli/src/view/deck"

// bun scripts/render-onboarding-frames.ts <directory> [before|after] [80x24 100x30 200x60 ...]
const directory = process.argv[2]
if (!directory) throw new Error("usage: render-onboarding-frames.ts <directory> [before|after] [WxH ...]")
const phase = process.argv[3] === "after" ? "after" : "before"
const sizes = process.argv.slice(4).filter((arg) => /^\d+x\d+$/.test(arg))
const list = sizes.length ? sizes : ["80x24", "100x30", "200x60"]
mkdirSync(directory, { recursive: true })

const machine: Machine = { claude: true, chatgpt: false, keys: ["anthropic"], importable: { mcp: 3, commands: 2 } }

for (const size of list) {
  const [width, height] = size.split("x").map(Number) as [number, number]
  const h = onboardingHarness(machine, { width, height, env: { TERM: "xterm-256color" }, directory: "/work/app" })
  const save = (name: string) => {
    h.app.render()
    const frame = h.frames.at(-1) ?? []
    writeFileSync(path.join(directory, `${name}-${size}.txt`), `${frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")}\n`)
  }
  await h.app.openSetupIfFirstRun({})
  await Bun.sleep(10)
  save("first-run")
  if (phase === "before") {
    await h.app.onKey("\x1b")
    await h.type("/tutorial\r")
    for (let i = 0; i < 4; i++) {
      save(`tutorial-${i + 1}`)
      await h.app.onKey("\x1b[C")
    }
    await h.app.onKey("\x1b")
    for (const command of ["/import setup", "/doctor"]) {
      await h.type(`${command}\r`)
      await Bun.sleep(10)
      save(command.slice(1).replace(/\W+/g, "-"))
      await h.app.onKey("\x1b")
    }
  }
  void plain
}
cleanTemps()
