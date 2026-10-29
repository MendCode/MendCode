import { afterEach, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { compactionB23Harness } from "./b23-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
for (const [width, height] of [[60, 20], [100, 30], [180, 50], [220, 60]]) test(`B23 compaction facts replay in bordered panels at ${width}x${height}`, async () => {
  const h = compactionB23Harness(width, height, "incremental", "http")
  h.app.render()
  expect(h.text().join("\n")).not.toContain("Native checkpoint")
  await h.type("/compaction\r")
  expect(h.text().join("\n")).toContain("Memory · incremental")
  expect(h.text().join("\n")).toContain("Preserve tail · 2 turns")
  expect(h.text().join("\n")).toContain("~248 tokens")
  expect(h.text().join("\n")).toContain("Portable fallback · http")
  expect(h.text()[0]).toContain("esc back")
  h.finish()
  expect(h.app.transcript.compactions()[0]).toMatchObject({ method: "incremental", tailTurns: 2, tailTokens: 248, fallbackReason: "http" })
  h.app.render()
  expect(h.frames.at(-1)).toHaveLength(height!)
  expect(h.text().every((line) => textWidth(line) <= width!)).toBe(true)
  expect(h.text().join("\n")).not.toContain("Preserve tail · off")
}, width === 220 ? 10_000 : undefined)

test("B23 native progress names the checkpoint and never exposes its opaque content", async () => {
  const h = compactionB23Harness(100, 30, "native")
  h.finish()
  await h.type("/compaction\r")
  await h.app.onKey("m")
  expect(h.text().join("\n")).toContain("Native checkpoint")
  expect(h.text().join("\n")).toContain("Native context checkpoint installed")
  expect(h.text().join("\n")).not.toContain("encrypted_content")
})
