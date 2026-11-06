import { afterAll, describe, expect, test } from "bun:test"
import { setTheme } from "../src/ui/theme"
import { type Settings, tuiProblems } from "@mendcode/protocol/wire"
import { dockPanels, DOCK_HEIGHT, parseTodoText, renderDock } from "../src/view/dock"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"
import { CUSTOMIZE_ROWS, customizePageKey } from "../src/view/customize-page"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, NOW, plain } from "./session-ui-harness"

afterAll(cleanTemps)
const info = { cwd: "/work/app", permission: "ask", activity: "generating" }
const long = "Implementar sobres v2 y bloques de contenido conservando los estados y los controles existentes para todas las terminales"
const list = `[x] Read the parser\n[~] ${long}\n[ ] Run tests\n[ ] Update docs`
const jobs = [{ command: "bun run dev", status: "running" as const, startedAt: NOW }]

function fixture(width: number, height: number, theme: string, density: "compact" | "comfortable" | "spacious", tier: "minimalist" | "balanced" | "full", dockJobs = false) {
  expect(setTheme(theme)).toBe(true)
  const h = appHarness({ width, height, mode: tier === "minimalist" ? "minimal" : tier, hostProfile: { ...DEFAULT_TUI_PROFILE, theme, density, sidebar: "hidden", dockJobs }, reply(command) {
    if (command.type === "background.list") return { ok: true, result: { tasks: [{ ...jobs[0], id: "bg1", sessionId: h.sessionId, cwd: "/work/app" }] } } as never
    return undefined
  } })
  h.app.applySettings({ tier, view: tier === "minimalist" ? "minimal" : tier } as Settings)
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Keep the task list readable", "I will update the dock.")
  const turnId = ids("turn"), itemId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "todo" } })
  chat.emit({ type: "item.completed", turnId, itemId, status: "ok", text: list, meta: { tool: "todo 1/4", retitled: true } })
  chat.emit({ type: "foreground.state", state: "generating", turnId })
  h.app.render()
  return h
}

describe("todo dock contract", () => {
  test("Jobs defaults off, validates, normalizes, and toggles in Customize", () => {
    expect(DEFAULT_TUI_PROFILE.dockJobs).toBe(false)
    expect(normalizeTuiProfile({}).dockJobs).toBe(false)
    expect(normalizeTuiProfile({ dockJobs: true }).dockJobs).toBe(true)
    expect(tuiProblems({ dockJobs: true })).toEqual([])
    expect(customizePageKey({ row: CUSTOMIZE_ROWS.indexOf("dockJobs") }, "\r", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { dockJobs: true } })
    const input = { width: 200, todos: parseTodoText(list), jobs, subagents: [], info }
    expect(dockPanels(input)).not.toContain("jobs")
    expect(dockPanels({ ...input, showJobs: true })).toContain("jobs")
    const widthOf = (showJobs: boolean) => plain(renderDock({ ...input, showJobs })[0]!).indexOf("┐")
    expect(widthOf(false)).toBeGreaterThan(widthOf(true))
  })

  test("current and pending items precede muted completed items; +N counts items, not wrapped lines", () => {
    const todos = parseTodoText("[x] done\n[ ] pending\n[~] current\n[ ] next\n[ ] later\n[ ] last")
    const rows = renderDock({ width: 100, todos, subagents: [], info })
    const text = rows.map(plain).join("\n")
    expect(text.indexOf("▸ current")).toBeLessThan(text.indexOf("□ pending"))
    expect(text).toContain("+2 more")
    expect(text).not.toContain("✓ done")
    const finished = renderDock({ width: 100, todos: parseTodoText("[x] high priority finished task"), subagents: [], info })
    expect(finished.flat().find((span) => span.text.includes("high priority finished task"))?.fg).toBe("muted")
    const oversized = renderDock({ width: 80, todos: [{ text: "long task ".repeat(80), status: "in_progress" }, { text: "next", status: "pending" }], subagents: [], info })
    expect(oversized).toHaveLength(DOCK_HEIGHT)
    expect(oversized.map(plain).join("\n")).toContain("+2 more")
  })

  for (const [width, height] of [[80, 30], [100, 30], [200, 60]] as const) {
    test(`wraps with hanging indent and no clipped words at ${width}x${height}`, () => {
      const rows = renderDock({ width, todos: [{ text: long, status: "in_progress" }], subagents: [], info, scratch: { lines: [""], editing: false } })
      expect(rows).toHaveLength(DOCK_HEIGHT)
      rows.forEach((row) => expect(textWidth(plain(row))).toBe(width))
      const end = plain(rows[0]!).indexOf("┐")
      const body = rows.slice(3, 8).map((row) => plain(row).slice(2, end).trimEnd())
      expect(body[0]).toStartWith("▸ ")
      const continuation = body.filter((line) => line.startsWith("  ") && line.trim())
      expect(continuation.length).toBeGreaterThan(0)
      if (width === 80) expect(body.join("\n")).toContain("+1 more")
      else expect(body.filter((line) => line.trim()).map((line) => line.slice(2)).join(" ")).toBe(long)
      expect(rows.map(plain).join("\n")).toMatchSnapshot()
    })
  }

  for (const theme of ["mend", "paper"]) for (const density of ["compact", "comfortable", "spacious"] as const) for (const tier of ["minimalist", "balanced", "full"] as const) {
    test(`${theme}, ${density}, ${tier}: running turn has no task row and Jobs is opt-in`, async () => {
      const h = fixture(100, 30, theme, density, tier)
      expect(h.text().join("\n")).not.toContain("· 1/4")
      expect(h.text().join("\n")).toContain("Generating")
      await h.type("\x14")
      const text = h.text().join("\n")
      expect(text).not.toMatch(/Jobs\s+1 running/)
      if (tier === "minimalist") expect(text).not.toContain("Scratchpad")
      else expect(text).toMatch(/Todos\s+3 open/)
      expect(h.frames.at(-1)!.length).toBeLessThanOrEqual(30)
      for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(100)
    })
  }

  test("Jobs page remains reachable with the dock panel off", async () => {
    const h = fixture(100, 30, "mend", "comfortable", "balanced")
    await h.type("/jobs\r")
    expect(h.text().join("\n")).toContain("Jobs")
  })
})
