import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import {
  AGENTS_LIMITS,
  agentsPageKey,
  busySessions,
  createAgentsPageState,
  formatElapsed,
  renderAgentsPage,
  type AgentSession,
  type AgentShell,
  type AgentsPageState,
} from "../src/view/agents-page"
import { textWidth } from "../src/view/wrap"

const NOW = 1_800_000_000_000
const SEC = 1000
const MIN = 60 * SEC

function session(id: string, over: Partial<AgentSession> = {}): AgentSession {
  return { sessionId: id, title: `session ${id}`, directory: "/Users/dev/Code/MendCodeV2", state: "generating", updatedAt: NOW - SEC, queued: 0, ...over }
}

const SESSIONS: AgentSession[] = [
  session("a", { title: "fix flaky reconnect", since: NOW - 3 * MIN - 5 * SEC, tool: "read: src/session.ts", queued: 2 }),
  session("b", { title: "review dream scheduler", state: "waiting_approval", since: NOW - 40 * SEC, pending: "Run command", directory: "/Users/dev/Code/repos/codeconfig" }),
  session("c", { title: "release notes", state: "tool", since: NOW - 10 * MIN, tool: "shell: bun test" }),
  session("d", { title: "held queue", state: "queued", queued: 3 }),
  session("e", { title: "done", state: "idle" }),
  session("f", { title: "broken", state: "error" }),
]

const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)
const render = (over: Partial<Parameters<typeof renderAgentsPage>[0]> = {}) =>
  renderAgentsPage({ sessions: SESSIONS, state: createAgentsPageState(), width: 100, height: 30, now: NOW, ...over })
const titleRow = (lines: Line[]) => lines[1]!
const tabsRow = (lines: Line[]) => lines[2]!
const SHELLS: AgentShell[] = [
  { id: "s1", sessionId: "a", command: "bun run dev --watch", startedAt: NOW - 4 * MIN - 12 * SEC, status: "running" },
  { id: "s2", sessionId: "c", command: "bun test --coverage", startedAt: NOW - 9 * MIN, endedAt: NOW - 8 * MIN, status: "exited", exitCode: 0 },
  { id: "s3", sessionId: "c", command: "cargo build --release", startedAt: NOW - 30 * MIN, endedAt: NOW - 25 * MIN, status: "exited", exitCode: 2 },
  { id: "s4", sessionId: "c", command: "sleep 100", startedAt: NOW - 20 * MIN, endedAt: NOW - 19 * MIN, status: "killed" },
]

describe("busySessions", () => {
  test("drops idle and error sessions and puts approvals first, then the longest running", () => {
    expect(busySessions(SESSIONS).map((s) => s.sessionId)).toEqual(["b", "c", "a", "d"])
  })
  test("is stable for equal ranks", () => {
    const twin = [session("y", { updatedAt: 5 }), session("x", { updatedAt: 5 })]
    expect(busySessions(twin).map((s) => s.sessionId)).toEqual(["x", "y"])
  })
})

describe("formatElapsed", () => {
  test("boundaries", () => {
    expect(formatElapsed(-5)).toBe("0s")
    expect(formatElapsed(59_999)).toBe("59s")
    expect(formatElapsed(999)).toBe("0s")
    expect(formatElapsed(3_599_999)).toBe("59m 59s")
    expect(formatElapsed(86_400_000)).toBe("24h 00m")
    expect(formatElapsed(60_000)).toBe("1m 00s")
    expect(formatElapsed(3 * MIN + 5 * SEC)).toBe("3m 05s")
    expect(formatElapsed(60 * MIN)).toBe("1h 00m")
    expect(formatElapsed(3_600_000 + 61 * SEC)).toBe("1h 01m")
  })
})

