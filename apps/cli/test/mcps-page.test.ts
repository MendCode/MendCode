import { describe, expect, test } from "bun:test"
import type { McpServerStatus, McpStatusReport } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createMcpsPageState, mcpsPageKey, renderMcpsPage, type McpsPageState } from "../src/view/mcps-page"
import { textWidth } from "../src/view/wrap"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))

function server(name: string, patch: Partial<McpServerStatus> = {}): McpServerStatus {
  return { name, command: `npx -y @scope/${name}-server`, enabled: true, state: "running", pid: 4000 + name.length, tools: 3, stderr: [], ...patch }
}

const SERVERS: McpServerStatus[] = [
  server("demo", { stderr: ["listening on stdio", "loaded 3 tools"] }),
  server("stopped-one", { state: "stopped", pid: undefined, tools: 0 } as Partial<McpServerStatus>),
  server("broken", { state: "failed", tools: 0, pid: undefined, lastError: 'MCP server "broken" exited (code 3): bad config file, cannot continue', stderr: ["bad config", "fatal: cannot open /etc/x.json"] } as Partial<McpServerStatus>),
  server("warming", { state: "starting", tools: 0 }),
  server("off", { enabled: false, state: "stopped", tools: 0 }),
]
const report = (servers = SERVERS, issues: McpStatusReport["issues"] = []): McpStatusReport => ({ servers, issues })
const render = (state: McpsPageState, width = 100, height = 24, value = report()) => renderMcpsPage({ report: value, state, width, height })

const press = (state: McpsPageState, ...keys: string[]) => {
  let current = state
  let action: ReturnType<typeof mcpsPageKey>["action"] = { type: "none" }
  for (const key of keys) ({ state: current, action } = mcpsPageKey(current, key, SERVERS))
  return { state: current, action }
}

