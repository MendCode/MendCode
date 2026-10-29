import { afterAll, describe, expect, test } from "bun:test"
import { SidebarWidget } from "@mendcode/protocol"
import { FOOTER_STATS, tuiProblems } from "@mendcode/protocol/wire"
import { ui4Harness } from "./ui-4-harness"
import { appHarness, cleanTemps, ids, plain, tempDir } from "./session-ui-harness"
import { glyphs, type Line } from "../src/ui/theme"
import { alertsCard, activityCard, agentCard, contextCard, gauge, kv, quotaRow, todosCard, tokensCard, toolRow, toolsCard, workspaceCard, agentsCard } from "../src/view/sidebar-cards"
import { createTicks } from "../src/ui/app/ticks"
import type { AppContext } from "../src/ui/app/context"
import { dropForHeight } from "../src/view/sidebar-priority"
import { rightBarCells } from "../src/view/right-bar"
import { SIDEBAR_PRESETS, sidebarSpec } from "../src/view/sidebar-spec"
import { overlayRule, statusLineSpans } from "../src/view/status-line"
import { parseFooterCommand, renderFooter, segmentSpans, type FooterInput } from "../src/view/footer"
import { callSpeed, createUsageNotes } from "../src/view/usage-notes"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"

afterAll(cleanTemps)
const g = glyphs({})
const settle = async () => { await Bun.sleep(5) }
const colors = (line: Line) => line.map((span) => span.fg)

