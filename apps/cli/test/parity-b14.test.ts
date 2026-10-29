import { afterAll, expect, test } from "bun:test"
import { STACK_FORMATTERS } from "../../../packages/lsp/src/stack-formatters"
import { textWidth } from "../src/view/wrap"
import { cleanTemps } from "./session-ui-harness"
import { b14Cases, b14Scene } from "./stack-formatters-ui-harness"

afterAll(cleanTemps)

// Every stack builds its own three cases inside its test: one shared beforeAll spawned ~46 fixture formatters in series (7+ s idle) under a 15 s hook ceiling.
test.each(STACK_FORMATTERS.map((spec) => spec.name))("B14 %s: clean/failure/missing in chat and History at every breakpoint", async (name) => {
  const scenes = await b14Cases([name])
  expect(scenes).toHaveLength(3)
  for (const scene of scenes) {
    expect(scene.result.isError).not.toBe(true)
    const expected = scene.name.endsWith("failure") ? `${name}: exit 7` : scene.name.endsWith("missing") ? `missing-${name}` : "write"
    if (scene.name.endsWith("clean")) expect(scene.result.output).not.toContain("Formatting:")
    else expect(scene.result.output).toContain(expected)
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const harness = b14Scene(scene, width!, height!)
      const check = () => {
        expect(harness.frames.at(-1)).toHaveLength(height!)
        for (const row of harness.text()) {
          expect(textWidth(row)).toBeLessThanOrEqual(width!)
          expect(row).not.toContain("\x1b")
        }
      }
      check()
      await harness.type("\x0f")
      check()
      expect(harness.text().join("\n")).toContain(expected)
      await harness.type("/history\r")
      await harness.type("t")
      await harness.type("\r")
      check()
      expect(harness.text().join("\n")).toContain(expected)
      await harness.app.onKey("\x03")
      await harness.app.onKey("\x03")
    }
  }
})
