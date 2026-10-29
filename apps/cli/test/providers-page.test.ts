import { describe, expect, test } from "bun:test"
import { createProvidersPageState, keyLabel, providersPageKey, renderProvidersPage, type ProvidersPageState } from "../src/view/providers-page"
import { textWidth } from "../src/view/wrap"
import { info, plain, providersHarness } from "./providers-harness"

const DOWN = "\x1b[B"

const anthropic = info("anthropic", { type: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyTail: "…3f2a", models: [{ id: "claude-sonnet-5-5", effort: true, images: true, context: 200_000 }, { id: "claude-haiku-4-5" }] })
const openrouter = info("openrouter", { source: "env", models: [] })
const corp = info("corp", { enabled: false, hasKey: false, error: "no API key: set apiKey or apiKeyEnv" })
const ollama = info("ollama", { hasKey: false, baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "llama3:8b" }] })
const LIST = [anthropic, openrouter, corp]

describe("providersPageKey", () => {
  const at = (selected: number): ProvidersPageState => ({ selected, detail: false })

  test("↑↓ select and stop at the ends", () => {
    const state = createProvidersPageState()
    expect(providersPageKey(state, "\x1b[A", LIST).state).toBe(state)
    expect(providersPageKey(state, DOWN, LIST).state.selected).toBe(1)
    expect(providersPageKey(at(2), DOWN, LIST).state.selected).toBe(2)
    expect(providersPageKey(state, "j", LIST).state.selected).toBe(1)
  })

  test("each action key sends its command for the selected provider", () => {
    expect(providersPageKey(at(0), "e", LIST).action).toEqual({ type: "toggle", provider: "anthropic", enabled: false })
    expect(providersPageKey(at(2), "e", LIST).action).toEqual({ type: "toggle", provider: "corp", enabled: true })
    expect(providersPageKey(at(1), "t", LIST).action).toEqual({ type: "test", provider: "openrouter" })
    expect(providersPageKey(at(1), "r", LIST).action).toEqual({ type: "refresh", provider: "openrouter" })
    expect(providersPageKey(at(0), "a", LIST).action).toEqual({ type: "connect" })
  })

  test("d asks first: y removes, n and esc cancel, other keys wait", () => {
    const asked = providersPageKey(at(1), "d", LIST)
    expect(asked.action).toEqual({ type: "none" })
    expect(asked.state.confirm).toBe("openrouter")
    expect(providersPageKey(asked.state, "x", LIST)).toEqual({ state: asked.state, action: { type: "none" } })
    expect(providersPageKey(asked.state, "t", LIST).action).toEqual({ type: "none" })
    expect(providersPageKey(asked.state, "y", LIST).action).toEqual({ type: "remove", provider: "openrouter" })
    expect(providersPageKey(asked.state, "y", LIST).state.confirm).toBeUndefined()
    for (const key of ["n", "\x1b"]) {
      const cancelled = providersPageKey(asked.state, key, LIST)
      expect(cancelled.action).toEqual({ type: "none" })
      expect(cancelled.state.confirm).toBeUndefined()
    }
  })

  test("enter opens and closes the details; esc closes them before the page", () => {
    const opened = providersPageKey(at(0), "\r", LIST).state
    expect(opened.detail).toBe(true)
    expect(providersPageKey(opened, "\x1b", LIST)).toEqual({ state: { selected: 0, detail: false }, action: { type: "none" } })
    expect(providersPageKey(at(0), "\x1b", LIST).action).toEqual({ type: "close" })
    expect(providersPageKey(at(0), "q", LIST).action).toEqual({ type: "close" })
  })

  test("with nothing listed only add and close work", () => {
    const state = createProvidersPageState()
    for (const key of ["e", "t", "r", "d", "\r"]) expect(providersPageKey(state, key, []).action).toEqual({ type: "none" })
    expect(providersPageKey(state, "a", []).action).toEqual({ type: "connect" })
    expect(providersPageKey(state, "\x1b", []).action).toEqual({ type: "close" })
  })
})

