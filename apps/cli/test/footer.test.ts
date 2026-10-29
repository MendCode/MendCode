import { describe, expect, test } from "bun:test"
import { DEFAULT_FOOTER, FOOTER_SEGMENTS, createIdFactory, type FooterSegment, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { parseFooterCommand, quotaText, renderFooter, segmentSpans, type FooterInput } from "../src/view/footer"
import { parseSlash } from "../src/view/commands"
import { createTranscript } from "../src/view/transcript"
import { contextLimit } from "../src/view/context-meter"
import { statusLineSpans } from "../src/view/status-line"
import { contextBar } from "../src/view/topbar"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const text = (line: Line) => line.map((span) => span.text).join("")

const quota = { type: "quota.snapshot", gseq: 1, at: NOW, provider: "codex", windows: [{ id: "7d", label: "7d", usedPercent: 17, resetsAt: NOW + 6 * 86_400_000 }], fetchedAt: NOW, source: "t" } as never

function input(patch: Partial<FooterInput> = {}): FooterInput {
  return {
    segments: DEFAULT_FOOTER, width: 140, glyphs: glyphs({}), stateLabel: "ready", state: "idle", dotOn: true, connection: "connected", permission: "ask", permissionLabel: "ask before edits",
    quotas: [quota], now: NOW, notice: "", ...patch,
  }
}

const full = (patch: Partial<FooterInput> = {}) =>
  input({ segments: FOOTER_SEGMENTS, permission: "full", permissionLabel: "full access", context: { tokens: 36_800, threshold: 160_000 }, model: "gpt-6-luna", today: { tokens: 1_234_567, calls: 12, costMicros: 420_000 }, branch: "main", notice: "saved", ...patch })

describe("footer segments", () => {
  test("old and absent quota observations are explicit, and malformed percentages cannot overflow a bar", () => {
    const snapshot = { type: "quota.snapshot", gseq: 1, at: NOW, provider: "codex", fetchedAt: NOW - 3_600_000, source: "test", windows: [{ id: "x", label: "5h", usedPercent: 100 }] } as const
    expect(text(segmentSpans("quota", input({ quotas: [snapshot] })))).toBe("codex 5h ████████ 100% ~1h")
    expect(text(segmentSpans("quota", input({ quotas: [{ ...snapshot, fetchedAt: NOW, windows: [] }] })))).toBe("codex quota unknown")
    expect(text(segmentSpans("quota", input({ quotas: [{ ...snapshot, fetchedAt: NOW, windows: [{ id: "x", label: "5h", usedPercent: 200 }] }] })))).toContain("100%")
  })
  test("state shows the label, a busy dot only while busy, and connection trouble", () => {
    expect(text(segmentSpans("state", input()))).toBe("ready")
    expect(text(segmentSpans("state", input({ state: "generating", stateLabel: "generating" })))).toBe("generating •")
    expect(text(segmentSpans("state", input({ state: "generating", stateLabel: "generating", dotOn: false })))).toBe("generating  ")
    expect(text(segmentSpans("state", input({ connection: "reconnecting" })))).toBe("ready  offline · reconnecting…")
    expect(segmentSpans("state", input({ state: "error", stateLabel: "error" }))[0]).toMatchObject({ fg: "error" })
  })

  test("permission is hidden in ask mode and colored by risk otherwise", () => {
    expect(segmentSpans("permission", input())).toEqual([])
    expect(segmentSpans("permission", input({ permission: "full", permissionLabel: "full access" }))[0]).toMatchObject({ text: "full access", fg: "error", bold: true })
    expect(segmentSpans("permission", input({ permission: "plan", permissionLabel: "plan mode" }))[0]).toMatchObject({ fg: "heading" })
    expect(segmentSpans("permission", input({ permission: "edits", permissionLabel: "auto edits" }))[0]).toMatchObject({ fg: "warning" })
  })

  test("context is a rounded percent of the threshold colored by pressure", () => {
    const at = (tokens: number) => segmentSpans("context", input({ context: { tokens, threshold: 160_000 } }))
    expect(text(at(36_800))).toBe("compact 23%")
    expect(at(36_800)[1]).toMatchObject({ fg: "success" })
    expect(at(95_000)[1]).toMatchObject({ text: "59%", fg: "success" })
    expect(at(96_000)[1]).toMatchObject({ text: "60%", fg: "warning" })
    expect(at(135_000)[1]).toMatchObject({ text: "84%", fg: "warning" })
    expect(at(136_000)[1]).toMatchObject({ text: "85%", fg: "error" })
    expect(text(at(200_000))).toBe("compact 125%")
    expect(segmentSpans("context", input())).toEqual([])
    expect(segmentSpans("context", input({ context: { tokens: 5, threshold: 0 } }))).toEqual([])
  })

  test("model, today, cost, branch and notice render only with data", () => {
    expect(text(segmentSpans("model", full()))).toBe("gpt-6-luna")
    expect(text(segmentSpans("today", full()))).toBe("today 1.2M")
    expect(text(segmentSpans("cost", full()))).toBe("cost $0.42")
    expect(text(segmentSpans("branch", full()))).toBe("git main")
    expect(text(segmentSpans("notice", full()))).toBe("saved")
    for (const id of ["model", "today", "cost", "branch", "notice"] as const) expect(segmentSpans(id, input())).toEqual([])
    expect(segmentSpans("cost", input({ today: { tokens: 5, calls: 1 } }))).toEqual([])
  })

  test("quota shows bars and reset at wide widths and a compact percent at narrow ones", () => {
    expect(text(segmentSpans("quota", input()))).toBe("codex 7d █░░░░░░░ 17% ↺6d".replace("↺", "resets "))
    expect(text(segmentSpans("quota", input({ width: 60 })))).toBe("codex 7d 17%")
    expect(segmentSpans("quota", input({ quotas: [] }))).toEqual([])
    const hot = segmentSpans("quota", input({ quotas: [{ ...(quota as object), windows: [{ id: "x", label: "5h", usedPercent: 95 }] } as never] }))
    expect(hot.find((span) => span.text === " 95%")?.fg).toBe("error")
  })

  test("left view draws what remains, with the two-unit reset a Pi footer shows, and the age of a stale reading beside the number", () => {
    const week = (patch: object = {}) => ({ ...(quota as object), provider: "codex", windows: [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 5 * 86_400_000 + 11 * 3_600_000 }], ...patch }) as never
    const left = { quotaStyle: { view: "left", color: "pressure" } } as const
    expect(text(segmentSpans("quota", input({ quotas: [week()], ...left })))).toBe("codex 7d ███████░ 92% left resets 5d11h")
    expect(text(segmentSpans("quota", input({ quotas: [week()], ...left, width: 60 })))).toBe("codex 7d 92% left")
    const old = week({ fetchedAt: NOW - 3 * 3_600_000, windows: [{ id: "secondary", label: "7d", usedPercent: 2 }] })
    const stale = segmentSpans("quota", input({ quotas: [old], ...left }))
    expect(text(stale)).toBe("codex 7d ████████ 98% left ~3h")
    expect(stale.filter((span) => span.text.includes("█") || span.text.includes("98")).map((span) => span.fg)).toEqual(["muted", "muted"])
  })

  test("a window that already reset is unknown (n/a): its old number means nothing", () => {
    const ended = { ...(quota as object), windows: [{ id: "x", label: "5h", usedPercent: 60, resetsAt: NOW - 1_000 }], fetchedAt: NOW - 60_000 } as never
    expect(text(segmentSpans("quota", input({ quotas: [ended] })))).toBe("codex 5h n/a")
  })

  test("the quota status item is plain text with the same rules: left or used, reset when fresh, age when stale, unknown when nothing arrived", () => {
    const week = { ...(quota as object), provider: "codex", windows: [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 5 * 86_400_000 + 11 * 3_600_000 }] } as never
    const old = { ...(quota as object), provider: "claude", fetchedAt: NOW - 3 * 3_600_000, windows: [{ id: "seven_day", label: "7d", usedPercent: 2 }] } as never
    expect(quotaText({ quotas: [week], now: NOW, view: "left" })).toBe("codex 7d 92% left · resets 5d11h")
    expect(quotaText({ quotas: [week], now: NOW })).toBe("codex 7d 8% used · resets 5d11h")
    expect(quotaText({ quotas: [week, old], now: NOW, view: "left" })).toBe("codex 7d 92% left · resets 5d11h  claude 7d 98% left ~3h")
    expect(quotaText({ quotas: [{ ...(quota as object), windows: [] } as never], now: NOW })).toBe("codex quota unknown")
    expect(quotaText({ quotas: [], now: NOW })).toBeUndefined()
  })

  test("accent colour paints the bar in the theme's primary role while fresh, and pressure stays the default", () => {
    const spans = segmentSpans("quota", input({ quotaStyle: { view: "used", color: "accent" } }))
    expect(spans.find((span) => span.text.includes("█"))?.fg).toBe("primary")
    expect(segmentSpans("quota", input()).find((span) => span.text.includes("█"))?.fg).toBe("success")
  })
})