describe("card rows", () => {
  test("a gauge turns warning at 75 and error at 90, and every card row fits its width", () => {
    expect(gauge({ percent: 50, width: 30, glyphs: g })[0]!.fg).toBe("success")
    expect(gauge({ percent: 75, width: 30, glyphs: g })[0]!.fg).toBe("warning")
    expect(gauge({ percent: 91, width: 30, glyphs: g })[0]!.fg).toBe("error")
    expect(plain(gauge({ percent: 100, width: 30, glyphs: g }))).toBe(`${g.barFull.repeat(25)} 100%`)
    const width = 24
    const rows: Line[] = [
      ...agentCard({ stateLabel: "generating", state: "generating", model: "a-very-long-model-name-indeed", provider: "some-provider", effort: "high", billing: "Metered", permission: "ask before edits" }, width, g),
      ...contextCard({ tokens: 90_000, compactAt: 160_000, window: 400_000, cacheMiss: "last call missed" }, width, g),
      ...activityCard({ running: true, turnMs: 12_300, firstTokenMs: 4_700, speed: 22.3, speedEstimated: true, tools: [{ status: "running", name: "bash", summary: "bun test packages/daemon/test", durationMs: 1_200 }, { status: "error", name: "read", summary: "missing.ts" }], done: 5, failed: 1 }, width, g),
      ...workspaceCard({ project: "mendcode", branch: "feature/long-branch-name", ahead: 2, behind: 1, dirty: 4, files: 4, added: 54, removed: 20, untracked: 5, changesKnown: true, turns: 12, storageBytes: 3_500_000 }, width),
      ...tokensCard({ usage: { calls: 3, input: 1000, output: 400, reasoning: 100, cacheRead: 9000, cacheWrite: 0 }, costMicros: 123_000, subscription: true, model: "gpt-x" }, width),
      ...toolsCard({ enabled: 22, total: 25, names: ["bash", "read", "write", "edit", "grep"] }, width),
      ...alertsCard([{ level: "error", text: "MCP docs failed: spawn error and more words" }, { level: "warning", text: "short" }], width, g),
      ...todosCard({ items: [{ text: "Ship the right bar cards", status: "in_progress" }, { text: "Done thing", status: "done" }], width, glyphs: g }),
      ...agentsCard([{ title: "task: Inspect everything", status: "running", durationMs: 5000 }, { title: "task: Fix", status: "ok" }], width, g),
      quotaRow({ provider: "codex", label: "weekly", usedPercent: 93, resetMinutes: 40 }),
    ]
    for (const row of rows.slice(0, -1)) expect(textWidth(plain(row)), plain(row)).toBeLessThanOrEqual(width)
  })

  test("the activity card names the run, first token, speed and the tools with their state and time", () => {
    const rows = activityCard({ running: false, turnMs: 12_000, firstTokenMs: 4_700, speed: 22.34, tools: [{ status: "ok", name: "read", summary: "a.ts", durationMs: 340 }, { status: "error", name: "bash", durationMs: 2_100 }], done: 5, failed: 1 }, 48, g).map(plain)
    expect(rows[0]).toStartWith("Last run")
    expect(rows[0]).toContain("12.0s")
    expect(rows[1]).toContain("4.7s")
    expect(rows[2]).toContain("22.3 tok/s")
    expect(rows[3]).toStartWith(`${g.ok} read a.ts`)
    expect(rows[3]).toEndWith("340ms")
    expect(rows[4]).toStartWith(`${g.fail} bash`)
    expect(rows[5]).toBe("5 done · 1 failed")
    expect(plain(activityCard({ running: false, tools: [], done: 0, failed: 0 }, 40, g)[0]!)).toBe("No activity yet")
  })

  test("the workspace card reads Clean, Modified and Conflicts and never invents unknown git facts", () => {
    const state = (patch: Parameters<typeof workspaceCard>[0]) => workspaceCard(patch, 40).map(plain).find((row) => row.startsWith("State"))!
    expect(state({ branch: "main", files: 0, added: 0, removed: 0, dirty: 0, changesKnown: true, turns: 0 })).toContain("Clean")
    expect(state({ branch: "main", files: 1, added: 1, removed: 0, dirty: 1, changesKnown: true, turns: 0 })).toContain("Modified")
    expect(state({ branch: "main", files: 1, added: 1, removed: 0, dirty: 2, conflicts: 1, changesKnown: true, turns: 0 })).toContain("Conflicts")
    const none = workspaceCard({ files: 0, added: 0, removed: 0, changesKnown: false, turns: 1 }, 40).map(plain)
    expect(none.join("\n")).toContain("No Git repository")
    expect(none.join("\n")).not.toContain("Changes")
    expect(none.join("\n")).not.toContain("Storage")
  })

  test("the tokens card shows in, out, cache read, hit and cost with the subscription mark", () => {
    const rows = tokensCard({ usage: { calls: 2, input: 1000, output: 400, reasoning: 100, cacheRead: 9000, cacheWrite: 0 }, costMicros: 123_000, subscription: true }, 40).map(plain)
    expect(rows[0]).toContain("Input 10K")
    expect(rows[0]).toContain("Output 500")
    expect(rows[1]).toContain("Cache 9,000")
    expect(rows[1]).toContain("Hit 90%")
    expect(rows[2]).toBe("Cost     $0.12 (sub)")
    expect(plain(tokensCard({ usage: { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, subscription: false }, 40)[0]!)).toBe("No model calls yet")
  })

  test("rows carry one colour per span", () => {
    expect(colors(kv({ label: "Model", value: "m", width: 20 }))).toEqual(["muted", "text"])
    expect(colors(toolRow({ tool: { status: "error", name: "bash", durationMs: 5 }, width: 30, glyphs: g }))[0]).toBe("error")
    expect(quotaRow({ provider: "p", label: "w", usedPercent: 91 })[1]!.fg).toBe("error")
  })
})

describe("priority and width", () => {
  const card = (name: string, priority: "high" | "normal" | "low", rows: number) => ({ name, priority, rows })
  test("low cards drop first, normal only to protect high ones, high never; no priorities means scroll", () => {
    const cards = [card("a", "high", 5), card("b", "normal", 5), card("c", "low", 5), card("d", "low", 5)]
    expect(dropForHeight(cards, 40).map((entry) => entry.name)).toEqual(["a", "b", "c", "d"])
    expect(dropForHeight(cards, 12).map((entry) => entry.name)).toEqual(["a", "b"])
    expect(dropForHeight(cards, 6).map((entry) => entry.name)).toEqual(["a"])
    expect(dropForHeight(cards, 1).map((entry) => entry.name)).toEqual(["a"])
    const plainCards = [card("a", "normal", 5), card("b", "normal", 5)]
    expect(dropForHeight(plainCards, 4)).toHaveLength(2)
  })

  test("the bar keeps its automatic width, takes a set one and needs 8 more columns to return", () => {
    expect(rightBarCells({ columns: 109, setting: 0, collapsed: false })).toEqual({ cells: 0, collapsed: true })
    expect(rightBarCells({ columns: 110, setting: 0, collapsed: false })).toEqual({ cells: 48, collapsed: false })
    expect(rightBarCells({ columns: 150, setting: 0, collapsed: false }).cells).toBe(56)
    expect(rightBarCells({ columns: 112, setting: 0, collapsed: true })).toEqual({ cells: 0, collapsed: true })
    expect(rightBarCells({ columns: 118, setting: 0, collapsed: true })).toEqual({ cells: 48, collapsed: false })
    expect(rightBarCells({ columns: 120, setting: 70, collapsed: false }).cells).toBe(0)
    expect(rightBarCells({ columns: 132, setting: 70, collapsed: false }).cells).toBe(70)
  })

  test("specs accept widget priorities and the new types; presets are valid specs", () => {
    expect(sidebarSpec([{ type: "agent", options: { priority: "high" } }, { type: "alerts", options: {} }])).toHaveLength(2)
    expect(sidebarSpec([{ type: "agent", options: { priority: "urgent" } }])).toEqual([])
    for (const preset of Object.values(SIDEBAR_PRESETS)) {
      expect(sidebarSpec(structuredClone(preset))).toHaveLength(preset.length)
      expect(preset.every((widget) => SidebarWidget.safeParse(widget).success)).toBe(true)
    }
    expect(SIDEBAR_PRESETS.pulse.map((widget) => widget.type)).toEqual(["agent", "context", "pace", "workspace", "tokens", "limits"])
    expect(SIDEBAR_PRESETS.full.length).toBeGreaterThan(13)
  })

  test("sidebarWidth and promptStatus are validated the same on both sides", () => {
    expect(tuiProblems({ sidebarWidth: 60, promptStatus: "border" })).toEqual([])
    expect(tuiProblems({ sidebarWidth: 10 })).not.toEqual([])
    expect(tuiProblems({ promptStatus: "top" })).not.toEqual([])
    expect(normalizeTuiProfile({ sidebarWidth: 99, promptStatus: "border" })).toMatchObject({ sidebarWidth: 0, promptStatus: "border" })
    expect(normalizeTuiProfile({ sidebarWidth: 40 }).sidebarWidth).toBe(40)
  })
})

describe("status line and footer", () => {
  test("redraw requests share one scheduled frame", () => {
    const state = { frameScheduled: false }
    let scheduled = 0
    const ticks = createTicks({ state, schedule: () => scheduled++ } as unknown as AppContext, { render() {}, chatWidth: () => 80, sessionTitle: () => "" })
    for (let i = 0; i < 100; i++) ticks.requestFrame()
    expect(scheduled).toBe(1)
  })
  test("the line reads STATE › model › effort › repo › branch › ctx and gives up the middle first", () => {
    const base = { stateLabel: "ready", state: "idle" as const, model: "gpt-x", effort: "high", repo: "mendcode", branch: "main", contextPercent: 42, glyphs: g }
    expect(plain(statusLineSpans(base, 80))).toBe("READY › gpt-x › high › mendcode › main › compact 42%")
    const tight = plain(statusLineSpans(base, 24))
    expect(tight).toStartWith("READY")
    expect(tight).toContain("compact 42%")
    expect(textWidth(tight)).toBeLessThanOrEqual(24)
    expect(statusLineSpans({ ...base, contextPercent: 90 }, 80).at(-1)!.fg).toBe("error")
    expect(statusLineSpans({ ...base, state: "generating", stateLabel: "generating" }, 80)[0]!.fg).toBe("primary")
  })

  test("the overlay keeps the rule's width and puts the line after its first cells", () => {
    const rule: Line = [{ text: "  " }, { text: "─".repeat(38), fg: "primary" }]
    const out = overlayRule(rule, [{ text: "READY", fg: "success" }], 4)
    expect(plain(out)).toBe(`  ── READY ${"─".repeat(29)}`)
    expect(textWidth(plain(out))).toBe(40)
  })

  test("ttft, tps and spend show the last call, and /footer stats sets the telemetry order", () => {
    const calls = [{ at: 1, model: "m", output: 100, reasoning: 20, firstTokenMs: 900, durationMs: 4_900, toolCount: 0 }, { at: 2, model: "m", output: 50, reasoning: 0, firstTokenMs: 12_000, durationMs: 14_000, toolCount: 1 }]
    const input: FooterInput = { segments: FOOTER_STATS, width: 140, glyphs: g, stateLabel: "ready", state: "idle", dotOn: true, connection: "connected", permission: "ask", permissionLabel: "", quotas: [], now: 0, notice: "", calls, spentMicros: 4_000 }
    expect(plain(segmentSpans("ttft", input))).toBe("ttft 12s")
    expect(plain(segmentSpans("tps", { ...input, calls: calls.slice(0, 1) }))).toBe("30.0 tok/s")
    expect(plain(segmentSpans("spend", input))).toBe("<$0.01")
    expect(segmentSpans("ttft", { ...input, calls: [] })).toEqual([])
    expect(callSpeed({ output: 10, reasoning: 0, firstTokenMs: null, durationMs: 1000 })).toBeUndefined()
    expect(parseFooterCommand("stats")).toEqual({ ok: true, segments: [...FOOTER_STATS] })
    expect(plain(renderFooter({ ...input, calls: calls.slice(0, 1), spentMicros: 120_000, usage: { calls: 1, input: 100, output: 100, reasoning: 20, cacheRead: 0, cacheWrite: 0 } }))).toContain("ttft 900ms")
  })

  test("a narrow footer drops telemetry before the context and model", () => {
    const input: FooterInput = { segments: ["state", "context", "model", "ttft", "tps", "spend", "notice"], width: 30, glyphs: g, stateLabel: "ready", state: "idle", dotOn: true, connection: "connected", permission: "ask", permissionLabel: "", quotas: [], now: 0, notice: "", model: "gpt-x", context: { tokens: 16_000, threshold: 160_000 }, spentMicros: 5_000_000, calls: [{ at: 1, model: "m", output: 100, reasoning: 0, firstTokenMs: 900, durationMs: 4_900, toolCount: 0 }] }
    const line = plain(renderFooter(input))
    expect(line).toContain("compact 10%")
    expect(line).toContain("gpt-x")
    expect(line).not.toContain("tok/s")
  })

  test("usage events feed the per-call timings and the session spend", () => {
    const notes = createUsageNotes()
    const event = (seq: number, patch: Record<string, unknown>) => ({ type: "usage.recorded", sessionId: "s", turnId: "t", seq, at: seq * 1000, provider: "p", model: "m", input: 10, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...patch }) as never
    notes.apply(event(1, { costMicros: 1_000, profile: { estimatedTokens: { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }, firstTokenMs: 500, durationMs: 2_500, toolCount: 2, imageCount: 0 } }))
    notes.apply(event(2, { costMicros: 2_500 }))
    expect(notes.cost).toBe(3_500)
    expect(notes.calls).toHaveLength(2)
    expect(callSpeed(notes.calls[0]!)).toBe(20)
    expect(notes.calls[1]!.firstTokenMs).toBeNull()
    notes.reset()
    expect(notes.cost).toBeUndefined()
    expect(notes.calls).toEqual([])
  })
})

const profileEvent = { estimatedTokens: { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }, firstTokenMs: 1_200, durationMs: 5_200, toolCount: 1, imageCount: 0 }

describe("right bar in the app", () => {
  test("/panel pulse shows six cards with real tokens, rate and cost", async () => {
    const h = ui4Harness(180, 50)
    await h.type("/panel pulse\r")
    await settle()
    expect(h.app.accessibility.profile.sidebarWidgets.map((widget) => widget.type)).toEqual(["agent", "context", "pace", "workspace", "tokens", "limits"])
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    const turnId = ids("turn")
    h.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    h.chat.emit({ type: "usage.recorded", turnId, provider: "fake-provider", model: "fake-model", input: 12_000, output: 100, reasoning: 0, cacheRead: 3_000, cacheWrite: 0, costMicros: 12_000, profile: profileEvent })
    h.chat.emit({ type: "turn.completed", turnId })
    await settle()
    h.app.render()
    const text = h.text().join("\n")
    for (const expected of ["Agent", "Context", "Pace", "Workspace", "Tokens", "Billing", "Subscription", "tok/min", "$0.01 (sub)", "ui-four", "Hit"]) expect(text, expected).toContain(expected)
    expect(h.text().every((row) => textWidth(row) <= 180)).toBe(true)
  })

  test("a short terminal keeps the high priority cards and says how many are hidden", async () => {
    const h = ui4Harness(180, 24)
    await h.type("/panel pulse\r")
    await settle()
    h.app.render()
    const text = h.text().join("\n")
    expect(text).toContain("Agent")
    expect(text).toMatch(/\d+ hidden/)
    expect(text).toContain("pulse · /panel")
    expect(text).not.toContain("Loops")
    expect(text).not.toContain("Alerts")
  })

  test("the minimal view keeps the bar off and /sidebar width sets and bounds the session's width", async () => {
    const dataDir = tempDir()
    const minimal = appHarness({ dataDir, directory: tempDir(), width: 150, height: 40, mode: "minimal" })
    minimal.app.applySettings({ onboarded: true })
    await minimal.type("/panel pulse\r")
    await settle()
    expect(readTuiProfile(dataDir).sidebarWidgets).toEqual([])
    expect(minimal.text().join("\n")).toContain("presets need the balanced or full view")

    const h = ui4Harness(180, 50, [{ type: "agent", options: {} }])
    await h.type("/sidebar width 70\r")
    await settle()
    expect(h.app.accessibility.profile.sidebarWidth).toBe(70)
    h.app.render()
    expect(h.text().some((row) => row.slice(-70).startsWith("─ Agent"))).toBe(true)
    await h.type("/sidebar width 5\r")
    expect(h.text().join("\n")).toContain("Use /panel width 32..80 or auto")
    expect(h.app.accessibility.profile.sidebarWidth).toBe(70)
    await h.type("/sidebar width auto\r")
    await settle()
    expect(h.app.accessibility.profile.sidebarWidth).toBe(0)
  })

  test("promptStatus border draws the status line in the prompt rule and leaves the row under it telemetry only", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, promptStatus: "border", showEffort: true })
    const sessionId = ids("session")
    const h = appHarness({ dataDir, directory: tempDir("mendcode-repo-"), width: 120, height: 30, sessionId, reply: (command) => command.type === "models.list" ? { ok: true, result: { engine: "fake", effective: { model: "fake-model", effort: "high" }, roles: {}, models: [], selectable: false } } : undefined })
    h.app.applySettings({ onboarded: true })
    await settle()
    h.app.render()
    const rows = h.text()
    const line = rows.findIndex((row) => row.includes("READY ›"))
    expect(line).toBeGreaterThan(-1)
    expect(rows[line]).toContain("─")
    expect(rows[line]).toContain("fake-model")
    expect(rows.slice(line + 1).join("\n")).not.toContain("fake-model")
  })

  test("without promptStatus the rule stays plain", async () => {
    const h = appHarness({ dataDir: tempDir(), directory: tempDir(), width: 120, height: 30 })
    h.app.applySettings({ onboarded: true })
    await settle()
    h.app.render()
    expect(h.text().join("\n")).not.toContain("READY ›")
  })
})
