import { afterEach, expect, test } from "bun:test"
import { parseAutomation, runAutomation, helpText, type AutomationDeps } from "../src/automation"
import { statsText } from "../src/stats"
import { textWidth } from "../src/view/wrap"
import { b41Harness } from "./b41-harness"
import { cleanTemps, NOW } from "./session-ui-harness"
import { usageFixture } from "./ui-5-harness"

afterEach(cleanTemps)
function parsed(...args: string[]) {
  const result = parseAutomation(args)
  if (result.ok !== true) throw new Error(JSON.stringify(result))
  return result.command
}

test("stats flags match v1 selectors while usage retains its 30-day default", () => {
  expect(parsed("stats")).toEqual({ kind: "stats", json: false })
  expect(parsed("usage")).toMatchObject({ kind: "usage", days: 30 })
  expect(parsed("stats", "--days", "0", "--tools=2", "--models", "--project", "--json")).toMatchObject({ kind: "stats", days: 0, tools: 2, models: true, project: "", json: true })
  expect(parsed("stats", "--models=2", "--project", "/work/repo")).toMatchObject({ models: 2, project: "/work/repo" })
  expect(parsed("usage", "--scope", "directory")).toMatchObject({ scope: "directory" })
  expect(parsed("package", "install", "/tmp/pkg", "--project")).toMatchObject({ scope: "project" })
  for (const args of [["--models", "x"], ["--tools", "-1"], ["--tools", "10001"], ["--days", "1.5"], ["--scope", "x"], ["--project", "--scope", "global"], ["--tools", "--json"]]) expect(parseAutomation(["stats", ...args]).ok).toBe(false)
  expect(helpText("stats")).toContain("--models [N]")
})

test("stats transport supplies full/all-time selectors and today/explicit project; remote execution uses daemon cwd", async () => {
  const sent: unknown[] = [], out: string[] = []
  const report = usageFixture()
  const deps = { client: { send: async (c: unknown) => { sent.push(c); return { ok: true, result: report } } }, cwd: "/remote/repo/src", now: () => NOW,
    out: { write: (s: string) => out.push(s) }, err: { write() {} }, listen() {},
  } as unknown as AutomationDeps
  for (const command of [parsed("stats", "--json"), parsed("stats", "--days", "0", "--project=", "--tools", "2", "--models", "1"), parsed("stats", "--project", "/remote/other")]) expect(await runAutomation(command, deps)).toBe(0)
  expect(sent[0]).toEqual({ type: "usage.query", from: "0000-01-01", to: "2026-09-30", scope: "global", directory: "/remote/repo/src", toolLimit: 0 })
  expect(sent[1]).toMatchObject({ from: "2026-09-30", to: "2026-09-30", scope: "project", toolLimit: 0 })
  expect(sent[2]).toMatchObject({ scope: "project", project: "/remote/other" })
  expect(JSON.parse(out[0]!).data.models).toHaveLength(2)
})

test("stats panels hide models by default, rank models/tools, limit display and preserve full JSON input", () => {
  const report = usageFixture()
  expect(statsText(report, { kind: "stats" })).not.toContain("Model Usage")
  expect(statsText(report, { kind: "stats" })).toContain("Tool Usage")
  const limited = statsText(report, { kind: "stats", models: 1, tools: 1 })
  expect(limited).toContain("local/dev-model")
  expect(limited).not.toContain("fixture/priced-model")
  expect(limited).toContain("read")
  expect(limited).not.toContain("shell")
  expect(limited).toContain("┌")
  expect(limited).toContain("unpriced")
  expect(report.models).toHaveLength(2)
})

for (const alias of ["stats-project"]) test(`/${alias} opens current project and scope/project keys reload`, async () => {
  const h = b41Harness()
  await h.type(`/${alias}\r`)
  expect(h.app.page).toBe("usage")
  expect(h.sentOf("usage.query").at(-1)).toMatchObject({ scope: "project", directory: "/work/mendcode/src" })
  expect(h.text().join("\n")).toContain("project stats")
  await h.app.onKey("p")
  expect(h.sentOf("usage.query").at(-1)).toMatchObject({ scope: "project", project: "/work/other" })
  await h.app.onKey("s")
  expect(h.sentOf("usage.query").at(-1)).toMatchObject({ scope: "directory" })
  expect(h.sentOf("usage.query").at(-1)).not.toHaveProperty("project")
  await h.app.onKey("s")
  expect(h.sentOf("usage.query").at(-1)).toMatchObject({ scope: "global" })
  await h.app.onKey("\x1b")
  await h.app.onKey("\x03")
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`scope screens fit ${width}x${height} with header hints and all six tabs`, async () => {
  const h = b41Harness(width, height)
  await h.type("/usage\r")
  for (let scope = 0; scope < 3; scope++) {
    for (let tab = 1; tab <= 6; tab++) {
      await h.app.onKey(String(tab))
      h.app.render()
      const rows = h.text()
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(rows[0]).toContain("s Scope")
    }
    await h.app.onKey("s")
  }
  await h.app.onKey("\x1b")
  await h.app.onKey("\x03")
})
