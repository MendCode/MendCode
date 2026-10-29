import { afterEach, expect, test } from "bun:test"
import { memoryControlHarness } from "./memory-control-ui-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)

test("B19 imported proposals remain editable and reviewable in the native Memory Center", async () => {
  const h = memoryControlHarness(100, 30)
  await h.type("/memory\r")
  expect(h.text().join("\n")).toContain("Use pnpm 11 for dependencies")
  await h.app.onKey("e")
  expect(h.text().join("\n")).toContain("Use pnpm 11 for dependencies")
  await h.app.onKey("\x1b")
  await h.app.onKey("a")
  expect(h.sentOf("memory.update").at(-1)).toMatchObject({ status: "saved" })
  await h.app.onKey("2")
  await h.type("")
  expect(h.text().join("\n")).toContain("Use pnpm 11 for dependencies")
})

test("B19 completed Dream run and consolidation notes appear in its existing page", async () => {
  const h = memoryControlHarness(180, 50)
  await h.type("/memory\r")
  await h.app.onKey("4")
  expect(h.text().join("\n")).toContain("consolidation preview")
  await h.app.onKey("v")
  expect(h.text().join("\n")).toContain("0 applied")
})