describe("renderProvidersPage", () => {
  const lines = (over: Partial<Parameters<typeof renderProvidersPage>[0]> = {}) => renderProvidersPage({ state: createProvidersPageState(), providers: LIST, width: 100, height: 28, ...over }).map(plain)

  test("each row shows name, type, source, key tail, on/off, model count and the last error", () => {
    const out = lines()
    expect(out[1]).toContain("Providers · API keys")
    expect(out[1]).toContain("2 of 3 on")
    expect(out[1]).toContain("1 needs attention")
    expect(out.find((l) => l.includes("provider") && l.includes("models"))).toMatch(/provider\s+type\s+source\s+key\s+on\s+models/)
    expect(out.find((l) => l.includes("Anthropic"))).toMatch(/❯ Anthropic\s+anthropic\s+config\s+…3f2a\s+on\s+2/)
    expect(out.find((l) => l.includes("OpenRouter"))).toMatch(/OpenRouter\s+openai-compatible\s+env\s+env\s+on\s+0/)
    expect(out.find((l) => l.startsWith("   corp") || l.includes(" corp "))).toMatch(/corp\s+openai-compatible\s+config\s+missing\s+off\s+0\s+no API key/)
  })

  test("the key column never holds more than the masked tail", () => {
    expect(keyLabel(anthropic).text).toBe("…3f2a")
    expect(keyLabel(info("a", { keyTail: undefined }))).toEqual({ text: "set", tone: "text" })
    expect(keyLabel(info("a", { keyTail: undefined, source: "env" })).text).toBe("env")
    expect(keyLabel(corp)).toEqual({ text: "missing", tone: "warning" })
    expect(keyLabel(ollama)).toEqual({ text: "none", tone: "muted" })
  })

  test("enter shows the endpoint, key status, error and the models of the selected provider", () => {
    const out = lines({ state: { selected: 2, detail: true } })
    expect(out.some((l) => l.includes("endpoint") && l.includes("https://corp.example/v1"))).toBe(true)
    expect(out.some((l) => l.includes("error") && l.includes("no API key"))).toBe(true)
    expect(out.some((l) => l.includes("models") && l.includes("none listed"))).toBe(true)
    const first = lines({ state: { selected: 0, detail: true } })
    expect(first.some((l) => l.includes("claude-sonnet-5-5") && l.includes("effort") && l.includes("200k"))).toBe(true)
    expect(first.some((l) => l.includes("claude-haiku-4-5"))).toBe(true)
  })

  test("a note replaces the error in the row and shows under the details", () => {
    const out = lines({ notes: { anthropic: { text: "test ok · 312 ms", tone: "success" } } })
    expect(out.find((l) => l.includes("Anthropic"))).toContain("test ok · 312 ms")
    const note = renderProvidersPage({ state: createProvidersPageState(), providers: LIST, notes: { anthropic: { text: "test failed: 401", tone: "error" } }, width: 100, height: 28 })
    expect(note.flat().find((span) => span.text.includes("test failed: 401"))).toMatchObject({ fg: "error" })
  })

  test("removing asks on a mode line and the footer offers y and n", () => {
    const out = lines({ state: { selected: 1, detail: false, confirm: "openrouter" } })
    expect(out.some((l) => l.includes("Remove OpenRouter?"))).toBe(true)
    expect(out.join("\n")).toContain("y remove")
    expect(out.join("\n")).toContain("n cancel")
  })

  test("the footer lists the page's keys", () => {
    const out = lines().join("\n")
    for (const hint of ["enter details", "e toggle", "t test", "r refresh models", "d remove", "a add", "esc back"]) expect(out).toContain(hint)
  })

  test("loading, an error and an empty list", () => {
    expect(lines({ providers: undefined }).join("\n")).toContain("loading providers…")
    const failed = renderProvidersPage({ state: createProvidersPageState(), providers: undefined, error: "daemon is away", width: 100, height: 20 })
    expect(failed.map(plain).join("\n")).toContain("daemon is away")
    expect(failed[1]!.find((span) => span.text === "Error")).toMatchObject({ fg: "error" })
    const empty = lines({ providers: [] }).join("\n")
    expect(empty).toContain("no API-key providers · press a (or /connect) to add one")
    expect(empty).toContain("ANTHROPIC_API_KEY")
  })

  test("a render plainly printed at 100 columns", () => {
    const out = renderProvidersPage({ state: { selected: 0, detail: false }, providers: [anthropic, openrouter, corp, ollama], notes: { anthropic: { text: "test ok · 312 ms", tone: "success" } }, width: 100, height: 20 }).map((line) => plain(line).trimEnd())
    expect(out).toHaveLength(20)
    expect(out.some((line) => /^ ❯ Anthropic\s+anthropic\s+config\s+…3f2a\s+on\s+2\s+test ok · 312 ms$/.test(line))).toBe(true)
  })

  test.each([[40, 10], [60, 16], [100, 28], [140, 40]])("fits exactly at %ix%i with and without details", (width, height) => {
    for (const state of [{ selected: 0, detail: false }, { selected: 0, detail: true }, { selected: 2, detail: true, confirm: "corp" }]) {
      const out = renderProvidersPage({ state, providers: [...LIST, ollama], width, height })
      expect(out).toHaveLength(height)
      for (const line of out) expect(textWidth(plain(line))).toBeLessThanOrEqual(width)
    }
  })

  test("the selected row stays visible when the list is taller than the page", () => {
    const many = Array.from({ length: 30 }, (_, index) => info(`p${String(index).padStart(2, "0")}`))
    const out = renderProvidersPage({ state: { selected: 29, detail: false }, providers: many, width: 100, height: 14 }).map(plain)
    expect(out.some((l) => l.includes("❯ p29"))).toBe(true)
  })
})