describe("agentsPageKey", () => {
  const start = createAgentsPageState()
  test("down and up walk the busy rows in display order and clamp", () => {
    const one = agentsPageKey(start, "j", SESSIONS)
    expect(one.state.selected).toBe("c")
    expect(agentsPageKey(one.state, "\x1b[B", SESSIONS).state.selected).toBe("a")
    expect(agentsPageKey(one.state, "k", SESSIONS).state.selected).toBe("b")
    expect(agentsPageKey({ selected: "d" }, "j", SESSIONS).state.selected).toBe("d")
    expect(agentsPageKey(start, "k", SESSIONS).state).toBe(start)
    expect(agentsPageKey({ selected: "b" }, "\x0e", SESSIONS).state.selected).toBe("c")
  })
  test("the selection is the session id, so re-sorting does not move it", () => {
    const state: AgentsPageState = { selected: "a" }
    const reordered = [session("z", { state: "waiting_approval" }), ...SESSIONS]
    expect(agentsPageKey(state, "\r", reordered).action).toEqual({ type: "open", sessionId: "a" })
  })
  test("a selected session that is gone falls back to the first row", () => {
    expect(agentsPageKey({ selected: "gone" }, "\r", SESSIONS).action).toEqual({ type: "open", sessionId: "b" })
  })
  test("enter opens the selected session, nothing when the list is empty", () => {
    expect(agentsPageKey({ selected: "c" }, "\r", SESSIONS).action).toEqual({ type: "open", sessionId: "c" })
    expect(agentsPageKey(start, "\r", []).action).toEqual({ type: "none" })
  })
  test("a jumps to the selected approval, else the first one, else nothing", () => {
    expect(agentsPageKey({ selected: "b" }, "a", SESSIONS).action).toEqual({ type: "approval", sessionId: "b" })
    const jump = agentsPageKey({ selected: "c" }, "a", SESSIONS)
    expect(jump.action).toEqual({ type: "approval", sessionId: "b" })
    expect(jump.state.selected).toBe("b")
    expect(agentsPageKey(start, "a", SESSIONS.filter((s) => s.state !== "waiting_approval")).action).toEqual({ type: "none" })
  })
  test("tab and shift-tab flip between Running and Done and 1 and 2 jump, keeping the selection", () => {
    const done = agentsPageKey({ selected: "c" }, "\t", SESSIONS)
    expect(done.state).toEqual({ selected: "c", tab: 1 })
    expect(done.action).toEqual({ type: "none" })
    expect(agentsPageKey(done.state, "\t", SESSIONS).state).toEqual({ selected: "c", tab: 0 })
    expect(agentsPageKey(start, "\x1b[Z", SESSIONS).state.tab).toBe(1)
    expect(agentsPageKey(start, "2", SESSIONS).state.tab).toBe(1)
    expect(agentsPageKey(done.state, "1", SESSIONS).state.tab).toBe(0)
  })
  test("jumping to the tab already shown returns the same state object", () => {
    expect(agentsPageKey(start, "1", SESSIONS).state).toBe(start)
    const done = { tab: 1 }
    expect(agentsPageKey(done, "2", SESSIONS).state).toBe(done)
  })
  test("moving the selection keeps the tab, and select and open only act on the Running tab", () => {
    expect(agentsPageKey({ tab: 0 }, "j", SESSIONS).state).toEqual({ tab: 0, selected: "c" })
    const done = { tab: 1, selected: "b" }
    expect(agentsPageKey(done, "j", SESSIONS).state).toBe(done)
    expect(agentsPageKey(done, "\r", SESSIONS).action).toEqual({ type: "none" })
    expect(agentsPageKey(done, "a", SESSIONS).action).toEqual({ type: "approval", sessionId: "b" })
    expect(agentsPageKey(done, "\x1b", SESSIONS).action).toEqual({ type: "close" })
  })
  test("esc and q close; unknown keys do nothing", () => {
    expect(agentsPageKey(start, "\x1b", SESSIONS).action).toEqual({ type: "close" })
    expect(agentsPageKey(start, "q", []).action).toEqual({ type: "close" })
    expect(agentsPageKey(start, "z", SESSIONS).state).toBe(start)
  })
})

