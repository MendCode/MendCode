import { describe, expect, test } from "bun:test"
import { createIdFactory, FOOTER_SEGMENTS, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { renderFooter, segmentSpans, type FooterInput } from "../src/view/footer"
import { terminalTitle, titleActivityLabel } from "../src/view/terminal-title"
import { createThresholds } from "../src/view/threshold-notices"
import { cacheHitPercent, createUsageNotes } from "../src/view/usage-notes"
import { createTranscript } from "../src/view/transcript"
import { renderWorkingRow, STALL_AFTER_MS, stalledFor } from "../src/view/working-row"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const text = (line: Line) => line.map((span) => span.text).join("")
const sessionId = ids("session")
const turnId = ids("turn")
let seq = 0
const ev = (patch: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: NOW, ...patch }) as SessionEvent
const usage = (patch: Record<string, unknown> = {}) => ev({ type: "usage.recorded", turnId, provider: "anthropic", model: "claude", input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...patch })
const compaction = (state: string, patch: Record<string, unknown> = {}) => ev({ type: "compaction.updated", turnId, reason: "auto", state, followUp: "", ...patch })

function footerInput(patch: Partial<FooterInput> = {}): FooterInput {
  return { segments: FOOTER_SEGMENTS, width: 160, glyphs: glyphs({}), stateLabel: "ready", state: "idle", dotOn: true, connection: "connected", permission: "ask", permissionLabel: "ask", quotas: [], now: NOW, notice: "", ...patch }
}

describe("footer segments: cache, tokens, effort, jobs, sandbox, vim, update", () => {
  const totals = { calls: 3, input: 1_000, output: 2_400, reasoning: 100, cacheRead: 9_000, cacheWrite: 500 }

  test("cache is the share of prompt tokens read from the cache, colored by how healthy it is", () => {
    expect(cacheHitPercent(totals)).toBe(86)
    expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
    expect(text(segmentSpans("cache", footerInput({ usage: totals })))).toBe("cache 86%")
    expect(segmentSpans("cache", footerInput({ usage: totals }))[1]).toMatchObject({ fg: "success" })
    expect(segmentSpans("cache", footerInput({ usage: { ...totals, cacheRead: 100 } }))[1]).toMatchObject({ fg: "warning" })
    expect(segmentSpans("cache", footerInput())).toEqual([])
  })

  test("tokens shows prompt, output and the cache counters that are not zero", () => {
    expect(text(segmentSpans("tokens", footerInput({ usage: totals })))).toBe("in 10.5K out 2,500 cr 9,000 cw 500")
    expect(text(segmentSpans("tokens", footerInput({ usage: { ...totals, cacheRead: 0, cacheWrite: 0 } })))).toBe("in 1,000 out 2,500")
    expect(segmentSpans("tokens", footerInput({ usage: { ...totals, calls: 0 } }))).toEqual([])
  })

  test("effort, jobs, sandbox, vim and update render only with data", () => {
    expect(text(segmentSpans("effort", footerInput({ effort: "high" })))).toBe("effort high")
    expect(segmentSpans("effort", footerInput())).toEqual([])
    expect(text(segmentSpans("jobs", footerInput({ jobs: 1 })))).toBe("1 job")
    expect(text(segmentSpans("jobs", footerInput({ jobs: 3 })))).toBe("3 jobs")
    expect(segmentSpans("jobs", footerInput({ jobs: 0 }))).toEqual([])
    expect(text(segmentSpans("sandbox", footerInput({ sandbox: "read-only" })))).toBe("sandbox read-only")
    expect(segmentSpans("sandbox", footerInput({ sandbox: "off" }))[1]).toMatchObject({ fg: "warning" })
    expect(text(segmentSpans("vim", footerInput({ vim: "-- NORMAL --" })))).toBe("-- NORMAL --")
    expect(text(segmentSpans("update", footerInput({ update: "update 1.4.0" })))).toBe("update 1.4.0")
  })

  test("they take part in the order and drop from the end when the footer is narrow", () => {
    const wide = text(renderFooter(footerInput({ segments: ["state", "effort", "cache", "jobs"], effort: "low", usage: totals, jobs: 2 })))
    expect(wide).toBe("ready  effort low  cache 86%  2 jobs")
    expect(text(renderFooter(footerInput({ segments: ["state", "effort", "cache", "jobs"], effort: "low", usage: totals, jobs: 2, width: 22 })))).toBe("ready  effort low")
  })
})

