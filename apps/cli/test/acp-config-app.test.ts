import { expect, test } from "bun:test"
import { appHarness } from "./extensions-harness"
import { acpPageKey, createAcpPageState, renderAcpPage } from "../src/view/acp-page"
import { textWidth } from "../src/view/wrap"

const existing = { command: "existing", args: ["--acp"], envKeys: ["TOKEN"], env: { TOKEN: "secret-never-render" } }

const catalog = [
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], install: "pnpm add -g @google/gemini-cli", website: "https://geminicli.com", installed: true, configured: false },
  { id: "cline", name: "Cline", command: "cline", args: ["--acp"], install: "pnpm add -g cline", website: "https://cline.bot/cli", installed: false, configured: false },
  { id: "claude-code-acp", name: "Claude Agent", command: "claude-agent-acp", args: [], install: "pnpm add -g @agentclientprotocol/claude-agent-acp", website: "https://github.com/agentclientprotocol/claude-agent-acp", installed: false, configured: false },
]

test("ACP catalog picker adds one preset, refreshes PATH and never installs/authenticates", async () => {
  let added = false
  const h = await appHarness({ height: 34, reply: (c) => {
    if (c.type === "settings.get") return { ok: true, result: { settings: { tier: "full" } } }
    if (c.type === "acp.registry") {
      if (c.operation === "add") added = true
      return { ok: true, result: { agents: catalog.map((agent) => ({ ...agent, configured: agent.id === "cline" && added })), ...(added ? { settings: { tier: "full", acpAgents: { cline: { command: "cline", args: ["--acp"] } } } } : {}) } }
    }
  } })
  await h.start({ onboarded: true })
  await h.type("/acp")
  await h.key("\r")
  await h.key("c")
  expect(h.text()).toContain("offline catalog")
  expect(h.text()).toContain("Gemini CLI")
  expect(h.text()).toContain('Run: ["gemini","--acp"]')
  await h.key("j")
  expect(h.text()).toContain("Cline")
  expect(h.text()).toContain("missing")
  await h.key("\r")
  expect(h.sent.filter((c) => c.type === "acp.registry")).toEqual([{ type: "acp.registry", operation: "list" }, { type: "acp.registry", operation: "add", agentId: "cline" }])
  expect(h.text()).toContain("Already added")
  await h.key("\r") // configured entries cannot be overwritten
  expect(h.sent.filter((c) => c.type === "acp.registry")).toHaveLength(2)
  await h.key("r")
  expect(h.sent.filter((c) => c.type === "acp.registry")).toHaveLength(3)
  await h.key("\x1b")
  expect(h.text()).toContain("cline")
  expect(h.text()).not.toContain("offline catalog")
})

test("catalog failure preserves selection and supports retry/cancel", async () => {
  const h = await appHarness({ height: 34, reply: (c) => c.type === "settings.get" ? { ok: true, result: { settings: {} } } : c.type === "acp.registry" ? { ok: false, error: { message: "Enable ACP registry with /tier acp_registry on" } } : undefined })
  await h.start({ onboarded: true })
  await h.type("/acp")
  await h.key("\r")
  await h.key("c")
  expect(h.text()).toContain("/tier acp_registry on")
  await h.key("\x1b")
  expect(h.app.page).toBe("chat")
})

test("catalog renderer keeps details visible and bounded at terminal sizes", () => {
  for (const [width, height] of [[40, 18], [100, 30], [160, 40]] as const) {
    for (const [selected, agent] of catalog.entries()) {
      const rows = renderAcpPage({ state: { selected: 0, registry: { agents: catalog, selected } }, agents: {}, width, height })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
      const text = rows.flat().map((span) => span.text).join("\n")
      expect(text).toContain(agent.name)
      expect(text).toContain("Run:")
      expect(text).toContain("Sign in")
      const content = text.replace(/\s/g, "")
      expect(content).toContain(agent.install.replace(/\s/g, ""))
      expect(content).toContain(agent.website)
      expect(content).toContain(JSON.stringify([agent.command, ...agent.args]))
    }
  }
})

