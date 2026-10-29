import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"
import { readSidebar, sidebarScope, updateSidebar } from "../../../packages/daemon/src/sidebar"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { PANEL_PRESETS, SIDEBAR_PRESETS, panelPreset, presetOf } from "../src/view/sidebar-spec"
import { SLASH_COMMANDS, slashSuggestions } from "../src/view/commands"
import { DEFAULT_BINDINGS, LEADER_CHORDS } from "../src/ui/keymap"
import { buildBindings, parseKeybindings } from "../src/extensions/keybindings"
import { projectOrbit, renderOrbit, orbitAnimating, orbitPosition, orbitLabels, orbitNodeSize, orbitEdgeRole, stepOrbit, ORBIT_FIRE, ORBIT_FRAME_MS, type OrbitGraph } from "../src/view/panel-orbit"
import { panelSession } from "../src/view/panel-session"
import { sparkline, sparkRows } from "../src/view/panel-card"
import { SidebarSpec } from "@mendcode/protocol"
import { budgetMs } from "../../../scripts/test-budget"
import { featureOn } from "@mendcode/protocol/wire"
import { createUsageNotes } from "../src/view/usage-notes"
import { textWidth } from "../src/view/wrap"
import type { Block } from "../src/view/transcript"

afterAll(cleanTemps)
const settle = () => Bun.sleep(12)

function fixture(width = 220, height = 60, preset?: typeof PANEL_PRESETS[number], remote = false) {
  const dataDir = tempDir(), directory = tempDir(), sessionId = ids("session"), childId = ids("session")
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", sidebarWidgets: preset ? structuredClone(SIDEBAR_PRESETS[preset]) : [], rightSidebar: !!preset })
  const nodes = [
    { sessionId, title: "Panel session", createdAt: NOW - 60_000, updatedAt: NOW, current: true, labels: [] },
    { sessionId: childId, parentId: sessionId, title: "Inspect renderer", kind: "task", state: "completed", model: "local-test", createdAt: NOW - 30_000, updatedAt: NOW, current: false, labels: [] },
  ]
  const changed = [{ path: "src/panel.ts", touchedAt: NOW, status: "modified", additions: 14, deletions: 3, diff: "@@ -1 +1 @@\n-before\n+after\n", binary: false, truncated: false }]
  const h = appHarness({ width, height, directory, dataDir, sessionId, mode: "full", ...(remote ? { remote: { host: "peer.test", readOnly: true } } : {}), reply: (command) => {
    switch (command.type) {
      case "sidebar.get": return { ok: true, result: { widgets: readSidebar(dataDir, directory), scope: sidebarScope(dataDir, directory) } }
      case "sidebar.update": return { ok: true, result: { widgets: updateSidebar(dataDir, directory, command.change) } }
      case "session.tree": return { ok: true, result: { nodes } }
      case "session.changes": return { ok: true, result: { root: directory, files: changed, omittedFiles: 0, complete: true, scope: "session" } }
      case "session.savings": return { ok: true, result: { savings: [{ source: "graft", calls: 5, tokens: 3400 }, { source: "git", calls: 2, tokens: 1800 }] } }
      case "context.query": return { ok: true, result: { rent: [{ tool: "graph_callers", tokens: 310, uses: 5 }, { tool: "read", tokens: 180, uses: 4 }] } }
      case "git.status": return { ok: true, result: { branch: "night/panel", ahead: 1, behind: 0, dirty: 1 } }
      case "models.list": return { ok: true, result: { effective: { model: "local-test", effort: "high" }, roles: {}, models: [{ id: "local-test", provider: "faux", contextWindow: 200_000 }], selectable: false } }
      case "session.list": return { ok: true, result: { sessions: nodes.map((node) => ({ ...node, directory, state: "idle", queued: 0, lastSeq: 0 })) } }
      case "background.list": return { ok: true, result: { tasks: [] } }
      case "loop.list": return { ok: true, result: { loops: [] } }
      case "workflow.list": return { ok: true, result: { workflows: [] } }
      case "mcp.status": return { ok: true, result: { servers: [{ name: "local-graph", state: "connected", enabled: true, tools: 2, command: "local fake", stderr: [] }], issues: [] } }
      case "agent.debug": return { ok: true, result: { tools: { read: true, edit: true, shell: true, graph_callers: true } } }
      case "tools.list": return { ok: true, result: { tools: [], issues: [], directory } }
      default: return { ok: true }
    }
  } })
  h.app.applySettings({ onboarded: true, tier: "full", compactAtTokens: 160_000, reducedMotion: true })
  h.app.onGlobal({ type: "quota.snapshot", gseq: 1, at: NOW, provider: "faux", windows: [{ id: "5h", label: "5h", usedPercent: 35, resetsAt: NOW + 7_200_000 }, { id: "weekly", label: "weekly", usedPercent: 62, resetsAt: NOW + 86_400_000 }], fetchedAt: NOW, source: "local test fixture" })
  const chat = conversation(sessionId, (event) => h.app.onEvent(event))
  for (let index = 0; index < 3; index++) {
    chat.exchange(`Inspect turn ${index + 1}`, "LATEST ANSWER · session data")
    const turnId = ids("turn"), itemId = ids("item")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: index === 2 ? "edit: src/panel.ts" : "read: src/panel.ts" } })
    chat.emit({ type: "item.completed", itemId, status: "ok", meta: { path: `${directory}/src/panel.ts`, savedTokens: 100, filter: "graft" } })
    chat.emit({ type: "usage.recorded", turnId, provider: "faux", model: index === 1 ? "local-fast" : "local-test", input: 10_000 + index * 6_000, output: 900 + index * 200, reasoning: 200, cacheRead: 12_000, cacheWrite: 0, costMicros: 20_000, profile: { estimatedTokens: { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }, firstTokenMs: 500, durationMs: 10_000 + index * 1000, toolCount: 1, imageCount: 0 } })
    chat.emit({ type: "turn.completed", turnId })
  }
  if (!preset) chat.emit({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "Verify next", delivery: "queue" }, { queueId: ids("queue"), preview: "Keep the terminal responsive", delivery: "steer" }] })
  else chat.exchange("Layout request", "LATEST ANSWER · session data")
  return { ...h, dataDir, directory, chat, childId }
}

