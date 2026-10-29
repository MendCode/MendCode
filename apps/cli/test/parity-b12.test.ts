import { afterAll, expect, test } from "bun:test"
import { OTHER_SERVERS } from "../../../packages/lsp/src/other-presets"
import { textWidth } from "../src/view/wrap"
import { cleanTemps } from "./session-ui-harness"
import { b12Cases, b12Scene } from "./lsp-other-presets-ui-harness"

afterAll(cleanTemps)

// Every server builds its own cases inside its test: one shared beforeAll started every fixture server in series (15 s alone) under a 15 s hook ceiling.
test.each(OTHER_SERVERS.map((spec) => spec.id))("B12 %s results and missing dependencies remain readable in chat/history at every breakpoint", async (id) => {
  const name = id.replaceAll(" ", "-")
  const cases = await b12Cases([id])
  const scenes = cases.filter((scene) => scene.name === name || scene.name === `${name}-unavailable`)
  expect(scenes).toHaveLength(2)
  expect(scenes[0]!.result.isError).not.toBe(true)
  expect(scenes[1]!.result.isError).toBe(true)
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) for (const scene of scenes) {
    const harness = b12Scene(scene, width!, height!)
    const check = () => {
      expect(harness.frames.at(-1)).toHaveLength(height!)
      for (const row of harness.text()) {
        expect(textWidth(row)).toBeLessThanOrEqual(width!)
        expect(row).not.toContain("\x1b")
      }
    }
    check()
    expect(harness.text().join("\n")).toContain("lsp")
    await harness.type("\x0f")
    check()
    // At 20 rows the pinned sticky prompt takes one transcript row, so the expanded card shows only its tail.
    if (!scene.result.isError) expect(harness.text().join("\n")).toContain(height! < 30 ? "\"character\": 8" : "execute")
    await harness.type("/history\r")
    expect(harness.text().join("\n")).toContain("History")
    await harness.type("t")
    await harness.type("\r")
    check()
    expect(harness.text().join("\n")).toContain("lsp")
    await harness.app.onKey("\x03")
    await harness.app.onKey("\x03")
  }
})
