import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { CommandReply } from "@mendcode/client"
import { BREAKPOINTS, breakpointOf, isCompact, isWide, isXl, PET_MIN_WIDTH } from "../src/ui/breakpoints"
import { attachSidebar, chatColumns, renderSidebar, SIDEBAR_GAP, SIDEBAR_WIDTH, sidebarVisible, type SidebarInput } from "../src/view/sidebar"
import { ACTION_LABEL, KEY_ACTIONS, keymapHelp, LEADER_KEY, resolveKey, type LeaderState } from "../src/ui/keymap"
import { buildBindings, parseAction, parseKeybindings } from "../src/extensions/keybindings"
import { normalizeTuiProfile, tuiProfilePath } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

const asReply = (reply: unknown) => reply as CommandReply

describe("breakpoints (spec section 52)", () => {
  test("compact below 70, normal 70-109, wide 110-149, xl from 150", () => {
    const at = (widths: number[]) => widths.map(breakpointOf)
    expect(at([1, 69])).toEqual(["compact", "compact"])
    expect(at([70, 109])).toEqual(["normal", "normal"])
    expect(at([110, 149])).toEqual(["wide", "wide"])
    expect(at([150, 240])).toEqual(["xl", "xl"])
    expect(BREAKPOINTS).toEqual({ normal: 70, wide: 110, xl: 150 })
  })

  test("the predicates agree with the classes at every edge", () => {
    expect([69, 70].map(isCompact)).toEqual([true, false])
    expect([109, 110].map(isWide)).toEqual([false, true])
    expect([149, 150].map(isXl)).toEqual([false, true])
    expect(isWide(150)).toBe(true)
    expect(PET_MIN_WIDTH).toBe(80)
  })

  test("no page keeps a breakpoint of its own for the wide layout (they ask ui/breakpoints)", async () => {
    const dir = path.join(import.meta.dir, "../src/view")
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = await Bun.file(path.join(dir, file)).text()
      expect(source, file).not.toMatch(/WIDE_WIDTH\s*=\s*120/)
      expect(source, file).not.toMatch(/width >= 120\b/)
      expect(source, file).not.toMatch(/inner >= WIDE/)
    }
  })
})

describe("sidebar visibility", () => {
  const shown = (mode: "auto" | "always" | "hidden", width: number, over: { minimal?: boolean } = {}) => sidebarVisible({ mode, width, minimal: false, ...over })

  test("auto and always show the left sessions from 110 columns, hidden never", () => {
    expect([100, 120, 149, 150, 160].map((width) => shown("auto", width))).toEqual([false, true, true, true, true])
    expect([80, 109, 110, 120, 160].map((width) => shown("always", width))).toEqual([false, false, true, true, true])
    expect([120, 160, 240].map((width) => shown("hidden", width))).toEqual([false, false, false])
  })

  test("the minimal view never shows it, whatever the mode", () => {
    expect(shown("always", 200, { minimal: true })).toBe(false)
  })

  test("the chat keeps at least the normal width wherever the sidebar can show", () => {
    expect(chatColumns(BREAKPOINTS.wide)).toBeGreaterThanOrEqual(BREAKPOINTS.normal)
    expect(chatColumns(160)).toBe(160 - SIDEBAR_WIDTH - SIDEBAR_GAP)
  })
})