describe("mcps page rendering", () => {
  test("pending approval replaces runtime state and restart/catalog hints", () => {
    const pending: McpServerStatus = { name: "integration", command: "pending approval", enabled: false, state: "stopped", tools: 0, stderr: [], pending: { revision: "fixture", scope: "project", expiresAt: 100_000_000, details: ['command: "fixture"'] } }
    const lines = plain(render(createMcpsPageState(), 100, 24, report([pending])))
    expect(lines[0]).toContain("a approve · x reject")
    expect(lines[0]).not.toContain("r restart")
    const row = lines.find((line) => line.includes("integration"))!
    expect(row.split("│")[1]!.match(/pending approval/g)).toHaveLength(1)
  })
  test("lists every server with a colored state dot, command, tools and pid", () => {
    const lines = render(createMcpsPageState())
    const text = plain(lines).join("\n")
    expect(text).not.toContain("MENDCODE")
    expect(text).toContain("demo")
    expect(text).toContain("stopped-one")
    expect(text).toContain("broken")
    expect(text).toContain("warming")
    expect(text).toContain("off")
    const dots = lines.flatMap((line) => line.filter((span) => span.text.startsWith("●")).map((span) => span.fg))
    expect(dots).toContain("success")
    expect(dots).toContain("error")
    expect(dots).toContain("warning")
  })
  test("marks the selected server and shows its error and stderr tail below", () => {
    const text = plain(render({ selected: 2 })).join("\n")
    expect(text).toContain("broken")
    expect(text).toContain("failed")
    expect(text).toContain("exited (code 3)")
  })
  test("a healthy server with no output says so; a stopped one explains lazy start", () => {
    expect(plain(render({ selected: 1 })).join("\n")).toContain("starts on first MCP request")
    expect(plain(render({ selected: 4 })).join("\n")).toContain("disabled")
  })
  test("empty state explains how to add a server, with an example", () => {
    const text = plain(render(createMcpsPageState(), 100, 20, report([]))).join("\n")
    expect(text).toContain("no MCP servers · add .mendcode/mcp.json")
    expect(text).toContain('"command": "npx"')
  })
  test("config issues are listed", () => {
    const text = plain(render(createMcpsPageState(), 100, 24, report(SERVERS, [{ source: "mcp.json", server: "bad", message: "invalid server config: command: too small" }]))).join("\n")
    expect(text).toContain("bad:")
    expect(text).toContain("invalid server config")
    const empty = plain(render(createMcpsPageState(), 100, 24, report([], [{ source: "mcp.json", message: "invalid JSON" }]))).join("\n")
    expect(empty).toContain("invalid JSON")
  })
  test("header holds hints above bordered panels, with summary and failure status on its second row", () => {
    const lines = render(createMcpsPageState())
    const title = plain(lines)[0]!
    expect(title.trimStart()).toStartWith("MCPs · servers")
    expect(title).toContain("x catalog · esc back")
    expect(plain(lines)[1]!.trimEnd()).toEndWith("1 of 5 running · 1 failed")
    expect(title).not.toContain("LIVE")
    expect(lines[1]!.find((span) => span.text === "1 failed")).toMatchObject({ fg: "error", bold: true })
    expect(plain(lines)[3]).toContain("┌─ Servers")
    expect(plain(lines).at(-1)).toContain("└")
  })
  test("healthy servers show no status, starting ones a warning", () => {
    const healthy = plain(render(createMcpsPageState(), 100, 24, report([server("a"), server("b")])))[1]!
    expect(healthy.trimEnd()).toEndWith("2 of 2 running")
    const starting = render(createMcpsPageState(), 100, 24, report([server("a"), server("b", { state: "starting" })]))
    expect(starting[1]!.find((span) => span.text === "1 starting")).toMatchObject({ fg: "warning", bold: true })
  })
  test("single-line panel borders remain visible at compact and wide sizes", () => {
    for (const width of [60, 120]) expect(plain(render(createMcpsPageState(), width, 40)).join("")).toMatch(/[┌┐└┘│]/)
  })
  test("side by side from 120x24: the list and the detail share rows", () => {
    const rows = plain(render({ selected: 2 }, 120, 40))
    expect(rows.find((line) => line.includes("❯"))).toContain("broken")
    expect(rows.find((line) => line.includes("broken · failed"))).toContain("demo")
    expect(rows.find((line) => line.includes("exited (code 3)"))).toContain("●")
  })
  test("a long list keeps the selection visible and says which part is shown", () => {
    const many = Array.from({ length: 30 }, (_, i) => server(`srv${String(i).padStart(2, "0")}`))
    const lines = plain(render({ selected: 25 }, 80, 24, report(many)))
    expect(lines.join("\n")).toContain("srv25")
    expect(lines[1]).toContain("shown")
    expect(lines.find((line) => line.includes("❯"))).toContain("srv25")
  })
  test("exact width x height at 60x20, 80x30, 120x40 and 160x50", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
      for (const value of [report(), report([]), report(SERVERS, [{ source: "mcp.json", server: "bad", message: "invalid server config" }])]) {
        const lines = render({ selected: 0 }, width, height, value)
        expect(lines).toHaveLength(height)
        for (const line of plain(lines)) expect(textWidth(line)).toBe(width)
      }
    }
  })
  test("exact height and no overflow at various sizes", () => {
    for (const width of [60, 90, 120, 160]) {
      for (const height of [20, 35, 50]) {
        const lines = render({ selected: 0 }, width, height, report())
        expect(lines).toHaveLength(height)
        for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })
  test("selected server stays visible in render output", () => {
    const lines = render({ selected: 2 }, 120, 35, report())
    const text = plain(lines).join("\n")
    expect(text).toContain("broken")
    // The marker glyph ❯ indicates the selected row
    expect(text).toContain("❯")
  })
})

describe("mcps page keys", () => {
  test("arrows and j/k move the selection within bounds", () => {
    expect(press(createMcpsPageState(), "\x1b[B").state.selected).toBe(1)
    expect(press(createMcpsPageState(), "j", "j", "\x1b[A").state.selected).toBe(1)
    expect(press(createMcpsPageState(), "\x1b[A").state.selected).toBe(0)
    expect(press(createMcpsPageState(), ...Array(20).fill("\x1b[B")).state.selected).toBe(SERVERS.length - 1)
    const state = createMcpsPageState()
    expect(mcpsPageKey(state, "\x1b[A", SERVERS).state).toBe(state)
  })
  test("r restarts the selected server, but not a disabled one", () => {
    expect(press(createMcpsPageState(), "j", "r").action).toEqual({ type: "restart", server: "stopped-one" })
    expect(press(createMcpsPageState(), "j", "j", "j", "j", "r").action).toEqual({ type: "none" })
    expect(mcpsPageKey(createMcpsPageState(), "r", []).action).toEqual({ type: "none" })
  })
  test("escape and q close; other keys do nothing", () => {
    expect(press(createMcpsPageState(), "\x1b").action).toEqual({ type: "close" })
    expect(press(createMcpsPageState(), "q").action).toEqual({ type: "close" })
    expect(press(createMcpsPageState(), "z").action).toEqual({ type: "none" })
  })
})