describe("footer layout", () => {
  test("segments follow the configured order, separated by two spaces", () => {
    const line = text(renderFooter(input({ segments: ["quota", "state"], quotas: [] })))
    expect(line).toBe("ready")
    expect(text(renderFooter(full({ segments: ["branch", "state", "model"], notice: "" })))).toBe("git main  ready  gpt-6-luna")
  })

  test("the default footer reproduces state, permission, context, quota and notice", () => {
    const line = text(renderFooter(full({ segments: DEFAULT_FOOTER })))
    expect(line).toBe("ready  full access  compact 23%  codex 7d █░░░░░░░ 17% resets 6d  saved")
  })

  test("notice always renders even when it is not in the configured list", () => {
    expect(text(renderFooter(input({ segments: ["state"], notice: "heads up" })))).toBe("ready  heads up")
    expect(text(renderFooter(input({ segments: [], notice: "hi" })))).toBe("hi")
  })

  test("duplicate segment ids render once", () => {
    expect(text(renderFooter(input({ segments: ["state", "state", "model"], model: "m" })))).toBe("ready  m")
  })

  test("overflow drops segments from the end of the order, never state or notice", () => {
    const wide = full({ segments: ["state", "permission", "context", "model", "today", "cost", "branch", "quota", "notice"], width: 60 })
    const line = text(renderFooter(wide))
    expect(line).toStartWith("ready  full access  compact 23%")
    expect(line).toEndWith("saved")
    expect(line).not.toContain("codex")
    expect(textWidth(line)).toBeLessThanOrEqual(60)
    const narrower = text(renderFooter({ ...wide, width: 30 }))
    expect(narrower).toStartWith("ready")
    expect(narrower).toEndWith("saved")
  })

  test("the notice truncates last, only when state alone plus the notice still overflow", () => {
    const line = text(renderFooter(input({ segments: ["state", "quota"], width: 20, notice: "a rather long notice text that cannot fit", quotas: [] })))
    expect(line).toStartWith("ready  a rather")
    expect(line).toEndWith("…")
    expect(textWidth(line)).toBe(20)
  })

  test("state never gets dropped and the line is clamped when even it does not fit", () => {
    const line = renderFooter(input({ state: "generating", stateLabel: "generating", connection: "reconnecting", width: 12, notice: "n" }))
    expect(textWidth(text(line))).toBeLessThanOrEqual(12)
    expect(text(line)).toStartWith("generating")
  })

  test("every width keeps the line inside the width with every segment on", () => {
    for (const width of [20, 40, 60, 80, 100, 140]) {
      const line = renderFooter(full({ width, state: "generating", stateLabel: "generating" }))
      expect(textWidth(text(line))).toBeLessThanOrEqual(width)
      expect(text(line)).toStartWith("generating")
    }
  })

  test("80 columns fit state, permission, context and the compact quota", () => {
    const line = text(renderFooter(full({ segments: DEFAULT_FOOTER, width: 80, notice: "" })))
    expect(line).toBe("ready  full access  compact 23%  codex 7d █░░░░░░░ 17% resets 6d")
  })

  test("40 columns keep the important left side", () => {
    const line = text(renderFooter(full({ width: 40, segments: ["state", "permission", "context", "today", "quota", "notice"], notice: "" })))
    expect(line).toBe("ready  full access  compact 23%")
  })
})