describe("/providers in the app", () => {
  const daemon = (over: (command: Record<string, unknown>) => unknown = () => undefined) => (command: Record<string, unknown>) => {
    const custom = over(command)
    if (custom !== undefined) return custom
    if (command.type === "providers.list") return { ok: true, result: { providers: LIST } }
    return undefined
  }

  test("lists what the daemon reports", async () => {
    const h = providersHarness({ reply: daemon() })
    await h.run("/providers")
    expect(h.app.page).toBe("providers")
    expect(h.commands("providers.list")).toHaveLength(1)
    expect(h.text()).toContain("Anthropic")
    expect(h.text()).toContain("…3f2a")
    expect(h.text()).toContain("OpenRouter")
  })

  test("e sends providers.set with the flipped enabled flag and the row follows the reply", async () => {
    const h = providersHarness({ reply: daemon((command) => (command.type === "providers.set" ? { ok: true, result: { provider: { ...anthropic, enabled: command.enabled } } } : undefined)) })
    await h.run("/providers")
    await h.type("e")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "anthropic", enabled: false }])
    expect(h.text()).toMatch(/Anthropic\s+anthropic\s+config\s+…3f2a\s+off/)
    expect(h.text()).toContain("turned off")
    expect(h.commands("models.list").length).toBeGreaterThan(0)
    await h.type("e")
    expect(h.commands("providers.set")[1]).toEqual({ type: "providers.set", provider: "anthropic", enabled: true })
  })

  test("t sends providers.test and shows ok with the latency, or the error", async () => {
    let ok = true
    const h = providersHarness({ reply: daemon((command) => (command.type === "providers.test" ? { ok: true, result: ok ? { ok: true, latencyMs: 312, model: "claude-sonnet-5-5" } : { ok: false, latencyMs: 40, error: "[AUTH] 401 invalid key" } } : undefined)) })
    await h.run("/providers")
    await h.type("t")
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "anthropic" }])
    expect(h.text()).toContain("test ok · 312 ms · claude-sonnet-5-5")
    ok = false
    await h.type("t")
    expect(h.text()).toContain("test failed: [AUTH] 401 invalid key")
  })

  test("the test is a user action only: opening the page sends no providers.test", async () => {
    const h = providersHarness({ reply: daemon() })
    await h.run("/providers")
    await h.type(DOWN)
    expect(h.commands("providers.test")).toHaveLength(0)
    expect(h.commands("providers.refresh")).toHaveLength(0)
  })

  test("r refreshes the models of the selected provider", async () => {
    const h = providersHarness({ reply: daemon((command) => (command.type === "providers.refresh" ? { ok: true, result: { provider: { ...openrouter, models: [{ id: "a" }, { id: "b" }] } } } : undefined)) })
    await h.run("/providers")
    await h.type(DOWN)
    await h.type("r")
    expect(h.commands("providers.refresh")).toEqual([{ type: "providers.refresh", provider: "openrouter" }])
    expect(h.text()).toContain("2 models loaded")
    expect(h.text()).toMatch(/OpenRouter\s+openai-compatible\s+env\s+env\s+on\s+2/)
  })

  test("d then y removes it; d then n sends nothing", async () => {
    const h = providersHarness({ reply: daemon((command) => (command.type === "providers.remove" ? { ok: true, result: { providers: [anthropic, corp] } } : undefined)) })
    await h.run("/providers")
    await h.type(DOWN)
    await h.type("d")
    expect(h.text()).toContain("Remove OpenRouter?")
    await h.type("n")
    expect(h.commands("providers.remove")).toHaveLength(0)
    expect(h.text()).not.toContain("Remove OpenRouter?")
    await h.type("d")
    await h.type("y")
    expect(h.commands("providers.remove")).toEqual([{ type: "providers.remove", provider: "openrouter" }])
    expect(h.text()).not.toMatch(/OpenRouter\s+openai-compatible/)
    expect(h.text()).toContain("removed OpenRouter")
    expect(h.text()).toMatch(/Anthropic\s+anthropic/)
  })

  test("a refused command is shown on the row", async () => {
    const h = providersHarness({ reply: daemon((command) => (command.type === "providers.set" ? { ok: false, error: { code: "invalid_command", message: "[DAEMON]: providers.json is read-only" } } : undefined)) })
    await h.run("/providers")
    await h.type("e")
    expect(h.text()).toContain("providers.json is read-only")
  })

  test("a adds through /connect, and esc leaves", async () => {
    const h = providersHarness({ reply: daemon() })
    await h.run("/providers")
    await h.type("a")
    expect(h.app.page).toBe("connect")
    expect(h.text()).toContain("Connect a provider")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    await h.run("/providers")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("a failed list shows the error", async () => {
    const h = providersHarness({ reply: (command) => (command.type === "providers.list" ? { ok: false, error: { code: "internal", message: "[DAEMON]: providers.json is not valid JSON" } } : undefined) })
    await h.run("/providers")
    expect(h.text()).toContain("providers.json is not valid JSON")
  })
})
