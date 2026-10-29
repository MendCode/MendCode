import { afterEach, expect, test } from "bun:test"
import { parseAutomation } from "../src/automation"
import { mcpsPageKey, renderMcpsPage } from "../src/view/mcps-page"
import { textWidth } from "../src/view/wrap"
import { b47Harness, B47_CATALOG, B47_STATUS } from "./b47-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)

test("catalog keys browse resources, read their content and insert a mention without submitting", async () => {
  const h = b47Harness()
  await h.open()
  expect(h.text()).toContain("MCP catalog")
  expect(h.text()).toContain("docs:Project_guide")
  await h.key("r")
  expect(h.text()).toContain("Daemon owns I/O")
  expect(h.sentOf("mcp.resource.read")).toHaveLength(1)
  await h.key("\r")
  expect(h.app.editor.text).toBe("@docs:Project_guide ")
  expect(h.sentOf("user.submit")).toHaveLength(0)
})

test("@resource completion only completes and required slash arguments keep the draft on failure", async () => {
  const h = b47Harness()
  await h.app.extensionsReady
  await h.type("Use @docs:Proj")
  await h.key("\t")
  expect(h.app.editor.text).toBe("Use @docs:Project_guide ")
  expect(h.sentOf("user.submit")).toHaveLength(0)
  h.app.editor.clear()
  await h.type("/docs:")
  await h.key("")
  expect(h.text()).toContain("MCP")
  expect(h.text()).not.toContain(":custom")
  h.app.editor.replaceAll("/docs:review_code")
  await h.key("\r")
  expect(h.app.editor.text).toBe("/docs:review_code")
  expect(h.text()).toContain("needs <target>")
  expect(h.sentOf("user.submit")).toHaveLength(0)
  h.app.editor.replaceAll('/docs:review_code "src/my file.ts"')
  await h.key("\r")
  expect(h.sentOf("commands.expand")).toHaveLength(2)
  expect(h.sentOf("user.submit")[0]).toMatchObject({ text: 'Review "src/my file.ts"' })
})

test("prompt and template sections are reachable and empty/error states reflect real results", async () => {
  const h = b47Harness()
  await h.open()
  await h.key("\t")
  expect(h.text()).toContain("<target>")
  await h.key("\r")
  expect(h.app.editor.text).toBe("/docs:review_code ")
  h.app.editor.clear()
  await h.open()
  await h.key("\t")
  await h.key("\t")
  expect(h.text()).toContain("issues://{id}")
  await h.key("\r")
  expect(h.sentOf("user.submit")).toHaveLength(0)
  const empty = b47Harness(100, 30, { empty: true })
  await empty.open()
  expect(empty.text()).toContain("resources 0")
  const failed = b47Harness(100, 30, { failed: true })
  await failed.open()
  expect(failed.text()).toContain("connection refused")
  const partial = b47Harness(100, 30, { partial: true })
  await partial.open()
  expect(partial.text()).toContain("docs:Project_guide")
  expect(partial.text()).toContain("prompts/list: unavailable")
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`catalog fits ${width}×${height} with borders and hints in its header`, () => {
  for (const catalogTab of ["resources", "prompts", "templates"] as const) {
    const state = { selected: 0, catalogOpen: true, catalogTab, catalog: B47_CATALOG, catalogSelected: 0 }
    const rows = renderMcpsPage({ report: B47_STATUS, state, width: width!, height: height! })
    expect(rows).toHaveLength(height!)
    expect(rows.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
    expect(rows[0]?.map((span) => span.text).join("")).toContain("tab")
    const header = rows[0]?.map((span) => span.text).join("") ?? ""
    expect(header.includes("r read")).toBe(catalogTab === "resources")
    if (width >= 70) expect(header.includes("enter use")).toBe(catalogTab !== "templates")
    expect(rows.flat().map((span) => span.text).join("")).toContain("┌")
    const bottom = mcpsPageKey({ ...state, catalogSelected: 900 }, "\x1b[B", B47_STATUS.servers)
    expect(bottom.state.catalogSelected).toBeLessThan(Math.max(1, B47_CATALOG[catalogTab].length))
  }
})

test("MCP CLI accepts callback settings and refuses unsafe redirects or conflicting flags", () => {
  const valid = parseAutomation(["mcp", "add", "docs", "--url", "https://mcp.test", "--callback-port", "19876", "--redirect-uri", "http://localhost:19877/oauth/custom"])
  expect(valid).toMatchObject({ ok: true, command: { config: { oauth: { callbackPort: 19876, redirectUri: "http://localhost:19877/oauth/custom" } } } })
  expect(parseAutomation(["mcp", "add", "docs", "--url", "https://mcp.test", "--redirect-uri", "https://external.test/callback?project=docs"])).toMatchObject({ ok: true, command: { config: { oauth: { redirectUri: "https://external.test/callback?project=docs" } } } })
  for (const flags of [["--callback-port", "0"], ["--callback-port", "65536"], ["--redirect-uri", "ftp://external.test/callback"], ["--redirect-uri", "http://localhost/callback#invalid"], ["--callback-port", "19876", "--no-oauth"]]) expect(parseAutomation(["mcp", "add", "docs", "--url", "https://mcp.test", ...flags]).ok).toBe(false)
})
