import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, type ExtensionsReport, type McpStatusReport, type ModelsReport, type StorageReport } from "@mendcode/protocol"
import { glyphs } from "../src/ui/theme"
import { createExtensionsPageState, extensionItems, extensionsPageKey, renderExtensionsPage } from "../src/view/extensions-page"
import { createStatusPageState, renderStatusPage, statusPageKey } from "../src/view/status-page"
import { textWidth } from "../src/view/wrap"
import { appHarness, extension, scratch } from "./extensions-harness"

const ids = createIdFactory()
const made: Array<ReturnType<typeof scratch>> = []
function layout() {
  const next = scratch()
  made.push(next)
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

const INFO = { engine: "codex", model: "gpt-6", effort: "high", dataDir: "/data/mend", pid: 4242, buildId: "abcdef0123456789", login: { ok: true } }
const MODELS: ModelsReport = {
  engine: "codex",
  selectable: true,
  models: [
    { id: "gpt-6", name: "GPT 6", efforts: [] },
    { id: "opus", name: "Opus", efforts: [], engine: "claude" },
  ],
  defaults: { model: "gpt-6" },
  roles: {},
  effective: { model: "gpt-6", effort: "high" },
}
const MCPS: McpStatusReport = {
  servers: [
    { name: "fs", command: "npx fs", enabled: true, state: "running", tools: 4, stderr: [] },
    { name: "db", command: "db-mcp", enabled: true, state: "failed", tools: 0, lastError: "spawn ENOENT", stderr: [] },
    { name: "old", command: "old", enabled: false, state: "stopped", tools: 0, stderr: [] },
  ],
  issues: [{ source: "mcp.json", message: "bad entry" }],
}
const STORAGE: StorageReport = { dbBytes: 5 * 1024 * 1024, walBytes: 1024 * 1024, blobBytes: 2 * 1024 * 1024, blobs: 3, orphanBlobs: 1, orphanBytes: 2048, sessions: 12, events: 900, eventBytes: 1, engineBytes: 1, otherBytes: 1, freeBytes: 0, autoVacuum: "none", topSessions: [] }
const EXTENSIONS: ExtensionsReport = {
  extensions: [
    { name: "notes", source: "user", file: "/data/extensions/notes.ts", daemon: true, tui: true, tools: ["note"], commands: ["n"], hooks: ["turn.completed", "tool.before"], errors: [], trusted: true },
    { name: "proj", source: "project", file: "/work/app/.mendcode/extensions/proj.ts", daemon: true, tui: false, tools: [], commands: [], hooks: [], errors: ["hook failed: boom"], trusted: false },
  ],
}

const daemon = (overrides: Record<string, unknown> = {}) => (command: Record<string, unknown>) => {
  const answers: Record<string, unknown> = { "daemon.info": INFO, "models.list": MODELS, "mcp.status": MCPS, "storage.report": STORAGE, "extensions.list": EXTENSIONS, "tools.trust": { tools: [], issues: [] }, ...overrides }
  const answer = answers[String(command.type)]
  return answer === undefined ? undefined : (answer as { ok?: boolean }).ok === false ? answer : { ok: true, result: answer }
}

async function status(options: { reply?: (command: Record<string, unknown>) => unknown; width?: number; height?: number } = {}) {
  const h = await appHarness({ width: options.width ?? 120, height: options.height ?? 50, version: "0.4.2", daemonBuildId: "0123456789ab", reply: options.reply ?? daemon() })
  await h.start({ onboarded: true })
  h.sent.length = 0
  await h.type("/status")
  await h.key("\r")
  await Bun.sleep(5)
  h.app.render()
  return h
}

describe("/status page", () => {
  test("shows the daemon, engines, session, MCP servers, extensions, storage and versions from the daemon's replies", async () => {
    const h = await status()
    expect(h.app.page).toBe("status")
    const text = h.text()
    for (const title of ["Daemon", "Engines", "This session", "MCP servers", "Language servers", "Extensions", "Storage", "Versions"]) expect(text).toContain(title)
    expect(text).toContain("daemon connected")
    expect(text).toMatch(/build\s+abcdef012345/)
    expect(text).toMatch(/pid\s+4242/)
    expect(text).toMatch(/daemon engine\s+codex · gpt-6 · high/)
    expect(text).toMatch(/claude code\s+available · 1 model/)
    expect(text).toMatch(/codex\s+active · login ok/)
    expect(text).toMatch(/native\s+not the active engine/)
    expect(text).toMatch(/model\s+gpt-6/)
    expect(text).toMatch(/effort\s+high/)
    expect(text).toMatch(/permission\s+ask before edits/)
    expect(text).toMatch(/fs\s+running · 4 tools/)
    expect(text).toMatch(/db\s+failed · 0 tools · spawn ENOENT/)
    expect(text).toMatch(/old\s+off · 0 tools/)
    expect(text).toMatch(/config issues\s+1/)
    expect(text).toMatch(/found\s+2/)
    expect(text).toMatch(/errors\s+1/)
    expect(text).toMatch(/not trusted\s+1/)
    expect(text).toMatch(/terminal\s+0 loaded/)
    expect(text).toMatch(/data dir\s+\/data\/mend/)
    expect(text).toMatch(/size\s+8\.0 MB/)
    expect(text).toMatch(/sessions\s+12/)
    expect(text).toMatch(/orphan blobs\s+1 · 2\.0 KB/)
    expect(text).toMatch(/terminal\s+v0\.4\.2/)
    expect(text).toMatch(/daemon build\s+abcdef012345/)
  })

  test("asks only the existing queries, once each, for the current project", async () => {
    const h = await status()
    const types = h.sent.map((command) => command.type)
    for (const type of ["daemon.info", "models.list", "mcp.status", "storage.report", "extensions.list"]) expect(types.filter((entry) => entry === type)).toHaveLength(1)
    expect(h.sent.find((command) => command.type === "extensions.list")).toMatchObject({ directory: "/work/app" })
    expect(h.sent.find((command) => command.type === "mcp.status")).toMatchObject({ directory: "/work/app" })
  })

  test("says unknown where no query exists or nothing answered: uptime, LSP, and everything when the daemon gives nothing", async () => {
    const h = await status({ reply: () => undefined })
    const text = h.text()
    expect(text).toMatch(/uptime\s+unknown/)
    expect(text).toMatch(/LSP\s+unknown/)
    expect(text).toMatch(/pid\s+unknown/)
    expect(text).toMatch(/daemon engine\s+unknown/)
    expect(text).toMatch(/claude code\s+unknown/)
    expect(text).toMatch(/servers\s+unknown/)
    expect(text).toMatch(/size\s+unknown/)
    // The handshake's build id and the terminal's own version are still known.
    expect(text).toMatch(/build\s+0123456789ab/)
    expect(text).toMatch(/terminal\s+v0\.4\.2/)
  })

  test("a failed query shows its message in place of the facts", async () => {
    const failure = { ok: false, error: { code: "internal", message: "daemon info broke" } }
    const h = await status({ reply: daemon({ "daemon.info": failure, "models.list": failure, "mcp.status": { ok: false, error: { code: "x", message: "mcp down" } }, "storage.report": { ok: false, error: { code: "invalid_command", message: "x" } } }) })
    const text = h.text()
    expect(text).toContain("daemon info broke")
    expect(text).toContain("mcp down")
    expect(text).toContain("the daemon is older than this terminal")
  })

  test("shows context use from the session's last usage, and the permission mode in effect", async () => {
    const h = await status()
    await h.key("\x1b")
    h.app.onEvent({ sessionId: h.sessionId, seq: 1, at: 0, type: "usage.recorded", turnId: ids("turn"), provider: "p", model: "gpt-6", input: 48_000, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as never)
    h.app.onEvent({ sessionId: h.sessionId, seq: 2, at: 0, type: "session.permission", mode: "full" } as never)
    await h.type("/status")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toMatch(/context\s+48k of 160k · 30%/)
    expect(h.text()).toMatch(/permission\s+full access/)
  })

  test("r asks again, esc closes", async () => {
    const h = await status()
    await h.key("r")
    await Bun.sleep(5)
    expect(h.sent.filter((command) => command.type === "daemon.info")).toHaveLength(2)
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("unit: two columns from 100 cells, stacked below, always exactly width x height", () => {
    const base = { state: createStatusPageState(), connected: true, info: INFO, models: MODELS, mcps: MCPS, extensions: EXTENSIONS, storage: STORAGE, terminalExtensions: { loaded: 1, problems: 2 }, session: { permission: "ask" as const, permissionLabel: "ask before edits", state: "ready" } }
    for (const [width, height] of [[40, 14], [80, 30], [99, 40], [100, 40], [200, 60]] as const) {
      const rows = renderStatusPage({ ...base, width, height })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
    }
    const wide = renderStatusPage({ ...base, width: 140, height: 40 }).map((row) => row.map((span) => span.text).join(""))
    expect(wide.some((row) => row.includes("Daemon") && row.includes("This session"))).toBe(true)
    const narrow = renderStatusPage({ ...base, width: 80, height: 60 }).map((row) => row.map((span) => span.text).join(""))
    expect(narrow.some((row) => row.includes("Daemon") && row.includes("This session"))).toBe(false)
  })

  test("unit: scrolling never passes the end, and the problems count is in the title", () => {
    const state = createStatusPageState()
    let next = state
    for (let i = 0; i < 100; i++) next = statusPageKey(next, "j").state
    const rows = renderStatusPage({ state: next, width: 80, height: 14, connected: false, terminalExtensions: { loaded: 0, problems: 0 }, session: { permission: "ask", permissionLabel: "ask before edits", state: "ready" } }).map((row) => row.map((span) => span.text).join(""))
    expect(rows.join("\n")).toContain("Versions")
    expect(rows[1]).toContain("1 problem")
    expect(statusPageKey(state, "k").state).toEqual(state)
    expect(statusPageKey(state, "x").state).toEqual(state)
  })
})

describe("/extensions page", () => {
  async function open(options: { reply?: (command: Record<string, unknown>) => unknown; dataDir?: string; directory?: string; width?: number; height?: number } = {}) {
    const h = await appHarness({ ...(options.dataDir ? { dataDir: options.dataDir } : {}), ...(options.directory ? { directory: options.directory } : {}), width: options.width ?? 120, height: options.height ?? 40, reply: options.reply ?? daemon() })
    await h.start({ onboarded: true })
    await h.type("/extensions")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    return h
  }

  test("lists what the daemon found: name, source, trust, halves, what it registered, and an error count", async () => {
    const h = await open()
    expect(h.app.page).toBe("extensions")
    expect(h.sent.find((command) => command.type === "extensions.list")).toEqual({ type: "extensions.list", directory: "/work/app" })
    const text = h.text()
    expect(text).toContain("Extensions")
    expect(text).toMatch(/1 tool · 1 command · 2 hooks/)
    expect(text).toMatch(/proj\s+project\s+not trusted/)
    expect(text).toContain("1 error")
    expect(text).toContain("2 found for this project")
  })

  test("enter opens a row: file, tools, commands, hooks and each error; enter again closes it", async () => {
    const h = await open()
    expect(h.text()).not.toContain("/data/extensions/notes.ts")
    await h.key("\r")
    expect(h.text()).toContain("file  /data/extensions/notes.ts")
    expect(h.text()).toContain("tools  note")
    expect(h.text()).toContain("commands  n")
    expect(h.text()).toContain("hooks  turn.completed, tool.before")
    await h.key("\r")
    expect(h.text()).not.toContain("/data/extensions/notes.ts")
    await h.key("j")
    await h.key("\r")
    expect(h.text()).toContain("hook failed: boom")
    expect(h.text()).toContain("not trusted: press t")
  })

  test("t trusts the project's extensions with the same tools.trust /tools sends, then lists again; t again stops", async () => {
    let trusted = false
    const reply = (command: Record<string, unknown>) => {
      if (command.type === "tools.trust") {
        trusted = command.trusted === true
        return { ok: true, result: { tools: [], issues: [] } }
      }
      if (command.type === "extensions.list") return { ok: true, result: { extensions: EXTENSIONS.extensions.map((info) => (info.source === "project" ? { ...info, trusted } : info)) } }
      return undefined
    }
    const h = await open({ reply })
    await h.key("t")
    const trust = h.sent.filter((command) => command.type === "tools.trust")
    expect(trust).toEqual([{ type: "tools.trust", directory: "/work/app", trusted: true }])
    expect(h.sent.filter((command) => command.type === "extensions.list")).toHaveLength(2)
    expect(h.text()).toMatch(/proj\s+project\s+trusted/)
    await h.key("t")
    expect(h.sent.filter((command) => command.type === "tools.trust").at(-1)).toEqual({ type: "tools.trust", directory: "/work/app", trusted: false })
    expect(h.text()).toMatch(/proj\s+project\s+not trusted/)
  })

  test("t does nothing when there are no project extensions", async () => {
    const h = await open({ reply: daemon({ "extensions.list": { extensions: [EXTENSIONS.extensions[0]] } }) })
    await h.key("t")
    expect(h.sent.filter((command) => command.type === "tools.trust")).toEqual([])
  })

  test("the terminal side: slots, keys, commands and pages each extension registered, and what failed to load", async () => {
    const { dataDir, write, project } = layout()
    write("data/extensions/mine.ts", extension("mine", `api.slot("welcome.below", () => [[{ text: "x" }]])\napi.key("ctrl+g", (actions) => actions.toast("hi"))\napi.command("hello", "Say hello", () => {})\napi.page("dash", { title: "Dash", render: () => [] })`))
    write("data/extensions/bad.ts", `export default { name: "bad", tui() { throw new Error("nope") } }\n`)
    const h = await open({ dataDir, directory: project, width: 140, reply: daemon({ "extensions.list": { extensions: [] } }) })
    await h.app.extensionsReady
    h.app.render()
    const text = h.text()
    expect(text).toContain("Terminal")
    expect(text).toMatch(/1 slot · 1 key · 1 command · 1 page/)
    await h.key("\r")
    expect(h.text()).toContain("slots  welcome.below")
    expect(h.text()).toContain("keys  ctrl+g")
    expect(h.text()).toContain("commands  /hello")
    expect(h.text()).toContain("pages  dash")
    expect(h.text()).toContain("Other problems")
    expect(h.text()).toContain("bad: tui() failed: nope")
  })

  test("a slot an error disabled says so", async () => {
    const { dataDir, write, project } = layout()
    write("data/extensions/flaky.ts", extension("flaky", `api.slot("welcome.below", () => { throw new Error("boom") })`))
    const h = await appHarness({ dataDir, directory: project, width: 140, height: 40, reply: daemon({ "extensions.list": { extensions: [] } }) })
    await h.start({ onboarded: true })
    h.app.render()
    await h.type("/extensions")
    await h.key("\r")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("welcome.below (disabled)")
    expect(h.text()).toMatch(/flaky\s+user/)
    expect(h.text()).toContain("slot welcome.below disabled: boom")
  })

  test("the daemon's error shows instead of a list; an empty project says how to add one", async () => {
    const failing = await open({ reply: daemon({ "extensions.list": { ok: false, error: { code: "invalid_command", message: "x" } } }) })
    expect(failing.text()).toContain("the daemon is older than this terminal")
    const empty = await open({ reply: daemon({ "extensions.list": { extensions: [] } }) })
    expect(empty.text()).toContain("no extensions found")
  })

  test("esc closes; r lists again", async () => {
    const h = await open()
    await h.key("r")
    await Bun.sleep(5)
    expect(h.sent.filter((command) => command.type === "extensions.list")).toHaveLength(2)
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("unit: keys move and clamp, enter toggles, and the page is exactly width x height", () => {
    const items = extensionItems(EXTENSIONS, [{ name: "t", slots: [], keys: [], commands: [], pages: [], renderers: [], transforms: 0, errors: [] }])
    expect(items.map((item) => item.key)).toEqual(["daemon:/data/extensions/notes.ts", "daemon:/work/app/.mendcode/extensions/proj.ts", "terminal:t"])
    let state = createExtensionsPageState()
    expect(extensionsPageKey(state, "k", items, EXTENSIONS).state).toBe(state)
    for (let i = 0; i < 9; i++) state = extensionsPageKey(state, "j", items, EXTENSIONS).state
    expect(state.selected).toBe(2)
    state = extensionsPageKey(state, "\r", items, EXTENSIONS).state
    expect(state.open).toEqual(["terminal:t"])
    expect(extensionsPageKey(state, "\r", items, EXTENSIONS).state.open).toEqual([])
    for (const [width, height] of [[40, 12], [80, 24], [120, 40], [200, 50]] as const) {
      const rows = renderExtensionsPage({ state: { selected: 0, open: items.map((item) => item.key) }, report: EXTENSIONS, terminal: [{ name: "t", slots: ["header.replace"], keys: [], commands: ["/x"], pages: [], renderers: [], transforms: 1, errors: ["bad"] }], terminalProblems: ["keybindings.json: bad key"], width, height, glyphs: glyphs({}) })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
    }
  })
})
