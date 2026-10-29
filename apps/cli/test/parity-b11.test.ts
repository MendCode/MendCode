import { afterEach, expect, test } from "bun:test"
import { textWidth } from "../src/view/wrap"
import { cleanTemps } from "./session-ui-harness"
import { b11Cases, b11Scene } from "./lsp-presets-ui-harness"

afterEach(cleanTemps)

test("B11 preset results and dependency/partial-diagnostics errors stay in chat/history at every breakpoint", async () => {
  const cases = await b11Cases()
  expect(cases).toHaveLength(15)
  expect(cases.slice(0, 10).every((scene) => !scene.result.isError)).toBe(true)
  expect(cases.slice(10, 13).every((scene) => scene.result.isError)).toBe(true)
  expect(cases[13]!.result.output).toContain("error E001")
  expect(cases[14]!.result.output).toContain("no problems reported by available servers")
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    for (const scene of cases) {
      const harness = b11Scene(scene, width!, height!)
      const check = () => {
        expect(harness.frames.at(-1)).toHaveLength(height!)
        for (const row of harness.text()) {
          expect(textWidth(row)).toBeLessThanOrEqual(width!)
          expect(row).not.toContain("\x1b")
        }
      }
      check()
      expect(harness.text().join("\n")).toContain(scene.tool)
      await harness.type("/history\r")
      expect(harness.text().join("\n")).toContain("History")
      await harness.type("t")
      await harness.type("\r")
      check()
      expect(harness.text().join("\n")).toContain(scene.tool)
      await harness.app.onKey("\x03")
      await harness.app.onKey("\x03")
    }
  }
}, 15_000)
