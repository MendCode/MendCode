import { afterEach, expect, test } from "bun:test"
import { fileApiHarness } from "./b35-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
import { toolGate } from "../../../scripts/test-budget"

afterEach(cleanTemps)
// The payloads come from the ripgrep-backed text search (a missing ripgrep is an HTTP 501 by contract), so the case needs rg;
// the workflow installs it and lists it in MENDCODE_REQUIRE_TOOLS, which turns a missing rg into a failure instead of a skip.
const rg = toolGate("rg")
rg.test.each([[60, 20], [100, 30], [180, 50]])(`B35 API payloads fit the existing chat at %ix%i without adding a side panel or leaking errors${rg.suffix}`, async (width, height) => {
  const h = await fileApiHarness(width, height)
  expect(h.content.content).toContain("return 42")
  expect(h.text().join("\n")).toContain("return 42")
  await h.search()
  expect(h.text().join("\n")).toContain("src/app.ts:1")
  expect(h.frames.at(-1)).toHaveLength(height)
  expect(h.text().every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
  expect(h.text().join("\n")).not.toContain("File request failed")
  await h.app.onKey("\x03")
})