describe("/footer command parsing", () => {
  test("is a slash command", () => expect(parseSlash("/footer +branch")?.command.name).toBe("footer"))

  test("empty arguments keep the current list", () => {
    expect(parseFooterCommand("", ["state", "quota"])).toEqual({ ok: true, segments: ["state", "quota"] })
  })

  test("+id appends, -id removes, several can be combined", () => {
    expect(parseFooterCommand("+branch -quota", DEFAULT_FOOTER)).toEqual({ ok: true, segments: ["state", "permission", "context", "notice", "branch"] })
    expect(parseFooterCommand("+today +model", ["state"])).toEqual({ ok: true, segments: ["state", "today", "model"] })
    expect(parseFooterCommand("+state", ["state"])).toEqual({ ok: true, segments: ["state"] })
    expect(parseFooterCommand("-branch", ["state"])).toEqual({ ok: true, segments: ["state"] })
  })

  test("reset restores the default and bare ids set the exact order", () => {
    expect(parseFooterCommand("reset", ["branch"])).toEqual({ ok: true, segments: DEFAULT_FOOTER })
    expect(parseFooterCommand("branch state context", DEFAULT_FOOTER)).toEqual({ ok: true, segments: ["branch", "state", "context"] })
    expect(parseFooterCommand("  RESET  ")).toEqual({ ok: true, segments: DEFAULT_FOOTER })
  })

  test("unknown segments and mixed forms are errors that list the valid ids", () => {
    const unknown = parseFooterCommand("+weather")
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && unknown.error).toContain('unknown footer segment "weather"')
    expect(!unknown.ok && unknown.error).toContain("branch")
    expect(parseFooterCommand("+branch quota")).toEqual({ ok: false, error: "use +quota or -quota" })
  })
})