describe("usage notes", () => {
  test("totals and the hit rate fold every usage event", () => {
    const notes = createUsageNotes()
    notes.apply(usage({ input: 100, cacheRead: 0, cacheWrite: 4_000 }))
    notes.apply(usage({ input: 50, cacheRead: 4_000, cacheWrite: 200, output: 10 }))
    expect(notes.totals).toEqual({ calls: 2, input: 150, output: 60, reasoning: 0, cacheRead: 4_000, cacheWrite: 4_200 })
  })

  test("a call that reads almost nothing after one that cached is a miss, with the reason", () => {
    const notes = createUsageNotes()
    notes.apply(usage({ at: NOW, input: 100, cacheWrite: 6_000 }))
    expect(notes.apply(usage({ at: NOW + 20_000, input: 200, cacheRead: 0, cacheWrite: 6_000 }))[0]).toEqual({ kind: "cache", text: "cache miss · 0% of 6,200 prompt tokens read from cache · prompt prefix changed" })
    expect(notes.apply(usage({ at: NOW + 20_000 + 9 * 60_000, input: 400, cacheRead: 0, cacheWrite: 6_000 }))[0]!.text).toContain("idle 9m, past the cache lifetime")
  })

  test("healthy reads, small prompts, a first call, a model switch and the call after a compaction are not misses", () => {
    const notes = createUsageNotes()
    expect(notes.apply(usage({ input: 100, cacheWrite: 6_000 }))).toEqual([])
    expect(notes.apply(usage({ input: 100, cacheRead: 6_000, cacheWrite: 300 }))).toEqual([])
    expect(notes.apply(usage({ input: 500, cacheRead: 0 }))).toEqual([])
    expect(notes.apply(usage({ model: "other", input: 7_000, cacheRead: 0 }))).toEqual([])
    notes.apply(usage({ model: "other", input: 100, cacheWrite: 6_000 }))
    notes.apply(compaction("packed"))
    expect(notes.apply(usage({ model: "other", input: 7_000, cacheRead: 0 }))).toEqual([])
  })

  test("a call that dropped thinking is noted once per turn", () => {
    const notes = createUsageNotes()
    expect(notes.apply(usage({ thinkingDropped: true }))[0]).toMatchObject({ kind: "thinking" })
    expect(notes.apply(usage({ thinkingDropped: true }))).toEqual([])
    expect(notes.apply(usage({ turnId: ids("turn"), thinkingDropped: true }))).toHaveLength(1)
  })

  test("a compaction reports what its own model calls cost and the context it replaced", () => {
    const notes = createUsageNotes()
    notes.apply(usage({ input: 90_000, cacheRead: 40_000, output: 2_000 }))
    notes.apply(compaction("writing"))
    expect(notes.apply(usage({ input: 20_000, output: 3_000 }), true)).toEqual([])
    expect(notes.apply(compaction("packed"))).toEqual([{ kind: "compaction", text: "compaction used 20K in, 3,000 out · context was 132K" }])
    notes.apply(compaction("writing"))
    expect(notes.apply(compaction("failed"))).toEqual([])
  })

  test("the transcript draws the notes only while cacheNotices is on", () => {
    const transcript = createTranscript({ glyphs: glyphs({}), appearance: { cacheNotices: false } })
    for (const event of [usage({ at: NOW, input: 100, cacheWrite: 6_000 }), usage({ at: NOW + 1_000, input: 6_200, cacheRead: 0 })]) transcript.apply(event)
    const lines = () => transcript.viewport(100, 50).map((line) => line.text).join("\n")
    expect(lines()).not.toContain("cache miss")
    transcript.setAppearance({ cacheNotices: true, reasoning: "auto", toolOutput: "auto" })
    expect(lines()).toContain("cache miss")
    expect(transcript.sessionUsage.calls).toBe(2)
    expect(transcript.lastCall?.input).toBe(6_200)
  })
})

