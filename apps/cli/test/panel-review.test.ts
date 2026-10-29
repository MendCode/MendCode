import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, conversation, ids, NOW } from "./session-ui-harness"
import { reviewFixture } from "./panel-review-fixture"
import { switchSessionLook } from "../src/ui/app/session-look"
import { updateSidebar } from "../../../packages/daemon/src/sidebar"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { PANEL_PRESETS, SIDEBAR_PRESETS, nextPreset, presetOf } from "../src/view/sidebar-spec"
import { agentCard, contextCard, observedAge, todosCard, workspaceCard } from "../src/view/sidebar-cards"
import { orbitAge, orbitDetails, orbitRecent, renderOrbit, stepOrbitEvent, type OrbitGraph } from "../src/view/panel-orbit"
import { glyphs } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

afterAll(cleanTemps)
const g = glyphs({})
const barCells = (width: number) => (width >= 150 ? 56 : 48)
/** The right bar of a frame: its last cells on every row. */
const bar = (rows: string[], width: number) => rows.map((row) => [...row].slice(-barCells(width)).join(""))
const barText = (h: { text(): string[] }, width: number) => bar(h.text(), width).join("\n")
const headerOf = (h: { text(): string[] }) => h.text().map((row) => /(\w+) · \/panel/.exec(row)?.[1]).find(Boolean)
const settle = () => Bun.sleep(15)

describe("preset identity and cycle", () => {
  test("a spec equal to a preset shows that name whatever its option order, priorities or storage; only an edited list is custom", () => {
    for (const preset of PANEL_PRESETS) {
      const reordered = SIDEBAR_PRESETS[preset].map((widget) => ({ options: { ...widget.options }, type: widget.type }))
      const bare = SIDEBAR_PRESETS[preset].map((widget) => ({ type: widget.type, options: {} }))
      expect(presetOf(reordered)).toBe(preset)
      expect(presetOf(bare)).toBe(preset)
    }
    expect(presetOf([])).toBe("custom")
    expect(presetOf([...SIDEBAR_PRESETS.crew, { type: "clock", options: {} }])).toBe("custom")
    expect(presetOf(SIDEBAR_PRESETS.crew.slice().reverse())).toBe("custom")
    expect(presetOf(SIDEBAR_PRESETS.focus.map((widget) => (widget.type === "todos" ? { ...widget, title: "Mine" } : widget)))).toBe("custom")
    expect(presetOf(SIDEBAR_PRESETS.focus.map((widget) => (widget.type === "todos" ? { ...widget, options: { maxRows: 3 } } : widget)))).toBe("custom")
  })

  test("next steps through the available presets from every starting state and wraps", () => {
    const full = [...PANEL_PRESETS]
    const balanced = PANEL_PRESETS.filter((preset) => preset !== "galaxy")
    for (const [at, preset] of full.entries()) expect(nextPreset(preset, full)).toBe(full[(at + 1) % full.length]!)
    expect(nextPreset("custom", full)).toBe("pulse")
    expect(nextPreset("full", balanced)).toBe("pulse")
    expect(nextPreset("galaxy", balanced)).toBe("pulse")
    expect(nextPreset("focus", balanced)).toBe("full")
    expect(nextPreset("pulse", ["galaxy"])).toBe("galaxy")
  })

  test("cards added after the galaxy are drawn under its Focus, Recent and Top instead of replacing them", async () => {
    const h = reviewFixture({ session: "active", width: 200, height: 62, widgets: [{ type: "orbit", options: {} }, { type: "tokens", options: {} }] as never, rightSidebar: true })
    await Bun.sleep(80)
    h.app.render()
    const titles = h.text().map((row) => /─ (Galaxy|Focus|Recent|Top|Tokens) ─/.exec(row)?.[1]).filter(Boolean)
    expect(titles).toEqual(["Galaxy", "Focus", "Recent", "Top", "Tokens"])
  })

  test("in the app next walks the whole cycle twice from an empty spec and from a custom one", async () => {
    for (const widgets of [[], [{ type: "clock", options: {} }]]) {
      const h = reviewFixture({ session: "active", widgets: widgets as never, rightSidebar: widgets.length > 0 })
      const seen: string[] = []
      for (let step = 0; step < 12; step++) {
        await h.type("/panel next\r")
        seen.push(presetOf(h.app.accessibility.profile.sidebarWidgets))
        expect(headerOf(h)).toBe(seen.at(-1))
      }
      expect(seen).toEqual([...PANEL_PRESETS, ...PANEL_PRESETS])
    }
  })

  test("a stored spec that equals a preset in different clothes still headlines that preset", async () => {
    const stored = SIDEBAR_PRESETS.crew.map((widget) => ({ type: widget.type, options: {} }))
    const h = reviewFixture({ session: "active", widgets: stored as never, rightSidebar: true })
    await settle()
    h.app.render()
    expect(headerOf(h)).toBe("crew")
    const edited = reviewFixture({ session: "active", widgets: [{ type: "agent", options: {} }, { type: "context", options: {} }] as never, rightSidebar: true })
    await settle()
    edited.app.render()
    expect(headerOf(edited)).toBe("custom")
    await edited.type("/panel next\r")
    expect(headerOf(edited)).toBe("pulse")
  })
})