describe("renderAgentsPage", () => {
  test.each([
    [60, 20],
    [90, 35],
    [120, 40],
    [160, 50],
  ])("exact height and width bounds at %ix%i", (width, height) => {
    const subtasks = [{ itemId: "i1", title: "task: find every caller of createApp in the repository", latest: "grep: createApp" }]
    const shells: AgentShell[] = [{ id: "s1", sessionId: "a", command: "bun run dev --watch --port 3000", startedAt: NOW - 5 * MIN, status: "running" }]
    for (const selected of ["a", "b", "c", "d"]) {
      const lines = render({ width, height, state: { selected }, subtasks, shells, currentSessionId: "a", titles: { a: "fix flaky reconnect" } })
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
  })
  test.each([[60, 20], [80, 30], [120, 40], [160, 50]])("fills exactly %ix%i on both tabs, with and without content", (width, height) => {
    const subtasks = [{ itemId: "i1", title: "task: find every caller of createApp", latest: "grep: createApp" }]
    for (const tab of [0, 1]) {
      for (const over of [{ subtasks, shells: SHELLS }, { sessions: [] }]) {
        const lines = render({ width, height, state: { tab }, titles: { a: "fix flaky reconnect" }, ...over })
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(textWidth(text(line))).toBe(width)
      }
    }
  })
  test("empty state", () => {
    const lines = plain(render({ sessions: [SESSIONS[4]!] }))
    expect(lines[1]).toContain("Agents")
    expect(lines.some((line) => line.includes("nothing running"))).toBe(true)
    expect(lines).toHaveLength(30)
  })
  test("title row is 'Agents · N busy' with a bold warning status for approvals, no brand and no live dot", () => {
    const title = titleRow(render())
    expect(text(title).trim()).toStartWith("Agents · 4 busy")
    expect(text(title)).not.toContain("MENDCODE")
    expect(text(title)).not.toContain("●")
    expect(title.find((span) => span.text === "1 needs approval")).toMatchObject({ fg: "warning", bold: true })
    const calm = text(titleRow(render({ sessions: SESSIONS.filter((s) => s.state !== "waiting_approval") })))
    expect(calm).toContain("3 busy")
    expect(calm).not.toContain("approval")
  })
  test("summary counts the sub-agents and the running background shells", () => {
    const subtasks = [{ itemId: "i1", title: "task: a", latest: "x" }, { itemId: "i2", title: "task: b", latest: "y" }]
    expect(text(titleRow(render({ subtasks, shells: SHELLS })))).toContain("2 sub-agents · 1 background")
    expect(text(titleRow(render()))).not.toContain("background")
  })
  test("a rule follows the tabs and the footer keeps esc back and every key", () => {
    const rows = plain(render())
    expect(rows[3]!.trim()).toMatch(/^─+$/)
    const back = rows.findIndex((row) => row.trim() === "esc back")
    expect(back).toBeGreaterThan(4)
    const keys = rows.slice(back + 1).join("\n")
    for (const hint of ["select", "enter open", "a approval", "tab/1-2 tabs"]) expect(keys).toContain(hint)
  })
  test("tabs are Running and Done with the current one highlighted", () => {
    expect(text(tabsRow(render()))).toContain("1 Running")
    expect(text(tabsRow(render()))).toContain("2 Done")
    expect(tabsRow(render()).find((span) => span.bg === "element")?.text).toContain("Running")
    expect(tabsRow(render({ state: { tab: 1 } })).find((span) => span.bg === "element")?.text).toContain("Done")
  })
  test("no boxes; Running has titled sections, Done lists finished shells only", () => {
    const subtasks = [{ itemId: "i1", title: "task: find usages", latest: "grep: x" }]
    const running = plain(render({ subtasks, shells: SHELLS, titles: { c: "release notes" }, height: 40 }))
    expect(running.join("\n")).not.toMatch(/[┌┐└┘│]/)
    for (const title of ["Sessions", "Sub-agents", "Background"]) expect(running.some((line) => line.trim() === title)).toBe(true)
    expect(running.join("\n")).toContain("bun run dev --watch")
    expect(running.join("\n")).not.toContain("cargo build")
    const done = plain(render({ shells: SHELLS, titles: { c: "release notes" }, state: { tab: 1 } }))
    expect(done.join("\n")).not.toMatch(/[┌┐└┘│]/)
    expect(done.join("\n")).toContain("cargo build --release")
    expect(done.join("\n")).toContain("exit 2")
    expect(done.join("\n")).toContain("killed")
    expect(done.join("\n")).toContain("release notes")
    expect(done.join("\n")).not.toContain("bun run dev")
    expect(done.join("\n")).not.toContain("fix flaky reconnect")
  })
  test("Done says so when nothing finished, newest first otherwise", () => {
    expect(plain(render({ state: { tab: 1 } })).some((line) => line.includes("nothing finished yet"))).toBe(true)
    const rows = plain(render({ shells: SHELLS, state: { tab: 1 } }))
    const at = (needle: string) => rows.findIndex((line) => line.includes(needle))
    expect(at("bun test --coverage")).toBeLessThan(at("sleep 100"))
    expect(at("sleep 100")).toBeLessThan(at("cargo build"))
  })
  test("done shells show a success mark for a clean exit and are colored by outcome", () => {
    const rows = render({ shells: SHELLS, state: { tab: 1 } })
    const tone = (needle: string) => rows.find((row) => text(row).includes(needle))!.find((span) => /^exit |^killed$/.test(span.text))?.fg
    expect(tone("bun test")).toBe("success")
    expect(tone("cargo")).toBe("muted")
  })
  test("header counts busy sessions and those needing approval", () => {
    const lines = plain(render())
    expect(lines.some((line) => line.includes("4 busy"))).toBe(true)
    expect(lines.some((line) => line.includes("needs approval"))).toBe(true)
  })
  test("session rows show state, elapsed, project, tool and queued count", () => {
    const lines = plain(render({ state: { selected: "a" } }))
    expect(lines.some((line) => line.includes("fix flaky reconnect") && line.includes("working"))).toBe(true)
    expect(lines.some((line) => line.includes("3m"))).toBe(true)
    expect(lines.some((line) => line.includes("MendCodeV2") || line.includes("Code"))).toBe(true)
    expect(lines.some((line) => line.includes("read"))).toBe(true)
    expect(lines.some((line) => line.includes("+2"))).toBe(true)
  })
  test("a session waiting for approval is called out with its request", () => {
    const rows = render()
    expect(plain(rows).some((line) => line.includes("review dream scheduler") && line.includes("needs approval"))).toBe(true)
    expect(plain(rows).some((line) => line.includes("Run command"))).toBe(true)
    expect(rows.find((row) => text(row).includes("Run command"))?.find((s) => s.text === "Run command")).toMatchObject({ fg: "warning" })
  })
  test("queued sessions show their held queue and no elapsed time", () => {
    const lines = plain(render())
    expect(lines.some((line) => line.includes("held queue"))).toBe(true)
    expect(lines.some((line) => line.includes("+3 queued"))).toBe(true)
  })
  test("idle and error sessions are not listed", () => {
    const text = plain(render()).join("\n")
    expect(text).not.toContain("broken")
    expect(text).not.toMatch(/\bdone\b/)
  })
  test("the current session is marked and the pointer is on one row only", () => {
    const lines = plain(render({ currentSessionId: "c", state: { selected: "c" } }))
    const pointers = lines.filter((line) => line.includes("❯"))
    expect(pointers.length).toBeGreaterThanOrEqual(1)
    expect(pointers.some((line) => line.includes("(current)"))).toBe(true)
  })
  test("elapsed time follows the now argument", () => {
    const later = plain(render({ now: NOW + 55 * SEC, state: { selected: "a" } })).find((line) => line.includes("fix flaky"))!
    expect(later).toContain("4m")
  })
  test("sub-agents show their task and latest tool line", () => {
    const lines = plain(render({ subtasks: [{ itemId: "i1", title: "task: find usages of createApp", latest: "grep: createApp" }, { itemId: "i2", title: "task: check the docs", latest: "" }] }))
    expect(lines.some((line) => line.includes("find"))).toBe(true)
    expect(lines.some((line) => line.includes("grep"))).toBe(true)
    expect(lines.some((line) => line.includes("docs"))).toBe(true)
  })
  test("a sub-agent with a task record shows its model, usage and files on a second row", () => {
    const lines = plain(render({ subtasks: [{ itemId: "i1", title: "task: find usages", latest: "grep: createApp", facts: "GPT-6 Luna · 12.4K in · 1.2K out · 2 files" }] }))
    const at = lines.findIndex((line) => line.includes("find usages"))
    expect(lines[at + 1]).toContain("GPT-6 Luna · 12.4K in · 1.2K out · 2 files")
  })
  test("background shells show running time, exit status and the owning session", () => {
    const shells: AgentShell[] = [
      { id: "s1", sessionId: "a", command: "bun run dev", startedAt: NOW - 4 * MIN - 12 * SEC, status: "running" },
      { id: "s2", sessionId: "c", command: "bun test", startedAt: NOW - 9 * MIN, endedAt: NOW - 8 * MIN, status: "exited", exitCode: 0 },
      { id: "s3", sessionId: "c", command: "make", startedAt: NOW - 9 * MIN, endedAt: NOW - 8 * MIN, status: "exited", exitCode: 2 },
      { id: "s4", sessionId: "c", command: "sleep 100", startedAt: NOW - 9 * MIN, endedAt: NOW - 8 * MIN, status: "killed" },
    ]
    const lines = plain(render({ shells, titles: { a: "fix flaky reconnect", c: "release notes" }, height: 40 }))
    expect(lines.some((line) => line.includes("Background"))).toBe(true)
    expect(lines.some((line) => line.includes("bun"))).toBe(true)
  })
  test("every section is bounded and says how many are hidden", () => {
    const many = Array.from({ length: 30 }, (_, i) => session(`s${String(i).padStart(2, "0")}`, { since: NOW - i * SEC }))
    const subtasks = Array.from({ length: 10 }, (_, i) => ({ itemId: `i${i}`, title: `task: job ${i}`, latest: "x" }))
    const shells: AgentShell[] = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, sessionId: "s00", command: `cmd ${i}`, startedAt: NOW - i * SEC, status: "running" }))
    const lines = render({ sessions: many, subtasks, shells, height: 60 })
    expect(lines).toHaveLength(60)
    for (const line of lines) expect(textWidth(line.map((s) => s.text).join(""))).toBeLessThanOrEqual(100)
  })
  test("the window follows the selection and keeps it visible", () => {
    const many = Array.from({ length: 12 }, (_, i) => session(`s${String(i).padStart(2, "0")}`, { since: NOW - (100 - i) * SEC, title: `job ${i}` }))
    for (const target of ["s00", "s06", "s11"]) {
      const lines = plain(render({ sessions: many, state: { selected: target }, height: 25 }))
      const hasPointer = lines.some((line) => line.includes("❯") && line.includes(`job ${Number(target.slice(1))}`))
      expect(hasPointer).toBe(true)
    }
  })
  test("only sub-agents or shells still render when no session is busy", () => {
    const lines = plain(render({ sessions: [], subtasks: [{ itemId: "i", title: "task: x", latest: "y" }] }))
    expect(lines.some((line) => line.includes("no busy sessions"))).toBe(true)
    expect(lines.some((line) => line.trim() === "Sub-agents")).toBe(true)
  })
  test("colors: working is text, queued is muted, waiting is warning", () => {
    const rows = render()
    const getText = (haystack: string) => rows.find((row) => text(row).includes(haystack))
    const dot = (needle: string) => getText(needle)?.find((s) => s.text.trim() === "•")
    expect(dot("release notes")?.fg).toBe("text")
    expect(dot("held queue")?.fg).toBe("muted")
    expect(dot("review dream")?.fg).toBe("warning")
  })
})