describe("the sidebar's own rendering", () => {
  const glyphs = { barFull: "█", barEmpty: "░", queue: "…" }
  const full: SidebarInput = {
    height: 30,
    title: "Fix the flaky reconnect in the daemon client so a suspended laptop does not drop its queue",
    context: { tokens: 84_000, limit: 160_000 },
    todos: [
      { text: "write the failing test", status: "done" },
      { text: "fix the reconnect", status: "in_progress" },
      { text: "ship it", status: "pending" },
    ],
    changes: [
      { path: "packages/client/src/client.ts", status: "modified", additions: 12, deletions: 3 },
      { path: "apps/cli/test/reconnect.test.ts", status: "added", additions: 40, deletions: 0 },
      { path: "old.ts", status: "deleted", additions: 0, deletions: 9 },
    ],
    mcp: [
      { name: "github", state: "running", enabled: true, tools: 14 },
      { name: "linear", state: "failed", enabled: true, tools: 0 },
      { name: "zed", state: "stopped", enabled: false, tools: 0 },
    ],
    queue: ["run the whole suite again", "then commit"],
    glyphs,
  }
  const text = (input: SidebarInput) => renderSidebar(input).map(plain).join("\n")

  test("shows title, context, todos, changed files, MCP servers and the queue", () => {
    const rows = text(full)
    expect(rows).toContain("Fix the flaky reconnect")
    expect(rows).toMatch(/Context\s+53%/)
    expect(rows).toContain("84K of 160K tokens")
    expect(rows).toMatch(/Todos\s+2 open/)
    expect(rows).toContain("✓ write the failing test")
    expect(rows).toContain("▸ fix the reconnect")
    expect(rows).toMatch(/Changes\s+3 files · \+52 -12/)
    expect(rows).toMatch(/M .*client\.ts\s+\+12 -3/)
    expect(rows).toMatch(/A .*econnect\.test\.ts\s+\+40 -0/)
    expect(rows).toMatch(/D old\.ts\s+\+0 -9/)
    expect(rows).toMatch(/MCP\s+1\/3/)
    expect(rows).toMatch(/● github\s+14 tools/)
    expect(rows).toMatch(/! linear\s+failed/)
    expect(rows).toMatch(/○ zed\s+off/)
    expect(rows).toMatch(/Queue\s+2/)
    expect(rows).toContain("… run the whole suite again")
  })

  test("is exactly the height asked for, SIDEBAR_WIDTH wide, on the panel fill", () => {
    for (const height of [1, 4, 10, 20, 30, 60]) {
      const rows = renderSidebar({ ...full, height })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(plain(row))).toBe(SIDEBAR_WIDTH)
      expect(rows.flatMap((row) => row.filter((span) => span.text.trim())).every((span) => span.bg === "panel")).toBe(true)
    }
  })

  test("a short sidebar drops the later sections whole instead of cutting a heading off", () => {
    const rows = text({ ...full, height: 14 })
    expect(rows).toContain("Todos")
    expect(rows).not.toContain("Queue")
    for (const heading of ["Todos", "Changes", "MCP", "Queue"]) if (rows.includes(heading)) expect(rows.split("\n").some((row) => row.trimStart().startsWith(`${heading} `) || row.trim() === heading)).toBe(true)
  })

  test("long lists end with +N more", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ path: `src/file-${index}.ts`, status: "modified" as const, additions: 1, deletions: 1 }))
    const rows = text({ ...full, changes: many, height: 60 })
    expect(rows).toMatch(/Changes\s+20 files/)
    expect(rows).toContain("+15 more")
  })

  test("sections with nothing in them are left out, and a pressure colour follows the context", () => {
    const rows = text({ ...full, todos: [], changes: [], mcp: undefined, queue: [] })
    for (const heading of ["Todos", "Changes", "MCP", "Queue"]) expect(rows).not.toContain(heading)
    const hot = renderSidebar({ ...full, context: { tokens: 150_000, limit: 160_000 } }).flat()
    expect(hot.find((span) => span.text.startsWith("█"))).toMatchObject({ fg: "error" })
    const calm = renderSidebar({ ...full, context: { tokens: 20_000, limit: 160_000 } }).flat()
    expect(calm.find((span) => span.text.startsWith("█"))).toMatchObject({ fg: "success" })
  })

  test("attachSidebar pads every chat row to the chat column, then the gap, then the sidebar", () => {
    const joined = attachSidebar([[{ text: "short" }], [{ text: "x".repeat(200) }]], renderSidebar({ ...full, height: 3 }), 100)
    expect(joined).toHaveLength(3)
    for (const row of joined) expect(textWidth(plain(row))).toBe(100 + SIDEBAR_GAP + SIDEBAR_WIDTH)
  })
})