describe("the notice of a chosen preset", () => {
  test("counts its cards in the singular for one", async () => {
    const h = reviewFixture({ session: "active", preset: "ledger" })
    await settle()
    await h.type("/panel galaxy\r")
    expect(h.text().join("\n")).toContain("panel: galaxy (1 card)")
    await h.type("/panel crew\r")
    expect(h.text().join("\n")).toContain(`panel: crew (${SIDEBAR_PRESETS.crew.length} cards)`)
  })
})

describe("refusals", () => {
  test("balanced says galaxy needs the full tier, offers the nearest preset and keeps the previous one", async () => {
    const h = reviewFixture({ session: "active", tier: "balanced", preset: "ledger" })
    await settle()
    await h.type("/panel galaxy\r")
    const screen = h.text().join("\n")
    expect(screen).toContain("Galaxy needs full tier")
    expect(screen).toContain("/tier full")
    expect(screen).toContain("/panel crew")
    expect(presetOf(readTuiProfile(h.dataDir).sidebarWidgets)).toBe("ledger")
    expect(headerOf(h)).toBe("ledger")
    expect(h.sentOf("sidebar.update")).toHaveLength(0)
  })

  test("minimalist refuses every verb that would show the panel, once, and lets hide through silently", async () => {
    const h = reviewFixture({ session: "active", tier: "minimalist", widgets: structuredClone(SIDEBAR_PRESETS.crew) as never, rightSidebar: false })
    for (const command of ["/panel", "/panel next", "/panel focus", "/sidebar preset crew", "/panel edit", "/sidebar right"]) {
      await h.type(`${command}\r`)
      expect(h.text().join("\n"), command).toContain("presets need the balanced or full view")
      expect(readTuiProfile(h.dataDir).rightSidebar, command).toBe(false)
      expect(h.sentOf("sidebar.update"), command).toHaveLength(0)
      expect(h.app.page, command).toBe("chat")
    }
    h.app.render()
    expect(h.text().join("\n")).not.toMatch(/ · \/panel/)
    await h.type("/panel off\r")
    expect(h.text().join("\n")).not.toContain("Use /panel to start")
    expect(presetOf(readTuiProfile(h.dataDir).sidebarWidgets)).toBe("crew")
  })

  test("a preset needs no write: with a daemon that refuses writes it still shows, and the stored spec keeps the old one", async () => {
    const h = reviewFixture({ session: "active", preset: "focus", staleSchema: true })
    await settle()
    await h.type("/panel crew\r")
    expect(headerOf(h)).toBe("crew")
    expect(presetOf(readTuiProfile(h.dataDir).sidebarWidgets)).toBe("focus")
    await h.type("/panel edit\r")
    await h.type("d")
    expect(h.text().join("\n")).toContain("unknown sidebar action")
  })
})