describe("panel commands", () => {
  test("panel owns toggle, off, every preset, next and the rebindable key; sidebar only toggles sessions", async () => {
    const h = fixture()
    await h.type("/panel\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    // Showing it is this session's: the stored profile and the panel's file, every terminal's default, are left as they were.
    expect(readTuiProfile(h.dataDir).rightSidebar).toBe(false)
    expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe("pulse")
    await h.type("/sidebar\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    await h.type("/panel\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(false)
    expect(LEADER_CHORDS.B).toBe("panel.toggle")
    expect(DEFAULT_BINDINGS.leader.get("B")).toEqual({ action: "panel.toggle" })
    const rebound = parseKeybindings(JSON.stringify({ f6: "panel.toggle" }))
    expect(rebound.problems).toEqual([])
    expect(buildBindings({ file: rebound.entries }).bindings.direct.get("\x1b[17~")).toEqual({ action: "panel.toggle" })
    await h.type("\x18B")
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    for (const preset of PANEL_PRESETS) {
      await h.type(`/panel ${preset}\r`)
      expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe(preset)
      expect(h.text().join("\n")).toContain(`${preset} · /panel`)
    }
    await h.type("/panel next\r")
    expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe("pulse")
    await h.type("/panel off\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(false)
    expect(h.app.accessibility.profile.sidebarWidgets).toEqual(SIDEBAR_PRESETS.pulse)
    await h.type("/panel reset\r")
    expect(h.app.accessibility.profile.sidebarWidgets).toEqual([])
  })

  test("legacy aliases still work and are absent from help/completion", async () => {
    const h = fixture()
    await h.type("/sidebar preset atelier\r")
    expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe("pulse")
    await h.type("/sidebar right\r")
    expect(h.app.accessibility.profile.rightSidebar).toBe(false)
    await h.type("/sidebar width 70\r")
    expect(h.app.accessibility.profile.sidebarWidth).toBe(70)
    await h.type("/sidebar edit\r")
    expect(h.text().join("\n")).toContain("Widget")
    await h.type("\x1b")
    await h.type("/sidebar reset\r")
    expect(h.app.accessibility.profile.sidebarWidgets).toEqual([])
    expect(panelPreset("atelier")).toBe("pulse")
    expect(JSON.stringify(SLASH_COMMANDS)).not.toContain("atelier")
    expect(slashSuggestions("/panel ").map((entry) => entry.name)).toContain("panel galaxy")
    expect(slashSuggestions("/panel ga").map((entry) => entry.name)).toEqual(["panel galaxy"])
    // The galaxy's first name: it still opens the preset and is offered nowhere.
    expect(panelPreset("orbit")).toBe("galaxy")
    expect(PANEL_PRESETS).not.toContain("orbit" as never)
    expect(JSON.stringify(SLASH_COMMANDS)).not.toContain("panel orbit")
    expect(slashSuggestions("/panel ").map((entry) => entry.name)).not.toContain("panel orbit")
    expect(slashSuggestions("/panel or")).toEqual([])
    await h.type("/panel orbit\r")
    expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe("galaxy")
    expect(h.text().join("\n")).toContain("galaxy · /panel")
    expect(h.text().join("\n")).not.toContain("orbit · /panel")
    // The usage line of an unknown verb lists the presets by their current names.
    await h.type("/panel nonsense\r")
    const usage = h.text().find((row) => row.includes("Use /panel ["))!
    expect(usage).toContain("|galaxy|")
    expect(usage).not.toContain("orbit")
    await h.type("/panel cr\t")
    expect(h.app.editor.text).toBe("/panel crew ")
    await h.type("\r")
    expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe("crew")
    await h.type("/panel off\r")
  })

  test("balanced refuses galaxy and cycles past it; minimal refuses presets", async () => {
    const h = fixture()
    h.app.applySettings({ onboarded: true, tier: "balanced", view: "balanced" })
    await h.type("/panel galaxy\r")
    expect(h.app.accessibility.profile.sidebarWidgets).toEqual([])
    expect(h.text().join("\n")).toContain("Galaxy needs full tier")
    // The old name is refused the same way: an alias is not a way around the tier.
    await h.type("/panel orbit\r")
    expect(h.app.accessibility.profile.sidebarWidgets).toEqual([])
    await h.type("/panel full\r")
    await h.type("/panel next\r")
    expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe("pulse")
    await h.type("/panel off\r")
    h.app.applySettings({ onboarded: true, tier: "minimalist", view: "minimal" })
    await h.type("/panel crew\r")
    expect(presetOf(h.app.accessibility.profile.sidebarWidgets)).toBe("pulse")
  })
})

for (const preset of PANEL_PRESETS) for (const [width, height] of [[60, 20], [100, 30], [180, 50], [220, 60]]) {
  test(`${preset} fits and aligns at ${width}x${height}`, async () => {
    const h = fixture(width, height, preset)
    await settle()
    h.app.render()
    const rows = h.text()
    expect(rows).toHaveLength(height!)
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width!)
    expect(rows.join("\n")).toContain(`${preset} · /panel`)
    expect(rows.join("\n")).toContain("LATEST ANSWER")
    if (width! >= 180) {
      const header = rows.find((row) => row.includes(`${preset} · /panel`))!
      expect(textWidth(header.slice(0, header.indexOf(`${preset} · /panel`)))).toBe(width! - 56)
      if (preset === "pulse") expect(rows.join("\n")).toContain("Last turn 5.0s")
    }
    const output = process.env.MENDCODE_PANEL_FRAMES
    if (output) {
      mkdirSync(output, { recursive: true })
      writeFileSync(path.join(output, `${preset}-${width}x${height}.txt`), `${rows.join("\n")}\n`)
      writeFileSync(path.join(output, `${preset}-${width}x${height}.json`), JSON.stringify(h.frames.at(-1)))
    }
    if (preset === "galaxy") {
      await h.type("\x1b}")
      const dump = (name: string) => {
        if (!output) return
        writeFileSync(path.join(output, name + ".txt"), h.text().join("\n") + "\n")
        writeFileSync(path.join(output, name + ".json"), JSON.stringify(h.frames.at(-1)))
      }
      await h.type("\t")
      dump(`galaxy-${width}x${height}-focused`)
      for (const angle of ["1rad", "2rad", "3rad"]) {
        for (let step = 0; step < 5; step++) await h.type("l")
        dump(`galaxy-${width}x${height}-${angle}-rotated`)
        for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(width!)
      }
      // Focused, the one status row under the disc names the keys; zoom works but is not spelled out.
      await h.type("+")
      expect(h.text().join("\n")).toContain("hjkl · tab")
      expect(h.text().join("\n")).not.toMatch(/1[01]0%/)
      await h.type("f")
      expect(h.text().join("\n")).toContain("[file]")
      await h.type("f")
      expect(h.text().join("\n")).toContain("[symbol]")
      expect(h.text().join("\n")).toContain("No symbol nodes yet")
      await h.type("f")
      expect(h.text().join("\n")).not.toContain("[symbol]")
      await h.type("\x1b")
    }
    await h.type("/panel off\r")
  })
}

test("galaxy uses real node edges, keyboard focus/open, stops animation off page and respects reduced motion", async () => {
  const h = fixture()
  await h.type("/panel galaxy\r")
  await settle()
  await h.type("\x1b}")
  const before = h.text().join("\n")
  await Bun.sleep(220)
  h.app.render()
  expect(h.text().join("\n")).toBe(before)
  await h.type("h")
  expect(h.text().join("\n")).not.toBe(before)
  // The galaxy is the session's code: the file it read and edited, not the session, its sub-agents or its tools.
  expect(h.text().join("\n")).toContain("─ Galaxy ─")
  expect(h.text().join("\n")).toContain("1 node")
  expect(h.text().join("\n")).toContain("panel.ts")
  await h.type("\x1b")
  h.app.applySettings({ onboarded: true, tier: "full", reducedMotion: false })
  await h.type("\x1b}")
  h.frames.length = 0
  await Bun.sleep(320)
  expect(h.frames.length).toBeGreaterThanOrEqual(2)
  expect(h.frames.length).toBeLessThanOrEqual(4)
  await h.type("\x1b")
  await settle()
  const count = h.frames.length
  await Bun.sleep(220)
  expect(h.frames.length).toBe(count)
  await h.type("\x1b}")
  // The file node is the only one: Enter selects its retained session diff.
  await h.type("\r")
  expect(h.sentOf("session.changes").length).toBeGreaterThan(0)
  expect(h.text().join("\n")).toContain("src/panel.ts")
  await settle()
  const offPage = h.frames.length
  await Bun.sleep(220)
  expect(h.frames.length).toBe(offPage)
})

test("full keeps every data card reachable by scrolling instead of dropping its last cards", async () => {
  const h = fixture(220, 60, "full")
  await settle()
  h.app.render()
  expect(h.text().join("\n")).not.toContain("hidden")
  await h.type("\x1b}")
  for (let index = 0; index < 40; index++) await h.type("\x1b[6~")
  expect(h.text().join("\n")).toContain("full · /panel")
  expect(h.text().join("\n")).toContain("graph_callers · ~310")
  expect(h.text().join("\n")).toContain("+14 -3")
  await h.type("/panel off\r")
})

test("the session's code graph comes from declared metadata: files read or changed, symbols and calls a graph lookup returned", () => {
  const entry = (label: string, file: string, line: number, depth?: number, via?: string) => ({ label, file, line, kind: "function", ...(depth ? { depth, via } : {}) })
  const callers = { type: "codemap", center: entry("renderToolCard", "src/tool-card.ts", 237), left: { title: "callers", entries: [entry("defaultBody", "src/transcript.ts", 399), entry("rowsOf", "src/transcript.ts", 520, 2, "defaultBody")] }, right: { title: "callees", entries: [entry("cardRows", "src/tool-card.ts", 254)] } } as const
  const search = { type: "codemap", center: { label: "search: render", kind: "search" }, left: { title: "", entries: [] }, right: { title: "matches", entries: [entry("renderHome", "src/home.ts", 80)] } } as const
  const blocks: Block[] = [
    { kind: "tool_call", itemId: ids("item"), turnId: ids("turn"), title: "read: old.ts", text: "", at: 1, endAt: 2, meta: { path: "/project/old.ts" } },
    { kind: "tool_call", itemId: ids("item"), turnId: ids("turn"), title: "edit: new.ts", text: "", at: 3, endAt: 5, meta: { path: "/project/new.ts", savedTokens: 400, filter: "graft" } },
    { kind: "tool_call", itemId: ids("item"), turnId: ids("turn"), title: "shell: cat fake.ts", text: "secret output never parsed", at: 6 },
    { kind: "tool_call", itemId: ids("item"), turnId: ids("turn"), title: "graph_callers: renderToolCard", text: "d1 ...", at: 7, endAt: 8, render: callers as never },
    { kind: "tool_call", itemId: ids("item"), turnId: ids("turn"), title: "graph_find: render", text: "...", at: 9, endAt: 10, render: search as never },
  ]
  const session = panelSession(blocks, "/project")
  expect(session.files.map((file) => file.path)).toEqual(["new.ts", "old.ts"])
  const ids_ = new Set(session.graph.nodes.map((node) => node.id))
  for (const id of ["file:new.ts", "file:old.ts", "file:src/tool-card.ts", "sym:src/tool-card.ts#renderToolCard", "sym:src/transcript.ts#rowsOf", "sym:src/home.ts#renderHome"]) expect(ids_.has(id)).toBe(true)
  // No session, tool or MCP nodes, and a search has no symbol at its centre.
  expect(session.graph.nodes.every((node) => node.kind === "file" || node.kind === "symbol")).toBe(true)
  expect(ids_.has("sym:#search: render")).toBe(false)
  // Calls run caller -> centre -> callee, a deeper hop from the entry it came through; a symbol hangs off its file.
  expect(session.graph.edges).toContainEqual(["sym:src/transcript.ts#defaultBody", "sym:src/tool-card.ts#renderToolCard"])
  expect(session.graph.edges).toContainEqual(["sym:src/tool-card.ts#renderToolCard", "sym:src/tool-card.ts#cardRows"])
  expect(session.graph.edges).toContainEqual(["sym:src/transcript.ts#rowsOf", "sym:src/transcript.ts#defaultBody"])
  expect(session.graph.edges).toContainEqual(["file:src/home.ts", "sym:src/home.ts#renderHome"])
  expect(session.graph.nodes.find((node) => node.id === "sym:src/tool-card.ts#cardRows")).toMatchObject({ parent: "file:src/tool-card.ts", target: "src/tool-card.ts", line: 254 })
  // Every use keeps its time and its tool: the newest is the find, and a file read on its own is a touch with no link to draw.
  expect(session.graph.at).toBe(10)
  expect(session.graph.touches).toContainEqual({ from: "file:old.ts", to: "file:old.ts", at: 2, tool: "read" })
  expect(session.graph.edges).not.toContainEqual(["file:old.ts", "file:old.ts"])
  expect(session.graph.nodes.some((node) => node.id === "file:fake.ts")).toBe(false)
  expect(session.savings.get("graft")).toBe(400)
  // Bounded: a long session keeps the newest nodes, each symbol with its file.
  const many: Block[] = Array.from({ length: 80 }, (_, index) => ({ kind: "tool_call", itemId: ids("item"), turnId: ids("turn"), title: "graph_find: x", text: "", at: index, endAt: index, render: { ...search, right: { title: "matches", entries: [entry(`f${index}`, `src/m${index}.ts`, 1)] } } as never }))
  const bounded = panelSession(many, "/project").graph
  expect(bounded.nodes).toHaveLength(96)
  expect(bounded.omitted).toBe(160 - 96)
  for (const node of bounded.nodes) if (node.parent) expect(bounded.nodes.some((other) => other.id === node.parent)).toBe(true)
  expect(bounded.nodes.some((node) => node.label === "f79")).toBe(true)
  expect(bounded.nodes.some((node) => node.label === "f0")).toBe(false)
  expect(sparkline([1, 2, 4, 8], 4)).toBe("▂▃▅█")
  expect(sparkline([1, 2, 4, 8], 4, true)).toMatch(/^[._\-~=+*#]+$/)
})

test("pace turn durations use lifecycle events, survive duplicate events and reset by session", () => {
  const notes = createUsageNotes()
  const sessionId = ids("session"), turnId = ids("turn")
  const chat = conversation(sessionId, (event) => notes.apply(event))
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue"), at: 1000 })
  chat.emit({ type: "turn.completed", turnId, at: 13_000 })
  chat.emit({ type: "turn.completed", turnId, at: 14_000 })
  expect(notes.turnTimes).toEqual([12_000])
  notes.reset()
  expect(notes.turnTimes).toEqual([])
})

test("galaxy projection is deterministic, bounded and the warmed maximum frame stays below 4 ms", () => {
  const graph: OrbitGraph = { nodes: Array.from({ length: 96 }, (_, index) => ({ id: `file:${index}`, kind: "file", label: `file-${index}.ts`, target: `${index}.ts`, activity: index + 1 })), edges: Array.from({ length: 256 }, (_, index) => [`file:${index % 96}`, `file:${(index * 7 + 1) % 96}`]) }
  const camera = { yaw: .3, pitch: .2, selected: 2 }
  expect(projectOrbit(graph.nodes, 80, 32, camera)).toEqual(projectOrbit(graph.nodes, 80, 32, camera))
  expect(projectOrbit(graph.nodes, 80, 32, { ...camera, yaw: .4 })).not.toEqual(projectOrbit(graph.nodes, 80, 32, camera))
  const ascii = renderOrbit(graph, 80, 36, camera, true)
  expect(ascii.every((row) => row.every((span) => /^[\x20-\x7e]*$/.test(span.text)))).toBe(true)
  expect(ORBIT_FRAME_MS).toBe(100)
  expect(orbitAnimating(true, true, false, false)).toBe(true)
  expect(orbitAnimating(true, false, true, false)).toBe(true)
  expect(orbitAnimating(true, true, true, true)).toBe(false)
  expect(orbitAnimating(true, false, false, false)).toBe(false)
  expect(orbitAnimating(false, true, true, false)).toBe(false)
  // A use in the last few seconds keeps it moving so the spark can run and fade; then it rests, and never under reduced motion.
  expect(orbitAnimating(true, false, false, false, 10_000, 12_000)).toBe(true)
  expect(orbitAnimating(true, false, false, false, 10_000, 10_000 + ORBIT_FIRE.warm)).toBe(false)
  expect(orbitAnimating(true, false, false, true, 10_000, 12_000)).toBe(false)
  expect(orbitAnimating(false, false, false, false, 10_000, 12_000)).toBe(false)
  for (let index = 0; index < 40; index++) renderOrbit(graph, 80, 36, camera)
  // The budget is what a frame costs to compute. A frame measured over it is measured again: the render is a pure function of its
  // arguments, so time over its fastest run is the machine taking the processor away (twelve test processes share it), not the frame.
  const frameMs = (yaw: number) => {
    const start = performance.now()
    const rows = renderOrbit(graph, 80, 36, { ...camera, yaw })
    return { ms: performance.now() - start, rows }
  }
  let maximum = 0
  for (let index = 0; index < 120; index++) {
    const { ms: first, rows } = frameMs(index / 10)
    let ms = first
    for (let again = 0; again < 4 && ms > budgetMs(4); again++) ms = Math.min(ms, frameMs(index / 10).ms)
    maximum = Math.max(maximum, ms)
    expect(rows).toHaveLength(36)
    expect(rows.every((row) => textWidth(row.map((span) => span.text).join("")) <= 80)).toBe(true)
  }
  expect(maximum).toBeLessThanOrEqual(budgetMs(4))
  if (process.env.MENDCODE_PANEL_FRAMES) writeFileSync(path.join(process.env.MENDCODE_PANEL_FRAMES, "galaxy-budget.json"), JSON.stringify({ maximumMs: maximum, frames: 120, nodes: 96, edges: 256, frameIntervalMs: ORBIT_FRAME_MS }))
})

test("galaxy positions survive reorder, insertion and filtering; perspective and inertia convey depth", () => {
  const nodes: OrbitGraph["nodes"] = ["a", "b", "c", "d"].map((id, index) => ({ id, kind: index % 2 ? "tool" : "file", label: id, target: id, activity: 1 }))
  const camera = { yaw: .3, pitch: .2, selected: -1, zoom: 1, focused: false }
  const points = projectOrbit(nodes, 60, 24, camera)
  // The disc: agents in the core, every other kind along the arms out to radius 1, all of it close to the x/z plane.
  const radial = (position: { x: number; z: number }) => Math.hypot(position.x, position.z)
  for (let index = 0; index < 200; index++) {
    const agent = orbitPosition(`session:${index}`, "agent")
    expect(radial(agent)).toBeLessThanOrEqual(.14 + 1e-9)
    expect(Math.abs(agent.y)).toBeLessThanOrEqual(.03)
    for (const kind of ["file", "tool", "mcp", undefined] as const) {
      const arm = orbitPosition(`${kind}:${index}`, kind)
      expect(radial(arm)).toBeGreaterThanOrEqual(.24 - 1e-9)
      expect(radial(arm)).toBeLessThanOrEqual(1 + 1e-9)
      expect(Math.abs(arm.y)).toBeLessThanOrEqual(.04)
      expect(orbitPosition(`${kind}:${index}`, kind)).toEqual(arm)
    }
  }
  for (const point of points) {
    const position = orbitPosition(point.node.id, point.node.kind)
    expect(radial(position)).toBeGreaterThanOrEqual(.24 - 1e-9)
    expect(radial(position)).toBeLessThanOrEqual(1 + 1e-9)
    const reordered = projectOrbit([...nodes].reverse(), 60, 24, camera).find((p) => p.node.id === point.node.id)!
    expect([point.x, point.y, point.depth]).toEqual([reordered.x, reordered.y, reordered.depth])
    const inserted = projectOrbit([...nodes, { ...nodes[0]!, id: "new" }], 60, 24, camera).find((p) => p.node.id === point.node.id)!
    expect([inserted.x, inserted.y, inserted.depth]).toEqual([point.x, point.y, point.depth])
    if (point.node.kind === "file") expect(projectOrbit(nodes, 60, 24, { ...camera, filter: "file" }).find((p) => p.node.id === point.node.id)).toEqual(point)
  }
  const near = [...points].sort((a, b) => b.depth - a.depth)
  expect(near[0]!.perspective).toBeGreaterThan(near.at(-1)!.perspective)
  expect(orbitEdgeRole(-.8, -.6).dim).toBe(true)
  expect(orbitEdgeRole(.8, .6).dim).toBe(false)
  expect(orbitEdgeRole(-.8, -.6, true)).toEqual({ fg: "warning", dim: false })
  const velocity = { yaw: .08, pitch: -.04 }
  stepOrbit(camera, velocity, false)
  expect(camera.yaw).toBeCloseTo(.398)
  expect(Math.abs(velocity.yaw)).toBeLessThan(.08)
  const held = { ...camera }
  stepOrbit(camera, velocity, true)
  expect(camera).toEqual(held)
  expect(velocity).toEqual({ yaw: 0, pitch: 0 })
})

test("nearest labels never collide with glyphs or each other, including wide characters", () => {
  const nodes: OrbitGraph["nodes"] = Array.from({ length: 96 }, (_, i) => ({ id: `node-${i}`, kind: "file", label: i % 3 ? `long-name-${i}.ts` : "目录/数据.ts", target: "", activity: 1 }))
  for (const [width, height] of [[12, 4], [56, 24], [80, 32]]) for (const yaw of [0, .6, 1.2, 1.8]) {
    const camera = { yaw, pitch: .2, selected: 5, focused: true }
    const points = projectOrbit(nodes, width!, height!, camera)
    const labels = orbitLabels(points, width!, height!, camera)
    expect(labels.length).toBeLessThanOrEqual(6)
    for (const label of labels) {
      expect(label.x).toBeGreaterThanOrEqual(0)
      expect(label.x + label.width).toBeLessThan(width!)
      expect(label.y).toBeGreaterThanOrEqual(0)
      expect(label.y).toBeLessThan(height!)
      for (const other of labels) if (label !== other && label.y === other.y) expect(label.x + label.width < other.x || other.x + other.width < label.x).toBe(true)
      for (const point of points) if (point.y === label.y) expect(point.x + orbitNodeSize(point, camera) < label.x || point.x - orbitNodeSize(point, camera) >= label.x + label.width).toBe(true)
    }
  }
})

test("a used link fires like a neuron: a spark runs along it, it glows, cools and rests; reduced motion and ASCII stay static", () => {
  const nodes: OrbitGraph["nodes"] = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, kind: i % 2 ? "symbol" : "file", label: `node ${i}`, target: "", activity: 1 }))
  const graph: OrbitGraph = { nodes, edges: [["n0", "n1"]], touches: [{ from: "n0", to: "n1", at: 1000 }] }
  const fired: OrbitGraph = { ...graph, nodes: nodes.map((node) => (node.id === "n1" ? { ...node, at: 1000 } : node)) }
  const camera = { yaw: .4, pitch: .2, selected: -1, focused: false }
  const text = (rows: ReturnType<typeof renderOrbit>) => rows.flat().map((span) => span.text).join("")
  const base = renderOrbit(graph, 60, 24, camera)
  expect(base.flat().some((span) => /[\u2800-\u28ff]/.test(span.text))).toBe(true)
  // Half way through the spark: a head on the link, and the part behind it lit.
  const spark = renderOrbit(fired, 60, 24, camera, false, { now: 1000 + ORBIT_FIRE.spark / 2 })
  expect(text(spark)).toContain("\u25cf")
  expect(spark.flat().some((span) => span.text.includes("\u2022") && span.fg === "warning")).toBe(true)
  // Then the whole link glows with no head; the node that fired is drawn in the firing colour, bold.
  const lit = renderOrbit(fired, 60, 24, camera, false, { now: 1000 + ORBIT_FIRE.spark + 100 })
  expect(text(lit)).not.toContain("\u25cf")
  expect(lit.flat().some((span) => span.text.includes("\u2022") && span.fg === "warning")).toBe(true)
  // Warm: the link in the target kind's colour, plain dots; then it rests exactly as if it was never used.
  const warm = renderOrbit(fired, 60, 24, camera, false, { now: 1000 + ORBIT_FIRE.warm - 100 })
  expect(text(warm)).not.toContain("\u2022")
  expect(warm).not.toEqual(base)
  expect(renderOrbit(graph, 60, 24, camera, false, { now: 1000 + ORBIT_FIRE.warm })).toEqual(base)
  for (const live of [{ now: 1100, reduced: true }, { now: 900 }]) expect(renderOrbit(graph, 60, 24, camera, false, live)).toEqual(base)
  const ascii = text(renderOrbit(fired, 60, 24, camera, true, { now: 1000 + ORBIT_FIRE.spark / 2 }))
  expect(ascii).toMatch(/^[\x20-\x7e]*$/)
  expect(ascii).toContain("*")
  const empty = text(renderOrbit({ nodes: [], edges: [] }, 60, 16, camera))
  expect(empty).toContain("No code touched yet")
  expect(empty).toContain("m shows the project's code")
})

test("focused glyph stays visible when a nearer node shares its terminal cell", () => {
  const graph: OrbitGraph = { nodes: Array.from({ length: 96 }, (_, index) => ({ id: `file:${index}`, kind: "file", label: `file-${index}`, target: "", activity: 1 })), edges: [] }
  const camera = { yaw: .3, pitch: .2, selected: -1, focused: true }
  const points = projectOrbit(graph.nodes, 20, 8, camera)
  const target = points.find((point) => points.some((other) => other.index !== point.index && point.x === other.x && point.y === other.y && point.depth < other.depth))!
  expect(target).toBeDefined()
  camera.selected = target.index
  const rows = renderOrbit(graph, 20, 9, camera)
  let x = 0
  const span = rows[target.y]!.find((span) => {
    const left = x
    x += textWidth(span.text)
    return left <= target.x && x > target.x
  })!
  expect(span.fg).toBe("warning")
  expect(span.dim).toBe(false)
  expect(span.bold).toBe(true)
})

test("ledger merges quota aliases, models validate lazily, and sparse pace fills its card", async () => {
  expect(SIDEBAR_PRESETS.ledger.map((widget) => widget.type)).toEqual(["tokens", "savings", "limits", "models", "rent"])
  expect(SidebarSpec.parse(SIDEBAR_PRESETS.ledger)).toEqual(SIDEBAR_PRESETS.ledger)
  expect(featureOn({ tier: "balanced" }, "panel_models")).toBe(true)
  expect(featureOn({ tier: "minimalist" }, "panel_models")).toBe(false)
  expect(sparkline([2, 4], 54)).toHaveLength(54)
  const rows = sparkRows("Rate", [2, 4], 54, String)
  expect(rows.map((row) => textWidth(row.map((span) => span.text).join("")))).toEqual([54, 54, 54])
  expect(rows[0]!.map((span) => span.text).join("")).toContain("min 2 · max 4")
  const h = fixture(220, 60, "ledger")
  await settle()
  const text = h.text().join("\n")
  expect(text).toContain("Models")
  expect(text).toContain("faux/local-fast")
  expect(text).toContain("faux/local-test")
  expect(text).toContain("Limits")
  expect(text).not.toContain("─ Usage")
  await h.type("/panel off\r")
})

/** A graph lookup as the transcript receives it: a tool call whose result declares a call map. */
function lookup(chat: ReturnType<typeof fixture>["chat"], tool: string) {
  const turnId = ids("turn"), itemId = ids("item")
  const render = { type: "codemap", center: { label: "renderToolCard", file: "src/tool-card.ts", line: 237, kind: "function" }, left: { title: "callers", entries: [{ label: "defaultBody", file: "src/transcript.ts", line: 399, kind: "function" }] }, right: { title: "callees", entries: [] } }
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool } })
  chat.emit({ type: "item.completed", itemId, status: "ok", text: "d1 ...", render })
  chat.emit({ type: "turn.completed", turnId })
}

