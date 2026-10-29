import { afterEach, expect, test } from "bun:test"
import { cleanTemps, NOW } from "./session-ui-harness"
import { b08Harness, B08_CURRENT, B08_OTHER } from "./b08-fixtures"
import { createMemoryPageState, memoryPageKey, renderMemoryPage } from "../src/view/memory-page"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
const text = (h: ReturnType<typeof b08Harness>) => h.text().join("\n")
const key = async (h: ReturnType<typeof b08Harness>, input: string) => { await h.app.onKey(input); h.app.render() }

test("memory and its mem alias open all nine tabs; Sharing is lazy and tab cycles", async () => {
  const h = b08Harness()
  await h.type("/memory\r")
  expect(h.app.page).toBe("memory")
  expect(h.sentOf("memory.workspaces")).toHaveLength(1)
  expect(h.sentOf("memory.sharing.status")).toHaveLength(0)
  await key(h, "9")
  await h.type("")
  expect(h.sentOf("memory.sharing.status")[0]).toMatchObject({ scope: "project", directory: B08_CURRENT })
  expect(text(h)).toContain("Editable Markdown")
  expect(text(h)).toContain("project · Disabled")
  await key(h, "\t")
  expect(text(h)).toContain("Pending")
  await key(h, "\x1b")
  await h.type("/mem\r")
  expect(h.app.page).toBe("memory")
})

test("enable accepts only a complete scope confirmation; digits and Tab never execute", async () => {
  const h = b08Harness()
  await h.type("/memory\r")
  await key(h, "9")
  await key(h, "e")
  await h.type("9\t")
  await key(h, "\r")
  expect(h.sentOf("memory.sharing.configure")).toEqual([])
  expect(text(h)).toContain("Type ENABLE PROJECT")
  await key(h, "\x15")
  await h.type("ENABLE PROJECT\r")
  expect(h.sentOf("memory.sharing.configure")[0]).toMatchObject({ enabled: true, confirmation: "ENABLE PROJECT" })
  expect(text(h)).toContain("project · Enabled")
  await key(h, "d")
  expect(h.sentOf("memory.sharing.configure")[1]).toMatchObject({ enabled: false })
  expect(text(h)).toContain("project · Disabled")
})

test("scope changes refresh status; cancelling consent keeps Sharing open without changing settings", async () => {
  const h = b08Harness()
  await h.type("/memory\r")
  await key(h, "9")
  await key(h, "s")
  expect(h.sentOf("memory.sharing.status").at(-1)).toMatchObject({ scope: "user" })
  await key(h, "e")
  await key(h, "\x1b")
  expect(h.app.page).toBe("memory")
  expect(text(h)).not.toContain("Type ENABLE USER")
  expect(h.sentOf("memory.sharing.configure")).toEqual([])
})

test("exports/imports show real results and conflicts; imported revisions appear in Pending", async () => {
  const h = b08Harness()
  await h.type("/memory\r")
  await key(h, "9")
  await key(h, "e")
  await h.type("ENABLE PROJECT\r")
  await key(h, "o")
  expect(text(h)).toContain("1 exported · 0 proposals")
  h.conflicts(true)
  await key(h, "i")
  expect(text(h)).toContain("Internal revision changed")
  expect(text(h)).toContain("1 conflicts")
  h.conflicts(false)
  await key(h, "i")
  expect(text(h)).toContain("0 exported · 1 proposals")
  await key(h, "1")
  expect(text(h)).toContain("Run focused tests and the default suite")
  await key(h, "a")
  expect(h.sentOf("memory.update").at(-1)).toMatchObject({ status: "saved" })
})

test("a sharing failure stays visible in its panel and preserves the scope", async () => {
  const h = b08Harness()
  h.error("Sharing directory must not be a link")
  await h.type("/memory\r")
  await key(h, "9")
  await key(h, "e")
  await h.type("ENABLE PROJECT\r")
  expect(text(h)).toContain("Sharing directory must not be a link")
  expect(text(h)).toContain("project · Disabled")
  h.statusError(true)
  await key(h, "r")
  expect(text(h)).toContain("Unavailable")
  expect(text(h)).toContain("Sharing inventory is invalid")
})