describe("terminal title", () => {
  const base = { template: "{product} | {session}", product: "MendCode", session: "Fix login", route: "chat", path: "/work/app", state: "idle" as const, activity: true }

  test("keeps the four original tokens and trims a separator an empty token leaves", () => {
    expect(terminalTitle(base)).toBe("MendCode | Fix login")
    expect(terminalTitle({ ...base, session: "" })).toBe("MendCode")
    expect(terminalTitle({ ...base, template: "{product} · {route} · {path}" })).toBe("MendCode · chat · /work/app")
  })

  test("leads with the activity while the agent works or waits, never when idle", () => {
    expect(titleActivityLabel("generating")).toBe("working")
    expect(titleActivityLabel("tool")).toBe("working")
    expect(titleActivityLabel("waiting_approval")).toBe("needs input")
    expect(titleActivityLabel("idle")).toBe("")
    expect(terminalTitle({ ...base, state: "generating" })).toBe("working · MendCode | Fix login")
    expect(terminalTitle({ ...base, state: "waiting_approval" })).toBe("needs input · MendCode | Fix login")
    expect(terminalTitle({ ...base, state: "waiting_approval", activity: false })).toBe("MendCode | Fix login")
  })

  test("new tokens: dir, activity, model and branch; a template with its own activity is not prefixed", () => {
    const template = "{dir} {branch} {model} [{activity}]"
    expect(terminalTitle({ ...base, template, model: "opus", branch: "main", state: "generating" })).toBe("app main opus [working]")
    expect(terminalTitle({ ...base, template, state: "idle" })).toBe("app   []")
  })
})

describe("threshold notices", () => {
  const quota = (usedPercent: number, patch: Record<string, unknown> = {}) => ({ type: "quota.snapshot", gseq: 1, at: NOW, provider: "codex", windows: [{ id: "5h", label: "5h", usedPercent, resetsAt: NOW + 2 * 3_600_000 + 20 * 60_000 }], fetchedAt: NOW, source: "t", ...patch }) as never

  test("quota windows announce at 75 and 90 percent once each, and the limit with what to do", () => {
    const thresholds = createThresholds()
    expect(thresholds.quota(quota(40), NOW)).toEqual([])
    expect(thresholds.quota(quota(76), NOW)).toEqual([{ tone: "info", text: "codex 5h 76% used · resets in 2h 20m" }])
    expect(thresholds.quota(quota(80), NOW)).toEqual([])
    expect(thresholds.quota(quota(91), NOW)).toEqual([{ tone: "warning", text: "codex 5h 91% used · resets in 2h 20m" }])
    expect(thresholds.quota(quota(100), NOW)).toEqual([{ tone: "error", text: "codex 5h limit reached · resets in 2h 20m · /model to switch · /usage for details" }])
    expect(thresholds.quota(quota(100), NOW)).toEqual([])
  })

  test("a rejected status at 90 percent or more counts as the limit; a reset window announces again", () => {
    const thresholds = createThresholds()
    expect(thresholds.quota(quota(95, { status: "rejected" }), NOW)[0]).toMatchObject({ tone: "error" })
    expect(thresholds.quota(quota(10), NOW)).toEqual([])
    expect(thresholds.quota(quota(80), NOW)).toHaveLength(1)
  })

  test("the first snapshot above a threshold announces it, and windows of other providers do not interfere", () => {
    const thresholds = createThresholds()
    expect(thresholds.quota(quota(92), NOW)).toHaveLength(1)
    expect(thresholds.quota(quota(50, { provider: "other" }), NOW)).toEqual([])
    expect(thresholds.quota(quota(92), NOW)).toEqual([])
  })

})

describe("stalled indicator", () => {
  test("only a generating model with no tool running and a long silence counts", () => {
    const at = NOW - STALL_AFTER_MS
    expect(stalledFor({ state: "generating", lastEventAt: at, now: NOW })).toBe(STALL_AFTER_MS)
    expect(stalledFor({ state: "generating", lastEventAt: at + 1, now: NOW })).toBeUndefined()
    expect(stalledFor({ state: "generating", current: { kind: "reasoning" }, lastEventAt: at, now: NOW })).toBe(STALL_AFTER_MS)
    expect(stalledFor({ state: "generating", current: { kind: "tool_call", tool: "shell" }, lastEventAt: at, now: NOW })).toBeUndefined()
    expect(stalledFor({ state: "tool", lastEventAt: at, now: NOW })).toBeUndefined()
    expect(stalledFor({ state: "waiting_approval", lastEventAt: at, now: NOW })).toBeUndefined()
    expect(stalledFor({ state: "generating", lastEventAt: at, now: NOW, retrying: true })).toBeUndefined()
    expect(stalledFor({ state: "generating", now: NOW })).toBeUndefined()
    expect(stalledFor({ state: "generating", lastEventAt: NOW - 10_000, now: NOW, after: 5_000 })).toBe(10_000)
  })

  test("the working row says how long it has been silent and warns on the spinner", () => {
    const row = renderWorkingRow({ width: 100, margin: 2, spinner: "*", phase: "Generating...", elapsedMs: 90_000, now: NOW, stalledMs: 62_000 })
    expect(text(row)).toBe("  * Generating...  1m 30s  no response for 1m 2s")
    expect(row.find((span) => span.text === "* ")).toMatchObject({ fg: "warning" })
    expect(text(renderWorkingRow({ width: 100, margin: 2, spinner: "*", phase: "Generating...", elapsedMs: 90_000, now: NOW }))).toBe("  * Generating...  1m 30s")
  })
})