test("a symbol opens its file at its line from a filtered galaxy; empty filters never open another type", async () => {
  const h = fixture(220, 60, "galaxy")
  lookup(h.chat, "graph_callers: renderToolCard")
  await settle()
  await h.type("\x1b}")
  for (let index = 0; index < 2; index++) await h.type("f")
  expect(h.text().join("\n")).toContain("[symbol]")
  await h.type("\r")
  await settle()
  const opened = h.sentOf("file.view") as Array<{ path: string }>
  expect(opened).toHaveLength(1)
  expect(["src/tool-card.ts", "src/transcript.ts"]).toContain(opened[0]!.path)
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.galaxy) })
  const empty = appHarness({ width: 100, height: 30, directory: tempDir(), dataDir, mode: "full" })
  empty.app.applySettings({ tier: "full", onboarded: true, reducedMotion: true })
  await settle()
  await empty.type("\x1b}")
  await empty.type("f")
  await empty.type("\r")
  expect(empty.text().join("\n")).toContain("galaxy · /panel · focused")
  expect(empty.sentOf("tools.list")).toHaveLength(0)
  expect(empty.sentOf("session.changes")).toHaveLength(1) // Initial graph query only; Enter does nothing.
  await empty.type("\x1b")
  await empty.type("/panel off\r")
})