test("/acp adds, edits and removes via per-agent settings patches without rendering env values", async () => {
  const agents: Record<string, unknown> = { old: existing }
  const h = await appHarness({ height: 34, reply: (c) => {
    if (c.type === "settings.set") {
      const patch = (c.patch as { acpAgents: Record<string, unknown> }).acpAgents
      for (const [name, value] of Object.entries(patch)) if (value === null) delete agents[name]; else agents[name] = value
    }
    if (c.type === "settings.get" || c.type === "settings.set") return { ok: true, result: { settings: { acpAgents: { ...agents } } } }
  } })
  await h.start({ onboarded: true })
  await h.type("/acp")
  await h.key("\r")
  expect(h.text()).toContain("TOKEN")
  expect(h.frames.flat(2).map((span) => span.text).join("")).not.toContain("secret-never-render")
  await h.key("a")
  for (const text of ["new", "agent", '["--stdio"]', "API_KEY,OTHER_KEY"]) {
    // Args defaults to [] in the form.
    if (text.startsWith("[")) { await h.key("\x7f"); await h.key("\x7f") }
    await h.key(text)
    await h.key("\r")
  }
  await h.key("\r")
  expect(h.sent.filter((c) => c.type === "settings.set")[0]).toEqual({ type: "settings.set", patch: { acpAgents: { new: { command: "agent", args: ["--stdio"], envKeys: ["API_KEY", "OTHER_KEY"] } } } })
  expect(h.text()).toContain("new")
  // Sorted list selects the new agent; edit starts on command (name stays fixed).
  await h.key("e")
  for (let i = 0; i < 5; i++) await h.key("\x7f")
  await h.key("changed")
  await h.key("\r")
  await h.key("\r")
  await h.key("\r")
  await h.key("\r")
  expect(h.sent.filter((c) => c.type === "settings.set")[1]).toMatchObject({ patch: { acpAgents: { new: { command: "changed", args: ["--stdio"], envKeys: ["API_KEY", "OTHER_KEY"] } } } })
  await h.key("d")
  expect(h.text()).toContain("Remove new?")
  await h.key("y")
  expect(h.sent.filter((c) => c.type === "settings.set")[2]).toEqual({ type: "settings.set", patch: { acpAgents: { new: null } } })
  expect(h.text()).not.toContain("changed")
  expect(h.frames.flat(2).map((span) => span.text).join("")).not.toContain("secret-never-render")
})

test("ACP form validation, cancel and settings failures preserve the draft", async () => {
  const h = await appHarness({ reply: (c) => c.type === "settings.get" ? { ok: true, result: { settings: {} } } : c.type === "settings.set" ? { ok: false, error: { message: "config is read-only" } } : undefined })
  await h.start({ onboarded: true })
  await h.type("/acp")
  await h.key("\r")
  await h.key("a")
  for (let i = 0; i < 5; i++) await h.key("\r")
  expect(h.text()).toContain("invalid name")
  expect(h.sent.filter((c) => c.type === "settings.set")).toHaveLength(0)
  await h.key("\x1b")
  await h.key("a")
  await h.key("valid")
  await h.key("\r")
  await h.key("agent")
  for (let i = 0; i < 4; i++) await h.key("\r")
  expect(h.text()).toContain("config is read-only")
  expect(h.text()).toContain("name: valid")
  await h.key("\x1b")
  await h.key("\x1b")
  expect(h.app.page).toBe("chat")
})

test("ACP page renders bounded frames in list, form, empty, error and remove states", () => {
  const agents = { old: existing }
  const initial = createAcpPageState()
  const states = [initial, { ...initial, error: "cannot read config" }, acpPageKey(initial, "a", agents).state, acpPageKey(initial, "e", agents).state, acpPageKey(initial, "d", agents).state]
  for (const [width, height] of [[40, 18], [100, 30], [160, 40]]) {
    for (const state of states) {
      const rows = renderAcpPage({ state, agents, width: width!, height: height! })
      expect(rows).toHaveLength(height!)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width!)
      expect(rows.flat().map((span) => span.text).join("")).not.toContain("secret-never-render")
    }
  }
})