describe("status surface in the app", () => {
  function harness(settings: Record<string, unknown> = {}, profile: Record<string, unknown> = {}, reply: (command: { type: string }) => unknown = () => ({ ok: true }), extra: Record<string, unknown> = {}) {
    const frames: Line[][] = []
    const titles: string[] = []
    let clock = NOW
    const screen = { size: { width: 160, height: 20 }, draw: (rows: Line[]) => void frames.push(rows), setTitle: (title: string) => void titles.push(title) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const id = ids("session")
    const app = createApp({
      sessionId: id, screen, directory: "/work/app", exit() {}, schedule: (fn: () => void) => fn(), glyphs: glyphs({}), now: () => clock, mode: "full",
      send: async (command: { type: string }) => reply(command),
      ...extra,
    } as never)
    app.applySettings({ footer: ["state", "cache", "tokens", "effort", "sandbox"], sandbox: { mode: "read-only" }, ...settings } as never)
    if (Object.keys(profile).length) app.onGlobal({ type: "tui.changed", gseq: 1, at: NOW, profile } as never)
    let n = 0
    const event = (patch: Record<string, unknown>) => ({ sessionId: id, seq: ++n, at: NOW, ...patch }) as SessionEvent
    const all = () => frames.at(-1)!.map((row) => text(row)).join("\n")
    return { app, titles, event, all, frame: () => frames.at(-1)!, advance: (ms: number) => { clock += ms }, id }
  }

  test("the opt-in footer segments show the session's cache, tokens, effort and sandbox", () => {
    const { app, event, all } = harness()
    const turn = ids("turn")
    app.onEvent(event({ type: "usage.recorded", turnId: turn, provider: "p", model: "m", input: 1_000, output: 400, reasoning: 0, cacheRead: 9_000, cacheWrite: 0 }))
    app.render()
    expect(all()).toContain("cache 90%")
    expect(all()).toContain("in 10K out 400 cr 9,000")
    expect(all()).toContain("sandbox read-only")
  })

  test("the window title leads with the activity while a turn runs and drops it when idle", () => {
    const { app, event, titles } = harness()
    app.render()
    expect(titles.at(-1)).toBe("MendCode")
    app.onEvent(event({ type: "foreground.state", state: "generating" }))
    app.render()
    expect(titles.at(-1)).toBe("working · MendCode")
    app.onEvent(event({ type: "foreground.state", state: "waiting_approval" }))
    app.render()
    expect(titles.at(-1)).toBe("needs input · MendCode")
    app.onEvent(event({ type: "foreground.state", state: "idle" }))
    app.render()
    expect(titles.at(-1)).toBe("MendCode")
  })

  test("a quiet generating turn shows the stalled hint, and an event clears it", () => {
    const { app, event, all, advance } = harness()
    app.onEvent(event({ type: "turn.started", turnId: ids("turn") }))
    app.onEvent(event({ type: "foreground.state", state: "generating" }))
    app.render()
    expect(all()).not.toContain("no response")
    advance(STALL_AFTER_MS + 5_000)
    app.render()
    expect(all()).toContain("no response for 50s")
    app.onEvent(event({ type: "item.started", turnId: ids("turn"), itemId: ids("item"), kind: "agent_message" }))
    app.render()
    expect(all()).not.toContain("no response")
  })

  test("a quiet turn whose session runs a background agent says what it waits on, never no response", async () => {
    let id = ""
    const { app, event, all, advance, id: sessionId } = harness({}, {}, (command) => command.type === "background.list" ? { ok: true, result: { tasks: [{ id: "t1", sessionId: id, command: "T3 engine spike (resume)", kind: "agent", startedAt: NOW, status: "running" }] } } : { ok: true })
    id = sessionId
    app.onEvent(event({ type: "turn.started", turnId: ids("turn") }))
    app.onEvent(event({ type: "foreground.state", state: "generating" }))
    app.onGlobal({ type: "session.background.changed", gseq: 2, at: NOW, sessionId } as never)
    await Bun.sleep(5)
    advance(STALL_AFTER_MS + 5_000)
    app.render()
    expect(all()).not.toContain("no response")
    expect(all()).toContain("Waiting on T3 engine spike (resume)...")
  })

  test("an engine's background agent joins the agents strip in its own colour, like any sub-agent; a background command stays a plain row", async () => {
    let id = ""
    const tasks = [
      { id: "t1", command: "Studio hub, shell and settings", kind: "agent", startedAt: NOW, status: "running" },
      { id: "t2", command: "bun test --watch", kind: "command", startedAt: NOW, status: "running" },
    ]
    const { app, event, advance, frame, all, id: sessionId } = harness({}, {}, (command) => command.type === "background.list" ? { ok: true, result: { tasks: tasks.map((task) => ({ ...task, sessionId: id })) } } : { ok: true })
    id = sessionId
    app.onEvent(event({ type: "turn.started", turnId: ids("turn") }))
    app.onEvent(event({ type: "foreground.state", state: "generating" }))
    app.onGlobal({ type: "session.background.changed", gseq: 2, at: NOW, sessionId } as never)
    await Bun.sleep(5)
    advance(1_000)
    app.render()
    // One tree under the working line: the agent as a sub-agent row, the command as a row of the same tree.
    expect(all()).toMatch(/├ Studio hub, shell and settings +bg/)
    const span = (needle: string) => frame().flat().find((each) => each.text.includes(needle))
    expect(span("Studio hub, shell and settings")?.fg).not.toBe("muted")
    expect(span("bun test --watch")?.fg).toBe("body")
  })

  test("the multiplexer's pane gets the same children as the strip: a daemon task with its model and engine, and an engine's background agent", async () => {
    let id = ""
    const reports: Array<{ children: Array<Record<string, unknown>> }> = []
    const child = { taskId: "ses_child", parentId: "", rootId: "", depth: 1, generation: 1, description: "Validate the branch", agent: "general", background: true, state: "running", result: "", createdAt: NOW, updatedAt: NOW, run: { model: "claude-sonnet-5-5", engine: "claude" } }
    const { app, event, id: sessionId } = harness({}, {}, (command) => command.type === "task.list" ? { ok: true, result: { tasks: [{ ...child, parentId: id, rootId: id }] } } : command.type === "background.list" ? { ok: true, result: { tasks: [{ id: "t1", sessionId: id, command: "Studio hub, shell and settings", kind: "agent", startedAt: NOW, status: "running" }, { id: "t2", sessionId: id, command: "bun test --watch", kind: "command", startedAt: NOW, status: "running" }] } } : { ok: true }, { paneState: (report: { children: Array<Record<string, unknown>> }) => void reports.push(report) })
    id = sessionId
    app.onEvent(event({ type: "turn.started", turnId: ids("turn") }))
    app.onGlobal({ type: "session.background.changed", gseq: 2, at: NOW, sessionId } as never)
    app.onGlobal({ type: "task.changed", gseq: 3, at: NOW, sessionId: "ses_child", parentId: sessionId } as never)
    await Bun.sleep(5)
    app.render()
    const children = reports.at(-1)!.children
    expect(children.map((entry) => [entry.id, entry.state, entry.description])).toEqual([["ses_child", "running", "Validate the branch"], ["t1", "running", "Studio hub, shell and settings"]])
    expect(String(children[0]!.type)).toMatch(/^general · .+ · claude$/)
    expect(children[1]!.type).toBe("agent")
  })

  test("a quota threshold raises one toast with usageNotices on; by default only a reached limit is said", () => {
    const quota = (usedPercent: number) => ({ type: "quota.snapshot", gseq: 1, at: NOW, provider: "codex", windows: [{ id: "5h", label: "5h", usedPercent }], fetchedAt: NOW, source: "t" }) as never
    const on = harness({ compactAtTokens: 100_000 }, { usageNotices: true })
    on.app.onGlobal(quota(92))
    on.app.render()
    expect(on.all()).toContain("codex 5h 92% used")
    const off = harness({ compactAtTokens: 100_000 })
    off.app.onGlobal(quota(92))
    off.app.render()
    expect(off.all()).not.toContain("codex 5h 92% used")
    off.app.onGlobal(quota(100))
    off.app.render()
    expect(off.all()).toContain("codex 5h limit reached")
  })
})