test("per-model totals deduplicate events, include compaction, and reset with bounded overflow", () => {
  const notes = createUsageNotes()
  const chat = conversation(ids("session"), (event) => {
    notes.apply(event, true)
    notes.apply(event, true)
  })
  for (let index = 0; index < 70; index++) chat.emit({ type: "usage.recorded", turnId: ids("turn"), provider: index % 2 ? "one" : "two", model: `model-${index}`, input: 10, output: 2, reasoning: 1, cacheRead: 20, cacheWrite: 3 })
  expect(notes.models.length).toBe(65)
  expect(notes.models.reduce((sum, model) => sum + model.input, 0)).toBe(notes.totals.input)
  expect(notes.models.reduce((sum, model) => sum + model.cacheRead, 0)).toBe(1400)
  expect(notes.models.find((model) => model.model === "Other models")?.calls).toBe(6)
  notes.reset()
  expect(notes.models).toEqual([])
})

test("a fresh lookup makes an unfocused galaxy fire for a few seconds, then it rests and draws no more frames", async () => {
  const dataDir = tempDir()
  let clock = NOW
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.galaxy) })
  const h = appHarness({ width: 200, height: 60, directory: tempDir(), dataDir, mode: "full", now: () => clock })
  h.app.applySettings({ tier: "full", onboarded: true, reducedMotion: false })
  await settle()
  const chat = conversation(h.sessionId, (event) => h.app.onEvent({ ...event, at: clock } as never))
  lookup(chat, "graph_callers: renderToolCard")
  h.app.render()
  expect(h.text().join("\n")).toContain("◆ 2 symbols")
  expect(h.text().join("\n")).not.toContain("· focused")
  h.frames.length = 0
  await Bun.sleep(320)
  expect(h.frames.length).toBeGreaterThanOrEqual(2)
  clock += ORBIT_FIRE.warm + 1
  await Bun.sleep(120)
  const rested = h.frames.length
  await Bun.sleep(220)
  expect(h.frames.length).toBe(rested)
})