describe("transcript last usage", () => {
  const sessionId = ids("session")
  let seq = 0
  const ev = (patch: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...patch }) as SessionEvent
  const usage = (patch: Record<string, unknown> = {}) => ev({ type: "usage.recorded", turnId: ids("turn"), provider: "codex", model: "gpt-6-luna", input: 1_000, output: 200, reasoning: 50, cacheRead: 30_000, cacheWrite: 0, ...patch })

  test("keeps the model and the context of the last model call (input + cache read + output)", () => {
    const transcript = createTranscript({ glyphs: glyphs({}) })
    expect(transcript.lastUsage).toBeUndefined()
    transcript.apply(usage())
    expect(transcript.lastUsage).toEqual({ provider: "codex", model: "gpt-6-luna", contextTokens: 31_200, callAt: 0 })
    transcript.apply(usage({ model: "other", input: 5, output: 5, cacheRead: 0 }))
    expect(transcript.lastUsage).toEqual({ provider: "codex", model: "other", contextTokens: 10, callAt: 0 })
  })

  test("a Claude Code turn's summed usage is never read as the context: its own context and window are, and without them there is no figure", () => {
    const transcript = createTranscript({ glyphs: glyphs({}) })
    // The turn's totals: 30 calls of ~150k each.
    const summed = { provider: "claude", model: "claude-opus-4-8", input: 90, output: 40_000, reasoning: 0, cacheRead: 4_400_000, cacheWrite: 160_000 }
    transcript.apply(usage({ ...summed, context: 52_000, contextWindow: 200_000 }))
    expect(transcript.lastUsage).toEqual({ provider: "claude", model: "claude-opus-4-8", contextTokens: 52_000, callAt: 0, contextWindow: 200_000 })
    transcript.apply(usage({ ...summed, context: 200_000, contextWindow: 200_000, contextApprox: true }))
    expect(transcript.lastUsage).toMatchObject({ contextTokens: 200_000, contextApprox: true })
    transcript.apply(usage(summed))
    expect(transcript.lastUsage?.contextTokens).toBeUndefined()
  })

  test("a call's cache writes are part of the context", () => {
    const transcript = createTranscript({ glyphs: glyphs({}) })
    transcript.apply(usage({ input: 10, output: 20, cacheRead: 1_000, cacheWrite: 300 }))
    expect(transcript.lastUsage?.contextTokens).toBe(1_330)
  })

  test("an engine that states its window is measured against it, with the context marked when it was clamped", () => {
    expect(contextLimit({ contextTokens: 5, contextWindow: 200_000 }, 160_000)).toBe(200_000)
    expect(contextLimit({ contextTokens: 5 }, 160_000)).toBe(160_000)
    // The engine says where it will pack (95% of a 500k window): that, not the 160k default, is what the meter divides by.
    expect(contextLimit({ contextTokens: 5, compactAt: 475_000 }, 160_000)).toBe(475_000)
    expect(contextLimit({ contextTokens: 5, compactAt: 475_000, contextWindow: 200_000 }, 160_000)).toBe(200_000)
    expect(text(contextBar({ tokens: 200_000, limit: 200_000, approx: true }, true))).toContain("~200K / 200K")
    expect(text(contextBar({ tokens: 200_000, limit: 200_000, approx: true }, false, "percent"))).toBe("~>99%")
    expect(text(statusLineSpans({ stateLabel: "ready", state: "idle", contextPercent: 100, contextLabel: "ctx", contextApprox: true, glyphs: glyphs({}) }, 80))).toContain("ctx ~100%")
  })

  test("a finished compaction clears the stale context but keeps the model", () => {
    const transcript = createTranscript({ glyphs: glyphs({}) })
    transcript.apply(usage())
    const itemId = ids("item")
    transcript.apply(ev({ type: "item.started", turnId: ids("turn"), itemId, kind: "compaction" }))
    transcript.apply(ev({ type: "item.completed", itemId, status: "ok", text: "summary" }))
    expect(transcript.lastUsage).toEqual({ provider: "codex", model: "gpt-6-luna", contextTokens: undefined, callAt: 0 })
  })

  test("an unfinished or failed compaction keeps the last known context", () => {
    const transcript = createTranscript({ glyphs: glyphs({}) })
    transcript.apply(usage())
    const itemId = ids("item")
    transcript.apply(ev({ type: "item.started", turnId: ids("turn"), itemId, kind: "compaction" }))
    transcript.apply(ev({ type: "item.completed", itemId, status: "error", text: "" }))
    expect(transcript.lastUsage?.contextTokens).toBe(31_200)
  })
})