describe("the sidebar in the app", () => {
  const files = [
    { path: "packages/client/src/client.ts", status: "modified", additions: 12, deletions: 3, binary: false, diff: "", truncated: false },
    { path: "notes.md", status: "untracked", additions: 4, deletions: 0, binary: false, diff: "", truncated: false },
  ]

  function sessionApp(options: { width: number; dataDir?: string; mode?: "minimal" | "balanced" | "full"; blocks?: boolean }) {
    const dataDir = options.dataDir
    const h = appHarness({
      width: options.width,
      height: 36,
      directory: "/work/app",
      ...(dataDir ? { dataDir } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      reply: (command) => {
        if (command.type === "session.list") return asReply({ ok: true, result: { sessions: [{ sessionId: h.sessionId, directory: "/work/app", title: "Reconnect", createdAt: 0, updatedAt: 0, lastSeq: 0, state: "idle", queued: 0 }] } })
        if (command.type === "changes.query") return asReply({ ok: true, result: { root: "/work/app", files, omittedFiles: 0 } })
        if (command.type === "mcp.status") return asReply({ ok: true, result: { servers: [{ name: "github", command: "gh-mcp", enabled: true, state: "running", tools: 14, stderr: [] }], issues: [] } })
        return undefined
      },
    })
    if (options.blocks !== false) {
      const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
      chat.exchange("fix the reconnect", "done, the client now resumes")
      const turnId = ids("turn")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      const itemId = ids("item")
      chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "todo" } })
      chat.emit({ type: "item.completed", itemId, status: "ok", text: "[~] fix the reconnect\n[ ] ship it" })
      chat.emit({ type: "usage.recorded", turnId, provider: "codex", model: "gpt-6-luna", input: 40_000, output: 4_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
      chat.emit({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "run the suite", attachments: 0 }] })
      chat.emit({ type: "turn.completed", turnId })
    }
    h.app.applySettings({} as never)
    h.app.render()
    return h
  }
  const beside = (rows: string[]) => rows.map((row) => row.slice(0, SIDEBAR_WIDTH))

  test("at 160 columns auto shows it beside the chat: every row is exactly 160 cells and the chat keeps 121", async () => {
    const h = sessionApp({ width: 160 })
    await Bun.sleep(5)
    h.app.render()
    const frame = h.frames.at(-1)!
    expect(frame.length).toBe(36)
    for (const row of frame) expect(textWidth(plain(row))).toBe(160)
    const side = beside(h.text()).join("\n")
    expect(side).toContain("Sessions")
    expect(side).toContain("Reconnect")
    expect(side).not.toContain("Context")
    expect(h.sentOf("mcp.status")).toHaveLength(0)
    // The prompt and the transcript stay in the chat column.
    const chat = h.text().map((row) => row.slice(SIDEBAR_WIDTH + SIDEBAR_GAP)).join("\n")
    expect(chat).toContain("fix the reconnect")
    expect(chat).toContain("done, the client now resumes")
    expect(side).not.toContain("done, the client now resumes")
  })

  test("at 100 columns auto leaves it out and the chat uses the whole width", () => {
    const h = sessionApp({ width: 100 })
    for (const row of h.frames.at(-1)!) expect(textWidth(plain(row))).toBeLessThanOrEqual(120)
    expect(h.text().join("\n")).not.toContain("Changes")
    expect(h.text().join("\n")).not.toMatch(/Context\s+\d+%/)
  })

  test("/sidebar always shows it from 110 columns, hidden removes it; the choice is this session's and the profile is not written", async () => {
    const dataDir = tempDir()
    const h = sessionApp({ width: 120, dataDir })
    await h.type("/sidebar always\r")
    let frame = h.frames.at(-1)!
    for (const row of frame) expect(textWidth(plain(row))).toBe(120)
    expect(h.text().join("\n")).toContain("Sessions")
    expect(h.app.accessibility.profile.sidebar).toBe("always")
    expect(existsSync(tuiProfilePath(dataDir))).toBe(false)
    // The chat column is 81 wide: the prompt's closing rule ends where the sidebar begins.
    expect(h.text().some((row) => row.slice(SIDEBAR_WIDTH + SIDEBAR_GAP).startsWith(`  ${"─".repeat(chatColumns(120) - 4)}`))).toBe(true)
    await h.type("/sidebar hidden\r")
    expect(h.text().join("\n")).not.toContain("Sessions")
    expect(h.app.accessibility.profile.sidebar).toBe("hidden")
    await h.type("/sidebar auto\r")
    frame = h.frames.at(-1)!
    expect(h.text().join("\n")).toContain("Sessions")
    expect(h.app.accessibility.profile.sidebar).toBe("auto")
    expect(existsSync(tuiProfilePath(dataDir))).toBe(false)
  })

  test("the key toggles it: hides a visible sidebar, shows a hidden one (always below 150, auto from 150)", async () => {
    const dataDir = tempDir()
    const wide = sessionApp({ width: 160, dataDir })
    const saved = () => wide.app.accessibility.profile.sidebar
    await wide.type("\x18b")
    expect(saved()).toBe("hidden")
    expect(wide.text().join("\n")).not.toContain("Sessions")
    await wide.type("\x18b")
    expect(saved()).toBe("auto")
    expect(wide.text().join("\n")).toContain("Sessions")
    const normal = sessionApp({ width: 120, dataDir: tempDir() })
    await normal.type("\x18b")
    expect(normal.text().join("\n")).not.toContain("Sessions")
    await normal.type("\x18b")
    expect(normal.text().join("\n")).toContain("Sessions")
  })

  test("below 110 columns there is no room: it says so and keeps the mode", async () => {
    const dataDir = tempDir()
    const h = sessionApp({ width: 100, dataDir })
    await h.type("\x18b")
    expect(h.text().join("\n")).toContain("the sidebar needs 110 columns")
    expect(existsSync(tuiProfilePath(dataDir))).toBe(false)
  })

  test("a bad mode is a usage notice", async () => {
    const h = sessionApp({ width: 160 })
    await h.type("/sidebar left\r")
    expect(h.text().join("\n")).toContain("usage: /sidebar [auto | always | hidden]")
  })

  test("the minimal view and a session with nothing in it have none", async () => {
    const minimal = sessionApp({ width: 160, mode: "minimal" })
    expect(minimal.text().join("\n")).not.toMatch(/Changes\s+2 files/)
    const empty = sessionApp({ width: 160, blocks: false })
    expect(empty.text().join("\n")).not.toMatch(/Changes\s+2 files/)
  })

  test("scrolling and jumping use the chat column's width, not the screen's", async () => {
    const h = appHarness({ width: 160, height: 30 })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    for (let n = 1; n <= 40; n++) chat.exchange(`question ${n}`, `answer ${n}`)
    await h.app.onKey("\x1b[H")
    expect(h.text().some((row) => /question 1\s/.test(`${row} `) && !row.includes("question 10"))).toBe(true)
    await h.app.onKey("\x1b[F")
    expect(h.text().join("\n")).toContain("answer 40")
  })
})

