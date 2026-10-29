import { writeFileSync } from "node:fs"
import path from "node:path"
import { b61Harness } from "../apps/cli/test/b61-harness"
import { SETUP_ROWS } from "../apps/cli/src/view/setup-page"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB61Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b61Harness(width, height)
    const save = (name: string, page = "setup") => {
      if (h.app.page !== page) throw new Error(`${name}: expected ${page}, got ${h.app.page}`)
      h.app.render()
      const rows = h.text()
      if (rows.length !== height || rows.some((row) => textWidth(row) > width || /[\x00\x1b]/.test(row))) throw new Error(`Invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const select = async (row: typeof SETUP_ROWS[number]) => {
      for (let i = 0; i < SETUP_ROWS.length; i++) await h.app.onKey("\x1b[A")
      for (let i = 0; i < SETUP_ROWS.indexOf(row); i++) await h.app.onKey("\x1b[B")
    }
    h.app.applySettings({})
    await h.app.openSetupIfFirstRun({})
    save("setup-welcome")
    await select("preset")
    await h.type("\x1b[C")
    save("setup-preset")
    h.policy({ mode: "api-usage", warnUsd: 1, stopUsd: 3, suppliedUsd: 1.5, prices: { "local:main": { input: 1, output: 2 } } })
    await h.app.openSetup()
    await select("budgetMode")
    save("setup-budget-warn")
    h.policy({ mode: "api-usage", warnUsd: 1, stopUsd: 3, suppliedUsd: 3, prices: { "local:main": { input: 1, output: 2 } } })
    await h.app.openSetup()
    await select("stopUsd")
    save("setup-budget-stop")
    await h.type("0.5\r")
    save("setup-budget-error")
    await h.app.onKey("\x1b")
    h.policy({})
    await h.app.openSetup()
    await select("helper")
    await h.type("\r")
    await h.type("Which model handles setup?\r")
    save("setup-helper")
    h.refuse("Fake provider failure")
    await h.type("Can you change it?\r")
    save("setup-helper-error")
    await h.app.onKey("\x1b")
    h.available(false)
    await h.app.openSetup()
    await select("helper")
    await h.type("\r")
    save("setup-helper-unavailable")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    await h.app.openIntro()
    save("intro-signal", "intro")
    await h.app.onKey("\r")
    h.app.applySettings({ reducedMotion: true, onboarded: true })
    await h.app.openIntro()
    save("intro-identity", "intro")
    await h.app.onKey("\r")
  }
}