describe("footer in the app", () => {
  function harness(settings: Record<string, unknown> = {}) {
    const frames: Line[][] = []
    const sent: Array<Record<string, unknown>> = []
    const screen = { size: { width: 100, height: 12 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const sessionId = ids("session")
    const app = createApp({
      // Balanced shows only v1's row under the prompt; the footer segments are the full view's addition.
      sessionId, screen, directory: "/work/app", exit() {}, schedule: (fn: () => void) => fn(), glyphs: glyphs({}), now: () => NOW, mode: "full",
      send: async (command: Record<string, unknown>) => {
        sent.push(command)
        if (command.type === "git.branch") return { ok: true, result: { branch: "feature/x" } }
        return { ok: true }
      },
    } as never)
    app.applySettings({ footer: [...DEFAULT_FOOTER], ...settings } as never)
    let seq = 0
    const ev = (patch: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...patch }) as SessionEvent
    const footer = () => frames.at(-1)!.at(-1)!.map((s) => s.text).join("").trim()
    const topbar = () => text(frames.at(-1)![0]!)
    const chat = () => {
      const itemId = ids("item")
      app.onEvent(ev({ type: "item.started", turnId: ids("turn"), itemId, kind: "user_message" }))
      app.onEvent(ev({ type: "item.completed", itemId, status: "ok", text: "Hello" }))
    }
    /** The whole last frame: a command's report shows in the notice slot over the prompt, not in the footer. */
    const whole = () => { app.render(); return frames.at(-1)!.map((row) => row.map((s) => s.text).join("")).join("\n") }
    return { app, sent, footer, screen: whole, topbar, chat, ev, tick: () => Bun.sleep(5) }
  }

  test("the footer shows the agent and model, with context only in the topbar", () => {
    const { app, footer, topbar, chat, ev } = harness()
    app.render()
    expect(footer()).toBe("Build")
    chat()
    app.onEvent(ev({ type: "usage.recorded", turnId: ids("turn"), provider: "p", model: "m", input: 16_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
    expect(footer()).toBe("Build · m · p")
    expect(topbar()).toContain("10%")
  })

  test("the threshold comes from the compactAtTokens setting", () => {
    const { app, footer, topbar, chat, ev } = harness({ compactAtTokens: 32_000 })
    chat()
    app.onEvent(ev({ type: "usage.recorded", turnId: ids("turn"), provider: "p", model: "m", input: 16_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
    expect(footer()).toBe("Build · m · p")
    expect(topbar()).toContain("50%")
  })

  test("a Claude Code session is measured against the window its usage states, never the catalog's figure", () => {
    const { app, topbar, chat, ev } = harness()
    app.render()
    // Before the first answer there is no context figure at all, so no catalog window (200K for every Claude model) can show.
    expect(topbar()).not.toMatch(/\d%/)
    chat()
    // Measured with Claude Code 2.1.296 on claude-haiku-5-5: a 38,613-token call, window 1,000,000.
    app.onEvent(ev({ type: "usage.recorded", turnId: ids("turn"), provider: "claude", model: "claude-haiku-5-5", input: 2, output: 184, reasoning: 97, cacheRead: 10_959, cacheWrite: 27_468, context: 38_613, contextWindow: 1_000_000 }))
    expect(topbar()).toContain("4%")
    expect(topbar()).not.toContain("19%")
  })

  test("usage.today pushes update the today and cost segments", () => {
    const { app, footer } = harness({ footer: ["state", "today", "cost"] })
    app.onGlobal({ type: "usage.today", gseq: 0, at: NOW, day: "2026-09-26", tokens: 1_234_567, calls: 3, costMicros: 420_000 } as never)
    expect(footer()).toMatch(/^Build +today 1.2M  cost \$0.42$/)
    app.onGlobal({ type: "usage.today", gseq: 0, at: NOW, day: "2026-09-26", tokens: 2_000_000, calls: 4 } as never)
    expect(footer()).toMatch(/^Build +today 2M$/)
  })

  test("the model segment follows the last usage event", () => {
    const { app, footer, ev } = harness({ footer: ["state", "model"] })
    app.onEvent(ev({ type: "usage.recorded", turnId: ids("turn"), provider: "p", model: "gpt-6-luna", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
    expect(footer()).toBe("Build · GPT-6-Luna · p")
  })

  test("the branch is fetched when the segment is on, and again after each turn ends — not otherwise", async () => {
    const off = harness()
    await off.tick()
    expect(off.sent.some((c) => c.type === "git.branch")).toBe(false)
    const { app, sent, footer, ev, tick } = harness({ footer: ["state", "branch"] })
    await tick()
    expect(sent.filter((c) => c.type === "git.branch")).toEqual([{ type: "git.branch", directory: "/work/app" }])
    expect(footer()).toMatch(/^Build +git feature\/x$/)
    const turnId = ids("turn")
    app.onEvent(ev({ type: "turn.completed", turnId }))
    await tick()
    expect(sent.filter((c) => c.type === "git.branch").length).toBe(2)
  })

  test("/footer toggles segments, saves them and shows the list in the notice", async () => {
    const { app, sent, footer, screen, tick } = harness()
    for (const key of "/footer +branch -quota") await app.onKey(key)
    await app.onKey("\r")
    await tick()
    const saved = sent.find((c) => c.type === "settings.set") as { patch: { footer: string[] } }
    expect(saved.patch.footer).toEqual(["state", "permission", "context", "notice", "branch"])
    expect(screen()).toContain("footer: state permission context notice branch")
    expect(footer()).not.toContain("footer:")
  })

  test("/footer with an unknown segment reports an error and saves nothing", async () => {
    const { app, sent, screen } = harness()
    for (const key of "/footer +weather") await app.onKey(key)
    await app.onKey("\r")
    expect(sent.some((c) => c.type === "settings.set")).toBe(false)
    expect(screen()).toContain('unknown footer segment "weather"')
  })

  test("/footer with no arguments only shows the current list", async () => {
    const { app, sent, screen } = harness({ footer: ["state", "model"] })
    for (const key of "/footer") await app.onKey(key)
    await app.onKey("\r")
    expect(sent.some((c) => c.type === "settings.set")).toBe(false)
    expect(screen()).toContain("footer: state model")
  })

  test("a persisted legacy footer setting cannot duplicate the topbar context", () => {
    const { app, footer, ev } = harness({ footer: ["context", "state"] })
    app.onEvent(ev({ type: "usage.recorded", turnId: ids("turn"), provider: "p", model: "m", input: 16_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
    expect(footer()).toBe("Build · m · p")
  })
})