describe("persisted state", () => {
  test("showing and hiding is the session's: the stored profile is never written, and /panel reset still clears the panel's file", async () => {
    const h = reviewFixture({ session: "active" })
    mkdirSync(path.join(h.directory, ".mendcode", "tui"), { recursive: true })
    writeFileSync(path.join(h.directory, ".mendcode", "tui", "profile.json"), JSON.stringify({ sidebarWidgets: [] }))
    await h.type("/panel crew\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    await h.type("/panel off\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(false)
    await h.type("/panel\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    expect(readTuiProfile(h.dataDir).rightSidebar).toBe(false)
    await h.type("/panel reset\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(false)
  })

  test("preset, visibility and width come back with the session after a restart, and another session keeps the default", async () => {
    const first = reviewFixture({ session: "active" })
    await first.type("/panel ledger\r")
    await first.type("/panel width 60\r")
    expect(readTuiProfile(first.dataDir)).toMatchObject({ rightSidebar: false, sidebarWidth: 0 })
    const again = reviewFixture({ session: "active", width: 200, height: 60, reopen: { dataDir: first.dataDir, directory: first.directory, sessionId: first.sessionId } })
    await settle()
    again.app.render()
    expect(headerOf(again)).toBe("ledger")
    expect(again.app.accessibility.profile).toMatchObject({ rightSidebar: true, sidebarWidth: 60 })
    const other = reviewFixture({ session: "active", width: 200, height: 60, reopen: { dataDir: first.dataDir, directory: first.directory, sessionId: "ses_other" } })
    await settle()
    expect(other.app.accessibility.profile).toMatchObject({ rightSidebar: false, sidebarWidth: 0 })
  })
})

describe("empty states and stale quota", () => {
  test("home shows one calm line per empty card and never says unavailable twice", async () => {
    const h = reviewFixture({ session: "home", preset: "pulse" })
    await settle()
    h.app.render()
    const text = barText(h, 180)
    for (const banned of ["Grow unavailable", "Rate unavailable", "Turn unavailable", "Turn time unavailable", "Forecast unavailable"]) expect(text).not.toContain(banned)
    expect((text.match(/unavailable/g) ?? []).length).toBeLessThanOrEqual(1)
    expect(text).toContain("Context usage unavailable")
    expect(text).toContain("No timed turns yet")
    expect(text).toContain("No model calls yet")
    expect(text).not.toContain("0 calls")
    for (const preset of ["crew", "ledger", "focus"] as const) {
      await h.type(`/panel ${preset}\r`)
      const rows = bar(h.text(), 180)
      expect(rows.join("\n")).not.toMatch(/unavailable.*\n.*unavailable/)
      if (preset === "crew") {
        expect(rows.join("\n")).toContain("Nothing queued")
        expect(rows.filter((row) => /No (forks or )?sub-agents/.test(row))).toHaveLength(2)
      }
      if (preset === "focus") expect(rows.join("\n")).toContain("No files touched yet")
    }
  })

  test("a stale reading is one muted row with its age; a fresh one ends with a compact age", async () => {
    const stale = reviewFixture({ session: "home", preset: "pulse", quotaAgeMs: 708 * 60_000 })
    await settle()
    stale.app.render()
    const rows = bar(stale.text(), 180).filter((row) => row.includes("codex"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("quota stale · 11h ago")
    expect(barText(stale, 180)).not.toContain("checked")
    const fresh = reviewFixture({ session: "home", preset: "pulse" })
    await settle()
    fresh.app.render()
    expect(barText(fresh, 180)).toContain("codex · just now")
    expect(barText(fresh, 180)).toContain("codex 5h: 35%")
  })

  test("observed ages use the largest whole unit", () => {
    expect([0, 59_000, 60_000, 3_599_000, 3_600_000, 86_400_000, 3 * 86_400_000].map(observedAge)).toEqual(["just now", "just now", "1m ago", "59m ago", "1h ago", "1d ago", "3d ago"])
    expect([500, 12_000, 4 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map(orbitAge)).toEqual(["now", "12s ago", "4m ago", "3h ago", "2d ago"])
  })
})

describe("card heights", () => {
  test("todos keep their rows when a turn starts or ends and bound a long list with a count", () => {
    const items = [{ text: "a", status: "done" as const }, { text: "b", status: "in_progress" as const }, { text: "c", status: "pending" as const }]
    expect(todosCard({ items, width: 40, glyphs: g })).toHaveLength(4)
    const long = Array.from({ length: 9 }, (_, index) => ({ text: `item ${index}`, status: index < 3 ? "done" as const : "pending" as const }))
    const rows = todosCard({ items: long, width: 40, glyphs: g }).map((row) => row.map((span) => span.text).join(""))
    expect(rows).toHaveLength(8)
    expect(rows.at(-1)).toBe("+3 more")
    expect(rows.join("\n")).not.toContain("item 0")
  })

  test("the agent and context cards have the same height whether or not provider, effort, window and cache hints are known", () => {
    const base = { stateLabel: "idle", state: "idle" as const, billing: "Subscription" as const, permission: "ask" }
    expect(agentCard(base, 40, g)).toHaveLength(agentCard({ ...base, model: "m", provider: "p", effort: "high" }, 40, g).length)
    const known = contextCard({ tokens: 1000, compactAt: 10_000, window: 200_000 }, 40, g)
    expect(contextCard({ tokens: 1000, compactAt: 10_000 }, 40, g)).toHaveLength(known.length)
    expect(contextCard({ tokens: 1000, compactAt: 10_000, window: 200_000, cacheMiss: "last call missed" }, 40, g)).toHaveLength(known.length)
  })

  test("the workspace card says it is checking until git answers instead of claiming there is no repository", () => {
    const rows = (checking: boolean) => workspaceCard({ files: 0, added: 0, removed: 0, changesKnown: false, turns: 0, ...(checking ? { checking } : {}) }, 40).map((row) => row.map((span) => span.text).join("")).join("\n")
    expect(rows(true)).toContain("checking…")
    expect(rows(true)).not.toContain("No Git repository")
    expect(rows(false)).toContain("No Git repository")
  })
})

describe("live data", () => {
  test("every card of every preset shows values from the active session", async () => {
    const h = reviewFixture({ session: "active", width: 220, height: 200, preset: "pulse" })
    await settle()
    const expected: Record<string, string[]> = {
      pulse: ["Subscription", "35,300 / 160,000 compact", "tok/min", "night/panel", "Input 84K", "codex 5h: 35%"],
      crew: ["Inspect renderer", "Try alternative layout", "Verify next", "bun test --watch", "nightly-review: waiting"],
      ledger: ["Input 84K", "graft · ~3,400", "codex weekly: 62%", "faux/local-test", "graph_callers · ~310"],
      focus: ["35,300 / 160,000 compact", "Fix the next cycle", "src/panel.ts", "+40 -0"],
      full: ["Subscription", "tok/min", "Inspect renderer", "Verify next", "bun test --watch", "nightly-review", "graph_callers", "src/orbit.ts", "local-graph", "Panel session"],
    }
    for (const [preset, needles] of Object.entries(expected)) {
      await h.type(`/panel ${preset}\r`)
      await settle()
      h.app.render()
      const text = barText(h, 220)
      for (const needle of needles) expect(text, `${preset}: ${needle}`).toContain(needle)
    }
  })

  test("galaxy gains nodes and recent rows as tools touch files and its lists follow the selection", async () => {
    const h = reviewFixture({ session: "home", width: 200, height: 60, preset: "galaxy", rightSidebar: true })
    await settle()
    h.app.render()
    let text = barText(h, 200)
    expect(text).toContain("No code touched yet")
    expect(text).toContain("0 nodes")
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    const turnId = ids("turn"), itemId = ids("item")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "edit: src/live.ts" } })
    chat.emit({ type: "item.completed", itemId, status: "ok", meta: { path: `${h.directory}/src/live.ts` } })
    chat.emit({ type: "turn.completed", turnId })
    await settle()
    h.app.render()
    text = barText(h, 200)
    expect(text).toContain("1 node")
    expect(text).not.toContain("No code touched yet")
    for (const card of ["Focus", "Recent", "Top"]) expect(text).toContain(`─ ${card} `)
    expect(text).toContain("edit → live.ts")
    await h.type("\x1b}")
    await h.type("]")
    expect(barText(h, 200)).toMatch(/▸ edit → live\.ts/)
    expect(barText(h, 200)).toMatch(/─ Focus ─+ file/)
    expect(barText(h, 200)).toContain("file · 1 use")
    await h.type("\x1b")
  })
})

describe("galaxy fills a tall panel and scales with it", () => {
  const graph: OrbitGraph = {
    nodes: [
      { id: "sym:render", kind: "symbol", label: "renderToolCard", target: "src/a.ts", activity: 9, at: 3_000, parent: "file:a.ts", line: 237 },
      { id: "sym:cards", kind: "symbol", label: "cardRows", target: "src/a.ts", activity: 4, at: 8_000, parent: "file:a.ts" },
      { id: "sym:diff", kind: "symbol", label: "parseDiff", target: "src/b.ts", activity: 2, at: 4_000, parent: "file:b.ts" },
      { id: "file:a.ts", kind: "file", label: "src/a.ts", target: "src/a.ts", activity: 5, at: 8_000 },
      { id: "file:b.ts", kind: "file", label: "src/b.ts", target: "src/b.ts", activity: 1, at: 4_000 },
    ],
    edges: [["sym:render", "file:a.ts"], ["sym:cards", "file:a.ts"], ["sym:diff", "file:a.ts"], ["sym:diff", "file:b.ts"]],
    touches: [{ from: "sym:cards", to: "file:a.ts", at: 8_000, tool: "edit" }, { from: "sym:diff", to: "file:a.ts", at: 6_000, tool: "read" }, { from: "sym:diff", to: "file:b.ts", at: 4_000, tool: "read" }],
  }
  const camera = { yaw: 0, pitch: .2, selected: 3, focused: true }
  const plain = (rows: Array<{ text: string }[]>) => rows.map((row) => row.map((span) => span.text).join(""))

  test("focus lists the connections of the selected node most recent first, recent lists touches newest first and top ranks by activity", () => {
    const details = orbitDetails({ graph, camera, width: 50, now: 10_000, rows: { focus: 7, recent: 8, top: 5 } })
    const focus = plain(details.focus)
    expect(focus[0]).toContain("src/a.ts")
    expect(focus[1]).toBe("file · 5 uses · 2s ago".padEnd(50))
    expect(focus[2]!.trim()).toBe("symbols and links")
    expect(focus.indexOf(focus.find((row) => row.includes("cardRows"))!)).toBeLessThan(focus.indexOf(focus.find((row) => row.includes("parseDiff"))!))
    expect(focus.indexOf(focus.find((row) => row.includes("parseDiff"))!)).toBeLessThan(focus.indexOf(focus.find((row) => row.includes("renderToolCard"))!))
    const recent = plain(details.recent)
    expect(recent[0]).toContain("edit → a.ts")
    expect(recent[0]).toContain("2s ago")
    expect(recent[2]).toContain("read → b.ts")
    // A symbol names its file and line.
    expect(plain(orbitDetails({ graph, camera: { ...camera, selected: 0 }, width: 50, now: 10_000, rows: { focus: 7, recent: 8, top: 5 } }).focus)[1]!.trimEnd()).toBe("symbol · a.ts:237 · 9 uses · 7s ago")
    const top = plain(details.top)
    expect(top[0]).toContain("renderToolCard")
    expect(top[0]).toContain("██████████")
    expect(top.find((row) => row.includes("a.ts"))).toContain("▸")
    for (const row of [...focus, ...recent, ...top]) expect(textWidth(row)).toBe(50)
  })

  test("stepping events selects the touched file, lights its edge and wraps", () => {
    const stepped = { ...camera, selected: 0, event: undefined as string | undefined }
    expect(stepOrbitEvent(graph, stepped, 1)).toBe(true)
    expect(stepped.event).toBe("sym:cards|file:a.ts")
    expect(graph.nodes[stepped.selected]!.id).toBe("file:a.ts")
    stepOrbitEvent(graph, stepped, 1)
    stepOrbitEvent(graph, stepped, 1)
    expect(stepped.event).toBe("sym:diff|file:b.ts")
    stepOrbitEvent(graph, stepped, 1)
    expect(stepped.event).toBe("sym:cards|file:a.ts")
    stepOrbitEvent(graph, stepped, -1)
    expect(stepped.event).toBe("sym:diff|file:b.ts")
    expect(stepOrbitEvent({ nodes: [], edges: [] }, stepped, 1)).toBe(false)
    // The link from parseDiff to the far file: long enough to draw (a symbol's link to its own file can sit in one cell).
    const lit = renderOrbit(graph, 54, 30, { ...stepped, selected: -1, event: "sym:diff|file:a.ts" })
    const dark = renderOrbit(graph, 54, 30, { ...stepped, selected: -1, event: undefined })
    expect(lit).not.toEqual(dark)
    expect(orbitRecent(graph).map((touch) => touch.at)).toEqual([8_000, 6_000, 4_000])
  })

  test("the galaxy is centred in a wide sheet and no row exceeds the width, with labels kept off the right border", () => {
    const many: OrbitGraph = { nodes: Array.from({ length: 40 }, (_, index) => ({ id: `file:${index}`, kind: "file", label: `directory/longer-name-${index}.ts`, target: "", activity: index + 1 })), edges: [] }
    for (const width of [20, 54, 60, 98, 140]) for (const yaw of [0, 1, 2, 3, 4, 5]) {
      const rows = plain(renderOrbit(many, width, 34, { yaw, pitch: .2, selected: 5, focused: true }))
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      for (const row of rows.slice(0, -1)) expect(row.slice(-1)).toBe(" ")
    }
    const wide = plain(renderOrbit(many, 98, 34, camera))
    const used = wide.slice(0, 30).map((row) => row.search(/\S/)).filter((index) => index >= 0)
    expect(Math.min(...used)).toBeGreaterThanOrEqual(9)
    expect(Math.max(...wide.slice(0, 30).map((row) => textWidth(row.trimEnd())))).toBeLessThanOrEqual(98 - 9)
    // The default tilt and a view from above keep the same clear column: the disc is not cut at the canvas edge.
    for (const pitch of [.95, Math.PI / 2, -.5]) for (const width of [20, 54, 60]) for (const yaw of [0, 1, 2, 3, 4, 5]) {
      for (const row of plain(renderOrbit(many, width, 34, { yaw, pitch, selected: 5, focused: true })).slice(0, -1)) expect(row.slice(-1)).toBe(" ")
    }
  })

  test("at 200x60 the lower cards fill the bar; shorter bars drop them from the bottom and nothing overflows", async () => {
    const titles = (rows: string[]) => ["Focus", "Recent", "Top"].filter((title) => rows.some((row) => row.includes(`─ ${title} `)))
    // The disc keeps one status row under it, so the cards start three rows higher than with the old four-row legend.
    const expected: Record<number, string[]> = { 60: ["Focus", "Recent", "Top"], 44: ["Focus", "Recent", "Top"], 40: ["Focus", "Recent"], 36: ["Focus"], 32: [] }
    for (const [height, cards] of Object.entries(expected)) {
      const h = reviewFixture({ session: "active", width: 200, height: Number(height), preset: "galaxy", rightSidebar: true })
      await settle()
      h.app.render()
      const rows = h.text()
      expect(rows).toHaveLength(Number(height))
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(200)
      const bottom = bar(rows, 200)
      expect(titles(bottom), `height ${height}`).toEqual(cards)
    }
  })

  test("a short sheet keeps a usable canvas over its one status row", async () => {
    const h = reviewFixture({ session: "active", width: 100, height: 30, preset: "galaxy", rightSidebar: true })
    await settle()
    h.app.render()
    const rows = h.text()
    const from = rows.findIndex((row) => row.includes("─ Galaxy "))
    const legend = rows.findIndex((row) => /▣ \d+ files? · ◆ \d+ symbols? · \d+ links?/.test(row))
    expect(legend - from - 1).toBeGreaterThanOrEqual(7)
    expect(rows.join("\n")).not.toContain("hjkl")
  })

  test("ascii mode keeps the lower cards, bars and markers in ASCII", async () => {
    // The glyph set is resolved when the app starts, as a terminal's environment is fixed for the process.
    process.env.MENDCODE_GLYPHS = "ascii"
    try {
      const h = reviewFixture({ session: "active", width: 200, height: 60, preset: "galaxy", rightSidebar: true })
      h.app.applySettings({ onboarded: true, tier: "full", reducedMotion: true })
      await settle()
      h.app.render()
      await h.type("\t")
      h.app.render()
      const rows = bar(h.text(), 200)
      expect(rows.join("\n")).toContain("- Focus ")
      expect(rows.join("\n")).toContain("- Top ")
      expect(rows.join("\n")).toContain("->")
      // Everything under the header row: galaxy, legend and the three cards.
      for (const row of rows.slice(1)) expect(row, row).toMatch(/^[\x20-\x7e]*$/)
    } finally { delete process.env.MENDCODE_GLYPHS }
  })
})

describe("short sheets and keys", () => {
  test("a sheet under ten rows spends one row on the preset name and its note", async () => {
    const h = reviewFixture({ session: "active", width: 60, height: 20, preset: "pulse", rightSidebar: true })
    await settle()
    h.app.render()
    const rows = h.text()
    const at = rows.findIndex((row) => row.includes("pulse · /panel"))
    expect(at).toBeGreaterThan(0)
    expect(rows[at]).toMatch(/hidden/)
    expect(rows[at + 1]).toContain("─ Agent")
  })

  test("mouse selection offsets follow a set sidebar width", async () => {
    const h = reviewFixture({ session: "active", width: 200, height: 40, preset: "pulse", rightSidebar: true })
    h.app.applySettings({ onboarded: true, tier: "full", reducedMotion: true })
    await h.type("/panel width 80\r")
    await settle()
    h.app.render()
    const row = h.text().findIndex((line) => line.includes("LATEST ANSWER"))
    expect(row).toBeGreaterThan(-1)
    const column = h.text()[row]!.indexOf("LATEST")
    await h.app.onKey(`\x1b[<0;${column + 1};${row + 1}M`)
    await h.app.onKey(`\x1b[<32;${column + 14};${row + 1}M`)
    await h.app.onKey(`\x1b[<0;${column + 14};${row + 1}m`)
    const copied = h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))
    expect(copied.at(-1)).toBe("LATEST ANSWER")
  })
})


describe("one terminal's slash commands stay in its session", () => {
  test("/panel and /sidebar in one terminal leave another terminal of the same data dir as it was, also when the panel's file changes", async () => {
    const first = reviewFixture({ session: "active", preset: "focus" })
    const second = reviewFixture({ session: "active", reopen: { dataDir: first.dataDir, directory: first.directory, sessionId: "ses_second" } })
    await settle()
    await second.type("/panel off\r")
    await first.type("/panel crew\r")
    await first.type("/sidebar hidden\r")
    expect(headerOf(first)).toBe("crew")
    expect(second.app.accessibility.profile.rightSidebar).toBe(false)
    expect(second.app.accessibility.profile.sidebar).toBe("auto")
    // An idle terminal takes the new cards of the panel's file but does not open a bar its user closed.
    updateSidebar(first.dataDir, first.directory, { action: "set", scope: "project", widgets: structuredClone(SIDEBAR_PRESETS.ledger) as never })
    second.app.onGlobal({ type: "sidebar.changed", gseq: 2, at: NOW, directory: first.directory, widgets: SIDEBAR_PRESETS.ledger as never })
    await settle()
    expect(second.app.accessibility.profile.rightSidebar).toBe(false)
    expect(presetOf(second.app.accessibility.profile.sidebarWidgets)).toBe("ledger")
  })

  test("switching sessions in one terminal brings each session's own look and the default for one without", () => {
    const state = { sessionId: "ses_a", sessionLook: new Map([["ses_a", { timestamps: true, sidebar: "hidden" as const }]]), profileApplied: {}, profileBase: { ...DEFAULT_TUI_PROFILE, timestamps: false, sidebar: "auto" as const } }
    const applied: unknown[] = []
    state.sessionId = "ses_b"
    switchSessionLook({ state } as never, "ses_a", (patch) => void applied.push(patch))
    expect(applied).toEqual([{ timestamps: false, sidebar: "auto" }])
    state.sessionLook.set("ses_b", { timestamps: true } as never)
    state.sessionId = "ses_a"
    switchSessionLook({ state } as never, "ses_b", (patch) => void applied.push(patch))
    expect(applied.at(-1)).toEqual({ timestamps: true, sidebar: "hidden" })
  })
})

describe("the rows above the session and the panel", () => {
  test("showTopbar false removes the session's top row and panelHeader false the panel's name row; the content moves up", async () => {
    const on = reviewFixture({ session: "active", preset: "focus", width: 160, height: 24 })
    await settle()
    on.app.render()
    expect(on.text()[0]).toContain("Panel session")
    expect(on.text()[0]).toContain("focus · /panel")
    const off = reviewFixture({ session: "active", preset: "focus", width: 160, height: 24 })
    writeTuiProfile(off.dataDir, { ...readTuiProfile(off.dataDir), showTopbar: false, panelHeader: false })
    const again = reviewFixture({ session: "active", width: 160, height: 24, reopen: { dataDir: off.dataDir, directory: off.directory, sessionId: off.sessionId } })
    await settle()
    again.app.render()
    expect(again.text().join("\n")).not.toContain("· /panel")
    expect(again.text()[0]).not.toContain("Panel session")
    expect(again.text()[0]).toContain("─ Context")
  })
})