test("project browser shows origin and selects memories without switching the chat's session", async () => {
  const h = b08Harness(180, 50)
  await h.type("/memory\r")
  await key(h, "w")
  for (let i = 0; i < 3; i++) await key(h, "\x1b[B")
  expect(text(h)).toContain("historical-session")
  expect(text(h)).toContain("0 manual · 1 agent")
  await key(h, "\r")
  await key(h, "2")
  expect(h.sentOf("memory.browse").at(-1)).toMatchObject({ directory: B08_CURRENT, root: B08_OTHER, view: "project" })
  expect(text(h)).toContain("API responses keep additive fields")
  expect(text(h)).not.toContain("Run bun test before release")
  expect(h.subscriptions).toHaveLength(0)
  expect(text(h)).toContain(B08_OTHER)
  await key(h, "4")
  await key(h, "r")
  expect(h.sentOf("dream.run").at(-1)).toMatchObject({ directory: B08_OTHER })
  h.app.onGlobal({ type: "dream.changed", gseq: 1, at: NOW, run: { runId: 42, directory: B08_OTHER, status: "done", startedAt: NOW, endedAt: NOW, proposed: 0, notes: "Workspace review" } })
  await h.type("")
  expect(text(h)).toContain("Workspace review")
})

test("all projects and user scope filter the list and graph together", async () => {
  const h = b08Harness()
  await h.type("/memory\r")
  await key(h, "w")
  await key(h, "\x1b[B")
  await key(h, "\x1b[B")
  await key(h, "\r")
  await key(h, "2")
  expect(text(h)).toContain("All projects")
  expect(text(h)).toContain("API responses keep additive fields")
  expect(text(h)).toContain("Run bun test before release")
  await key(h, "5")
  await h.type("")
  expect(h.sentOf("memory.browse").at(-1)).toMatchObject({ view: "all" })
  expect(text(h)).toContain("3 memories")
  await key(h, "w")
  await key(h, "\x1b[A")
  await key(h, "\r")
  await key(h, "2")
  expect(text(h)).toContain("Keep replies terse")
  expect(text(h)).not.toContain("API responses keep additive fields")
})

test("workspace navigation does not intercept a list filter or consent text", () => {
  const filtering = { ...createMemoryPageState(), filtering: true }
  expect(memoryPageKey(filtering, "w", []).state.filter).toBe("w")
  const consent = { ...createMemoryPageState(), tab: "sharing" as const, sharing: { scope: "project" as const, scroll: 0, confirmation: "" } }
  expect(memoryPageKey(consent, "w", []).state.workspace.picking).toBeUndefined()
  expect(memoryPageKey(consent, "w", []).state.sharing.confirmation).toBe("w")
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
  test(`B08 panels and selected origins fit ${width}x${height}`, async () => {
    const h = b08Harness(width, height)
    await h.type("/memory\r")
    for (const tab of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      await key(h, tab)
      await h.type("")
      const rows = h.frames.at(-1)!
      expect(rows).toHaveLength(height)
      expect(rows.every((line) => textWidth(line.map((span) => span.text).join("")) <= width)).toBe(true)
      expect(text(h)).toContain("┌")
      expect(h.text()[0]).toContain("esc back")
    }
    const report = { omitted: 0, workspaces: Array.from({ length: 50 }, (_, i) => ({ ...h.workspaces.workspaces[0]!, root: `/work/project-${i}`, label: `project-${i}` })) }
    const frame = renderMemoryPage({ state: { ...createMemoryPageState(), workspace: { view: "project", picking: 52 } }, memories: [], data: { workspaces: report, currentDirectory: B08_CURRENT }, width, height, now: NOW })
    expect(frame.map((line) => line.map((span) => span.text).join("")).join("\n")).toContain("project-49")
    expect(frame.every((line) => textWidth(line.map((span) => span.text).join("")) <= width)).toBe(true)
  })
}
