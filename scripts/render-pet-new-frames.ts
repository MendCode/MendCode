import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Settings } from "@mendcode/protocol"
import { appHarness, tempDir, cleanTemps } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import { DEFAULT_TOAST_MS } from "../apps/cli/src/view/toast"
import { createPetGenerator } from "../packages/daemon/src/pet-generator"
import { createBudgets } from "../packages/daemon/src/budgets"
import { fixturePng } from "../packages/tools/test/pet-fixture"

const directory = process.argv[2]
if (!directory) throw new Error("Provide the frame output directory")
mkdirSync(directory, { recursive: true })
try {
  for (const [width, height] of [[80, 24], [120, 40]]) {
    const dir = tempDir("mend-pet-frames-")
    const settings: Settings = { tier: "full", image_generation: { enabled: true, model: "openai/fixture-image" } }
    const budgets = createBudgets({ dir, settings: () => settings, seed: () => ({ costMicros: 0, knownCalls: 0, unknownCalls: 0 }) })
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const firstCall = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const generator = createPetGenerator({ dir, settings: () => settings, budgets, image: () => async () => { calls++; if (calls === 4) { started!(); await gate }; return { ok: true, model: "fixture-image", images: [{ type: "png", bytes: fixturePng() }] } } })
    const harness = appHarness({ width: width!, height: height!, dataDir: dir, pets: { dirs: [{ dir: path.join(dir, "pets"), source: "user" }], cacheDir: path.join(dir, "cache"), images: false }, reply: async (command) => command.type === "pet.manage" ? { ok: true, result: await generator.manage("frames", command.input) } : command.type === "packages.list" ? { ok: true, result: { directory: dir, packages: [] } } : { ok: true } })
    harness.app.applySettings({ ...settings, onboarded: true })
    const save = (name: string) => {
      harness.app.render()
      const frame = harness.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width!)) throw new Error(`Frame overflow: ${name}`)
      writeFileSync(path.join(directory, `${name}-${width}x${height}.txt`), frame.map((line) => fit(line, width!).map((span) => span.text).join("")).join("\n") + "\n")
    }
    await harness.type("/pet new a blue owl --usd 0.10\r")
    save("01-plan")
    await harness.type("\x1b")
    if (calls) throw new Error("Cancel made an image call")
    save("02-cancelled")
    await harness.type("/pet new a blue owl --usd 0.10\r")
    const generating = harness.type("y")
    await firstCall
    await Bun.sleep(700)
    save("03-generating")
    release!()
    await generating
    if (calls !== 6) throw new Error("Unexpected image call count")
    save("04-preview")
    await Bun.sleep(DEFAULT_TOAST_MS + 20)
    save("05-preview-settled")
  }
  writeFileSync(path.join(directory, "README.txt"), "Actual TUI Line[] frames, fake screen + fake PNG provider; 80x24 and 120x40. Temporary data dirs only. The fixture is a blue rectangle, not model-generated artwork. No provider or network verification.\n")
} finally { cleanTemps() }