describe("keys and the profile for the session UI", () => {
  test("the leader chords: v1's r, g and x, z for undo (v1's u is usage here), b for the sidebar, s for the scratch note", () => {
    const pick = (key: string) => {
      const state: LeaderState = {}
      resolveKey(state, LEADER_KEY, 0)
      return resolveKey(state, key, 1)
    }
    expect(pick("z")).toEqual({ kind: "action", action: "message.undo" })
    expect(pick("r")).toEqual({ kind: "action", action: "message.redo" })
    expect(pick("g")).toEqual({ kind: "action", action: "session.timeline" })
    expect(pick("x")).toEqual({ kind: "action", action: "session.export" })
    expect(pick("b")).toEqual({ kind: "action", action: "sidebar.toggle" })
    expect(pick("s")).toEqual({ kind: "action", action: "scratch.edit" })
    expect(pick("U")).toEqual({ kind: "action", action: "usage" })
  })

  test("every new action is bindable from keybindings.json and listed in the help", () => {
    for (const action of ["message.undo", "message.redo", "session.timeline", "session.export", "sidebar.toggle", "scratch.edit"] as const) {
      expect(KEY_ACTIONS).toContain(action)
      expect(parseAction(action)).toBe(action)
      expect(ACTION_LABEL[action]).toBeTruthy()
    }
    const file = parseKeybindings(JSON.stringify({ "ctrl+g": "session.timeline", "leader+w": "message.undo", f5: "sidebar.toggle" }))
    expect(file.problems).toEqual([])
    const built = buildBindings({ file: file.entries })
    expect(built.problems).toEqual([])
    expect(built.bindings.direct.get("\x07")).toEqual({ action: "session.timeline" })
    expect(built.bindings.leader.get("w")).toEqual({ action: "message.undo" })
    const help = keymapHelp().map((row) => row.keys)
    expect(help).toContain("ctrl+x z")
    expect(help).toContain("ctrl+x b")
  })

  test("the profile keeps a valid sidebar mode and falls back to auto for anything else", () => {
    expect(normalizeTuiProfile({}).sidebar).toBe("auto")
    for (const mode of ["auto", "always", "hidden"]) expect(normalizeTuiProfile({ sidebar: mode }).sidebar).toBe(mode)
    for (const bad of ["left", 1, null, true]) expect(normalizeTuiProfile({ sidebar: bad }).sidebar).toBe("auto")
  })

  test("a click on the sidebar does not reach the chat column's popups", async () => {
    const h = appHarness({ width: 160, height: 36 })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("hello", "hi")
    await h.type("/s")
    const before = h.app.editor.text
    // A left click inside the left sidebar on every row.
    for (let row = 1; row <= 36; row++) await h.app.onKey(`\x1b[<0;10;${row}M`)
    expect(h.app.editor.text).toBe(before)
    expect(h.sent.some((command) => command.type === "session.create")).toBe(false)
  })
})