test("a remote galaxy draws the lookups it observed without asking for local server configuration", async () => {
  const h = fixture(220, 60, "galaxy", true)
  await h.type("/panel galaxy\r")
  const itemId = ids("item")
  h.chat.emit({ type: "item.started", turnId: ids("turn"), itemId, kind: "tool_call", meta: { tool: "mcp__observed__lookup" } })
  h.chat.emit({ type: "item.completed", itemId, status: "ok" })
  lookup(h.chat, "graph_callers: renderToolCard")
  await settle()
  h.app.render()
  expect(h.sentOf("mcp.status")).toHaveLength(0)
  // Files and symbols only: the MCP tool call is not a node.
  expect(h.text().join("\n")).toContain("◆ 2 symbols")
  expect(h.text().join("\n")).not.toMatch(/◉\d|✦\d/)
  await h.type("/panel off\r")
})

test("a click on the Galaxy panel never takes the keyboard (its keys are letters of the prompt); ctrl+\\ and alt+} give it, esc or a click on the chat gives it back", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.galaxy) })
  const h = appHarness({ width: 140, height: 30, directory: tempDir(), dataDir, mode: "full" })
  h.app.applySettings({ tier: "full", onboarded: true, reducedMotion: true })
  await settle()
  expect(h.text().join("\n")).toContain("galaxy · /panel · ctrl+\\ focus")
  for (const key of "hjklf+-[]") await h.type(key)
  expect(h.app.editor.text).toBe("hjklf+-[]")
  await h.type("\x15")
  await h.type("\x1b[<0;135;8M")
  await h.type("\x1b[<0;135;8m")
  expect(h.text().join("\n")).not.toContain("· focused")
  for (const key of "hjklmf") await h.type(key)
  expect(h.app.editor.text).toBe("hjklmf")
  await h.type("\x15")
  await h.type("\x1c")
  expect(h.text().join("\n")).toContain("galaxy · /panel · focused · esc back")
  await h.type("l")
  expect(h.app.editor.text).toBe("")
  await h.type("\x1b[<0;20;8M")
  await h.type("\x1b[<0;20;8m")
  expect(h.text().join("\n")).not.toContain("· focused")
  await h.type("l")
  expect(h.app.editor.text).toBe("l")
  await h.type("\x15")
  for (const key of ["\x1c", "\x1b}"]) {
    await h.type(key)
    expect(h.text().join("\n")).toContain("· focused")
    await h.type("\x1b")
    expect(h.text().join("\n")).not.toContain("· focused")
  }
})
