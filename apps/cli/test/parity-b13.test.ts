import { afterAll, beforeAll, expect, test } from "bun:test"
import { textWidth } from "../src/view/wrap"
import { cleanTemps } from "./session-ui-harness"
import { b13Cases, b13Scene } from "./formatter-ui-harness"

let cases: Awaited<ReturnType<typeof b13Cases>>
beforeAll(async () => { cases = await b13Cases() })
afterAll(cleanTemps)

test.each(["clean", "failure", "missing", "diagnostics"])("B13 %s post-write results stay in chat and History at every breakpoint", async (name) => {
  const scene = cases.find((scene) => scene.name === name)!
  expect(scene.result.isError).not.toBe(true)
  const expected = name === "clean" ? "write" : name === "failure" ? "exit 7" : name === "missing" ? "missing-formatter" : "Diagnostics:"
  if (name === "clean") expect(scene.result.output).not.toContain("Formatting:")
  else expect(scene.result.output).toContain(expected)
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const harness = b13Scene(scene, width!, height!)
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
    expect(harness.text().join("\n")).toContain("History")
    await harness.type("t")
    await harness.type("\r")
    check()
    expect(harness.text().join("\n")).toContain(expected)
    await harness.app.onKey("\x03")
    await harness.app.onKey("\x03")
  }
})
