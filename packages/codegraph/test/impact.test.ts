import { expect, test } from "bun:test"
import { harness, project, useTempDirs } from "./helpers"

const temp = useTempDirs()
test("impact uses the cached pre-edit graph only and reports a bounded caller list", async () => {
  const root = project({ root: temp(), files: { "a.ts": "export function target() { return 1 }", "b.ts": "import { target } from './a'\nexport function caller() { return target() }\n" + "// padding\n".repeat(300) } })
  const h = harness({ root, cacheDir: temp() })
  expect((await h.call("graph_impact", { path: "a.ts" })).output).toContain("unavailable")
  expect(h.scans).toHaveLength(0)
  await h.call("graph_map", {})
  const scans = h.scans.length
  const impact = await h.call("graph_impact", { path: "a.ts" })
  expect(impact.output).toContain("1 direct callers")
  expect(impact.output).toContain("caller")
  // One caller and no importers: the answer is longer than the single rg line it replaces, so no saving is claimed.
  expect(impact.meta?.savedTokens).toBeUndefined()
  expect(h.scans.length).toBe(scans)
  expect((await h.call("graph_impact", { path: "../escape.ts" })).isError).toBe(true)
})
