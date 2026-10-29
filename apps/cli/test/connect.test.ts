import { describe, expect, test } from "bun:test"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { CONNECT_CHOICES, connectKey, connectMatches, connectPaste, createConnectState, maskSecret, renderConnectPage, validateConnect, type ConnectState } from "../src/view/connect-page"
import { CONNECT_PRESETS } from "../src/view/provider-presets"
import { textWidth } from "../src/view/wrap"
import { info, plain, providersHarness, REPORT } from "./providers-harness"

const SECRET = "sk-ant-api03-TOPSECRET-0123456789abcdef"
const CTRL_E = "\x05"
const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`

const testOk = { ok: true, result: { ok: true, latencyMs: 312, model: "claude-sonnet-5-5" } }

/** A daemon that accepts `providers.set`, answering with the provider as the daemon would list it, and tests fine. */
const accepting = (over: (command: Record<string, unknown>) => unknown = () => undefined) => (command: Record<string, unknown>) => {
  const custom = over(command)
  if (custom !== undefined) return custom
  if (command.type === "providers.set") return { ok: true, result: { provider: info(String(command.provider), { keyTail: "…cdef" }) } }
  if (command.type === "providers.test") return testOk
  return undefined
}

/** Fills the focused field, then Enter. */
async function fill(h: ReturnType<typeof providersHarness>, value: string) {
  if (value) await h.type(value)
  await h.type("\r")
}

describe("connect presets", () => {
  test("the terminal's preset table matches the engine's", () => {
    expect(CONNECT_PRESETS.map((preset) => preset.id).sort()).toEqual(Object.keys(PROVIDER_PRESETS).sort())
    for (const preset of CONNECT_PRESETS) {
      const engine = PROVIDER_PRESETS[preset.id]!
      expect({ name: preset.name, type: preset.type, baseUrl: preset.baseUrl, keyEnv: preset.keyEnv, keyless: preset.keyless }).toEqual({ name: engine.name, type: engine.type, baseUrl: engine.baseUrl, keyEnv: engine.keyEnv, keyless: engine.keyless })
    }
  })
  test("new presets follow the existing choices, preserving digits 1-9", () => {
    expect(CONNECT_CHOICES).toHaveLength(CONNECT_PRESETS.length + 3)
    expect(CONNECT_CHOICES.at(-1)).toBe("opencode-free")
    expect(CONNECT_CHOICES[8]).toBe("custom")
    expect(CONNECT_CHOICES[9]).toBe("chatgpt")
    expect(CONNECT_CHOICES[10]).toBe("google")
    expect(CONNECT_CHOICES[11]).toBe("github-copilot")
    expect(CONNECT_CHOICES.slice(12)).toEqual(["azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "cerebras", "cohere", "cloudflare-workers-ai", "cloudflare-ai-gateway", "togetherai", "kilo", "fireworks", "huggingface", "baseten", "moonshotai", "minimax", "xiaomi", "zai", "opencode-go", "ant-ling", "nearai", "foundry", "atomic-chat", "opencode-free"])
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })
})

describe("/connect: search", () => {
  const typeAll = (state: ConnectState, keys: string[]) => keys.reduce((current, key) => connectKey(current, key).state, state)

  test("/ filters the providers by name or id while typing; j, k and q are typed, not moves or close", () => {
    const state = typeAll(createConnectState(), ["/", "o", "p", "e", "n"])
    expect(state.searching).toBe(true)
    const page = renderConnectPage({ state, width: 100, height: 70 }).map(plain).join("\n")
    expect(page).toContain("/ open")
    expect(page).toContain("OpenRouter")
    expect(page).toContain("OpenCode (free)")
    expect(page).not.toContain("Anthropic")
    expect(page).toContain("type to filter · ↑↓ select · enter connect · esc end search")
    const lettered = connectKey(typeAll(createConnectState(), ["/", "k"]), "q")
    expect(lettered.action).toEqual({ type: "none" })
    expect(lettered.state.query).toBe("kq")
  })

  test("the first match is selected, ↓ moves among matches only, enter connects it and keeps its original number", () => {
    const state = typeAll(createConnectState(), ["/", "r", "o", "u", "t", "e", "r"])
    expect(CONNECT_CHOICES[state.selected]).toBe("openrouter")
    const page = renderConnectPage({ state, width: 100, height: 70 }).map(plain).join("\n")
    expect(page).toMatch(new RegExp(`❯ ${CONNECT_CHOICES.indexOf("openrouter") + 1} OpenRouter`))
    const opened = connectKey(state, "\r").state
    expect(opened.step).toBe("form")
    expect(opened.target).toBe("openrouter")
    expect(opened.searching).toBeFalsy()
    const open = typeAll(createConnectState(), ["/", "o", "p", "e", "n"])
    const matches = connectMatches("open")
    expect(open.selected).toBe(matches[0]!)
    expect(connectKey(open, "\x1b[B").state.selected).toBe(matches[1]!)
    expect(connectKey(open, "\x1b[A").state.selected).toBe(matches[0]!)
  })

  test("no match says so; esc ends the search and a second esc closes the page", () => {
    const state = typeAll(createConnectState(), ["/", "z", "z", "z", "z"])
    expect(renderConnectPage({ state, width: 100, height: 40 }).map(plain).join("\n")).toContain('No provider matches "zzzz"')
    expect(connectKey(state, "\r").state.step).toBe("pick")
    const ended = connectKey(state, "\x1b")
    expect(ended.state.searching).toBe(false)
    expect(ended.action).toEqual({ type: "none" })
    expect(connectKey(ended.state, "\x1b").action).toEqual({ type: "close" })
  })
})

describe("/connect: OpenCode (free)", () => {
  const withOpencode = (models: string[]) => ({ ok: true, result: { ...REPORT, models: [...REPORT.models, ...models.map((id) => ({ id, name: id, efforts: [] }))] } })

  test("Enter adds the opencode ACP agent with no form or key, then the row counts the models it offered", async () => {
    let added = false
    const h = providersHarness({ width: 120, height: 70, reply: (command) => {
      if (command.type === "settings.set") return (added = true), { ok: true, result: { settings: { acpAgents: { opencode: { command: "opencode", args: ["acp"], envKeys: [] } } } } }
      if (command.type === "models.list") return withOpencode(added ? ["acp:opencode", "acp:opencode/opencode/big-pickle", "acp:opencode/opencode/glm-5.3-flash-free"] : [])
      return undefined
    } })
    await h.run("/connect")
    for (let i = 0; i < CONNECT_CHOICES.indexOf("opencode-free"); i++) await h.type("\x1b[B")
    expect(h.text()).toMatch(/❯ \d+ OpenCode \(free\)\s+no key · runs your opencode CLI/)
    expect(h.text()).toContain("Needs opencode on the daemon's PATH")
    await h.type("\r")
    expect(h.commands("settings.set")).toEqual([{ type: "settings.set", patch: { acpAgents: { opencode: { command: "opencode", args: ["acp"], envKeys: [] } } } }])
    expect(h.text()).toContain("OpenCode added")
    expect(h.text()).toContain("Pick acp:opencode in /model")
    expect(h.text()).toContain("m open model page · esc close")
    expect(h.commands("providers.test")).toHaveLength(0)
    await h.type("t")
    expect(h.commands("providers.test")).toHaveLength(0)
    await h.type("\x1b")
    await h.run("/connect")
    for (let i = 0; i < CONNECT_CHOICES.indexOf("opencode-free"); i++) await h.type("\x1b[B")
    expect(h.text()).toMatch(/OpenCode \(free\)\s+added · 2 models/)
  })

  test("an agent already added is not written again, and a refused save says why", async () => {
    const ready = providersHarness({ reply: (command) => command.type === "settings.get" ? { ok: true, result: { settings: { acpAgents: { opencode: { command: "opencode", args: ["acp"] } } } } } : undefined })
    await ready.run("/connect")
    for (let i = 0; i < CONNECT_CHOICES.indexOf("opencode-free"); i++) await ready.type("\x1b[B")
    await ready.type("\r")
    expect(ready.commands("settings.set")).toHaveLength(0)
    expect(ready.text()).toContain("OpenCode added · it was already")
    const refused = providersHarness({ reply: (command) => command.type === "settings.set" ? { ok: false, error: { code: "forbidden", message: "[DAEMON]: remote clients cannot edit acpAgents" } } : undefined })
    await refused.run("/connect")
    for (let i = 0; i < CONNECT_CHOICES.indexOf("opencode-free"); i++) await refused.type("\x1b[B")
    await refused.type("\r")
    expect(refused.text()).toContain("OpenCode not added")
    expect(refused.text()).toContain("remote clients cannot edit acpAgents")
  })
})

describe("/connect: a keyed preset", () => {
  test("lists the presets and the subscription and Claude Code as read-only rows", async () => {
    const h = providersHarness({ height: 50 })
    await h.run("/connect")
    const out = h.text()
    for (const name of ["OpenAI", "Anthropic", "OpenRouter", "Vercel AI Gateway", "Groq", "DeepSeek", "Ollama", "LM Studio", "Custom endpoint"]) expect(out).toContain(name)
    expect(out).toMatch(/ChatGPT subscription\s+2 models/)
    expect(out).toMatch(/Claude Code\s+1 model/)
    expect(out).toContain("❯ 1 OpenAI")
    // Moving the cursor never connects a provider.
    for (let i = 0; i < CONNECT_CHOICES.indexOf("github-copilot"); i++) await h.type("\x1b[B")
    expect(h.text()).toContain("❯ 12 GitHub Copilot")
    expect(h.app.page).toBe("connect")
  })

  test("marks a provider the daemon already has and says what it holds", async () => {
    const h = providersHarness({ reply: (command) => (command.type === "providers.list" ? { ok: true, result: { providers: [info("anthropic", { type: "anthropic", keyTail: "…3f2a", models: [{ id: "claude-sonnet-5-5" }] })] } } : undefined) })
    await h.run("/connect")
    expect(h.text()).toMatch(/Anthropic\s+connected · key …3f2a · 1 model/)
  })

  test("the key is typed masked, sent once in providers.set, and never appears in a frame or another command", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect")
    await h.type("2")
    expect(h.text()).toContain("Connect Anthropic")
    await h.type(SECRET)
    expect(h.text()).toContain("•".repeat(32))
    expect(h.text()).toContain(`${SECRET.length} chars`)
    expect(h.text()).not.toContain("TOPSECRET")
    await h.type("\r")

    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "anthropic", apiKey: SECRET, enabled: true }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "anthropic" }])
    // The one place the key may go is providers.set.
    for (const command of h.sent.filter((entry) => entry.type !== "providers.set")) expect(JSON.stringify(command)).not.toContain("TOPSECRET")
    expect(h.everything()).not.toContain("TOPSECRET")
    expect(h.everything()).not.toContain(SECRET.slice(0, 12))
    // What was typed stayed out of the prompt too.
    expect(h.app.editor.text).toBe("")
    // The result: ok and latency, with the next steps.
    expect(h.text()).toContain("Anthropic connected")
    expect(h.text()).toContain("test ok · 312 ms · claude-sonnet-5-5")
    expect(h.text()).toContain("r refresh")
  })

  test("a bracketed paste goes into the masked field, newlines and spaces dropped", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect anthropic")
    await h.type(PASTE(`  ${SECRET}\r\n`))
    expect(h.text()).toContain(`${SECRET.length} chars`)
    expect(h.everything()).not.toContain("TOPSECRET")
    await h.type("\r")
    expect(h.commands("providers.set")[0]).toMatchObject({ apiKey: SECRET })
    expect(h.app.editor.text).toBe("")
  })

  test("backspace and ctrl+u edit the masked value; an empty key is refused with a hint and nothing is sent", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect anthropic")
    await h.type("abcd")
    await h.type("\x7f")
    expect(h.text()).toContain("3 chars")
    await h.type("\x15")
    expect(h.text()).toContain("required")
    await h.type("\r")
    expect(h.text()).toContain("enter the API key")
    expect(h.commands("providers.set")).toHaveLength(0)
  })

  test("esc from the form drops what was typed", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect anthropic")
    await h.type(SECRET)
    await h.type("\x1b")
    expect(h.text()).toContain("Connect a provider")
    await h.type("\r")
    expect(h.text()).toContain("required")
    expect(h.everything()).not.toContain("TOPSECRET")
    expect(h.commands("providers.set")).toHaveLength(0)
  })

  test("the state no longer holds the key once it is submitted", () => {
    let state = createConnectState("anthropic")
    state = connectPaste(state, SECRET)
    expect(state.values.key).toBe(SECRET)
    const sent = connectKey(state, "\r")
    expect(sent.action).toMatchObject({ type: "submit", submit: { apiKey: SECRET } })
    expect(JSON.stringify(sent.state)).not.toContain("TOPSECRET")
    expect(sent.state.step).toBe("busy")
    const back = connectKey(connectKey(sent.state, "\x1b").state, "\x1b").state
    expect(JSON.stringify(back)).not.toContain("TOPSECRET")
  })

  test("the env var choice shows the variable and sends apiKeyEnv, with no key", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect anthropic")
    await h.type(SECRET.slice(0, 10))
    await h.type(CTRL_E)
    expect(h.text()).toContain("Uses the environment variable ANTHROPIC_API_KEY")
    expect(h.text()).toContain("set where the daemon runs")
    expect(h.everything()).not.toContain(SECRET.slice(0, 10))
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", enabled: true }])
    expect(h.text()).toContain("Anthropic connected")
    // ctrl+e again goes back to typing a key.
    const again = providersHarness()
    await again.run("/connect anthropic")
    await again.type(CTRL_E)
    await again.type(CTRL_E)
    expect(again.text()).toContain("API key")
  })

  test("a refused save returns to the form with the reason and an empty key field", async () => {
    const h = providersHarness({ reply: accepting((command) => (command.type === "providers.set" ? { ok: false, error: { code: "invalid_command", message: `[DAEMON]: provider anthropic rejected ${SECRET}` } } : undefined)) })
    await h.run("/connect anthropic")
    await h.type(SECRET)
    await h.type("\r")
    expect(h.text()).toContain("rejected •••")
    expect(h.text()).toContain("required")
    expect(h.everything()).not.toContain("TOPSECRET")
    expect(h.commands("providers.test")).toHaveLength(0)
  })
})

describe("/connect: the test result", () => {
  test("a failing test shows the error, says the details are saved, and e edits them again", async () => {
    const h = providersHarness({ reply: accepting((command) => (command.type === "providers.test" ? { ok: true, result: { ok: false, latencyMs: 41, error: `[AUTH] anthropic: 401 invalid x-api-key (${SECRET})` } } : undefined)) })
    await h.run("/connect anthropic")
    await h.type(SECRET)
    await h.type("\r")
    const out = h.text()
    expect(out).toContain("Anthropic saved, test failed")
    expect(out).toContain("401 invalid x-api-key")
    // A daemon that echoed the key back does not get it onto the screen.
    expect(h.everything()).not.toContain("TOPSECRET")
    expect(out).toContain("e edit details")
    expect(out).not.toContain("refresh models")
    await h.type("e")
    expect(h.text()).toContain("required")
    expect(h.text()).toContain("API key")
  })

  test("an error from the test command itself is shown the same way", async () => {
    const h = providersHarness({ reply: accepting((command) => (command.type === "providers.test" ? { ok: false, error: { code: "internal", message: "[DAEMON]: provider anthropic is disabled" } } : undefined)) })
    await h.run("/connect anthropic")
    await h.type("abc")
    await h.type("\r")
    expect(h.text()).toContain("provider anthropic is disabled")
    expect(h.text()).toContain("saved, test failed")
  })

  test("t tests again; r refreshes the models and m opens the model page", async () => {
    let tests = 0
    const h = providersHarness({
      reply: accepting((command) => {
        if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: ++tests * 100 } }
        if (command.type === "providers.refresh") return { ok: true, result: { provider: info("anthropic", { type: "anthropic", models: [{ id: "a" }, { id: "b" }, { id: "c" }] }) } }
        return undefined
      }),
    })
    await h.run("/connect anthropic")
    await h.type("abc")
    await h.type("\r")
    expect(h.text()).toContain("test ok · 100 ms")
    await h.type("t")
    expect(h.text()).toContain("test ok · 200 ms")
    const before = h.commands("models.list").length
    await h.type("r")
    expect(h.commands("providers.refresh")).toEqual([{ type: "providers.refresh", provider: "anthropic" }])
    expect(h.text()).toContain("3 models loaded from the provider")
    expect(h.commands("models.list").length).toBeGreaterThan(before)
    await h.type("m")
    expect(h.app.page).toBe("model")
    expect(h.text()).toContain("Model")
  })

  test("a failed refresh keeps the page and says so", async () => {
    const h = providersHarness({ reply: accepting((command) => (command.type === "providers.refresh" ? { ok: false, error: { code: "internal", message: "[DAEMON]: GET /models answered 404" } } : undefined)) })
    await h.run("/connect anthropic")
    await h.type("abc")
    await h.type("\r")
    await h.type("r")
    expect(h.text()).toContain("refresh failed: GET /models answered 404")
    expect(h.text()).toContain("Anthropic connected")
  })

  test("esc while the daemon works closes the page, and its late answer does not bring it back", async () => {
    let answer!: (value: unknown) => void
    const h = providersHarness({ reply: (command) => (command.type === "providers.set" ? new Promise((resolve) => (answer = resolve)) : undefined) })
    await h.run("/connect anthropic")
    await h.type("abc")
    await h.type("\r")
    expect(h.text()).toContain("Saving Anthropic…")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    answer({ ok: true, result: { provider: info("anthropic") } })
    await Bun.sleep(10)
    expect(h.app.page).toBe("chat")
    expect(h.commands("providers.test")).toHaveLength(0)
  })
})

describe("/connect: a local server", () => {
  test("Ollama needs no key: the URL is filled in and Enter twice connects", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect")
    await h.type("7")
    expect(h.text()).toContain("Connect Ollama")
    expect(h.text()).toContain("http://127.0.0.1:11434/v1")
    expect(h.text()).not.toContain("API key")
    await h.type("\r")
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "ollama", enabled: true }])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "ollama" }])
  })

  test("a changed URL and model ids are sent; ctrl+e does nothing for a keyless server", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect lmstudio")
    await h.type(CTRL_E)
    expect(h.text()).toContain("Base URL")
    await h.type("\x15")
    await h.type("http://10.0.0.5:1234/v1")
    await h.type("\r")
    await h.type("llama3:8b, qwen3")
    await h.type(PASTE("\nllama3:8b\n"))
    await h.type("\r")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "lmstudio", enabled: true, baseUrl: "http://10.0.0.5:1234/v1", models: [{ id: "llama3:8b" }, { id: "qwen3" }] }])
  })

  test("a bad URL is refused on the URL field", async () => {
    const h = providersHarness({ reply: accepting() })
    await h.run("/connect ollama")
    await h.type("\x15")
    await h.type("localhost:11434")
    await h.type("\r")
    await h.type("\r")
    expect(h.text()).toContain("base URL must start with http:// or https://")
    expect(h.commands("providers.set")).toHaveLength(0)
  })
})

describe("/connect: a custom endpoint", () => {
  const custom = async (h: ReturnType<typeof providersHarness>) => {
    await h.run("/connect")
    await h.type("9")
  }

  test("asks for name, format, base URL, key and optional models, and sends them together", async () => {
    const h = providersHarness({ reply: accepting() })
    await custom(h)
    expect(h.text()).toContain("Connect a custom endpoint")
    await fill(h, "Corp") // lower-cased
    expect(h.text()).toContain("‹ openai-compatible ›")
    await h.type("\x1b[C")
    expect(h.text()).toContain("‹ openai ›")
    await h.type("\x1b[C")
    expect(h.text()).toContain("‹ anthropic ›")
    await h.type("\r")
    await fill(h, "https://llm.corp.example/v1")
    await fill(h, SECRET)
    expect(h.everything()).not.toContain("TOPSECRET")
    await fill(h, "model-a model-b")
    expect(h.commands("providers.set")).toEqual([
      { type: "providers.set", provider: "corp", providerType: "anthropic", baseUrl: "https://llm.corp.example/v1", apiKey: SECRET, models: [{ id: "model-a" }, { id: "model-b" }], enabled: true },
    ])
    expect(h.commands("providers.test")).toEqual([{ type: "providers.test", provider: "corp" }])
    expect(h.text()).toContain("corp connected")
    expect(h.everything()).not.toContain("TOPSECRET")
  })

  test("a variable name can replace the key", async () => {
    const h = providersHarness({ reply: accepting() })
    await custom(h)
    await fill(h, "corp")
    await fill(h, "")
    await fill(h, "http://llm.corp.example/v1")
    await h.type(CTRL_E)
    expect(h.text()).toContain("Key variable")
    await fill(h, "CORP_LLM_KEY")
    await fill(h, "")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "corp", providerType: "openai-compatible", baseUrl: "http://llm.corp.example/v1", apiKeyEnv: "CORP_LLM_KEY", enabled: true }])
  })

  const form = (over: Partial<ConnectState["values"]>, viaEnv = false): ConnectState => ({ ...createConnectState("custom"), values: { ...createConnectState("custom").values, name: "corp", type: "openai-compatible", baseUrl: "https://llm.corp.example/v1", key: "k", ...over }, viaEnv })

  test.each([
    [{ name: "" }, "name:"],
    [{ name: "1corp" }, "name:"],
    [{ name: "Corp Inc" }, "name:"],
    [{ name: "a".repeat(33) }, "name:"],
    [{ name: "chatgpt" }, "reserved"],
    [{ name: "anthropic" }, "is a preset"],
    [{ baseUrl: "" }, "base URL"],
    [{ baseUrl: "ftp://x" }, "base URL"],
    [{ baseUrl: "llm.corp" }, "base URL"],
    [{ key: "" }, "enter the API key"],
    [{ models: "m".repeat(67) }, "66 characters"],
    [{ models: Array.from({ length: 51 }, (_, i) => `m${i}`).join(",") }, "at most 50"],
  ] as const)("validation refuses %j", (over, message) => {
    const checked = validateConnect(form(over))
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error).toContain(message)
  })

  test("the env variable name is validated", () => {
    expect(validateConnect(form({ keyEnv: "1BAD" }, true)).ok).toBe(false)
    expect(validateConnect(form({ keyEnv: "GOOD_KEY" }, true)).ok).toBe(true)
  })

  test("a refused form stays on the form, focuses the field, and sends nothing", async () => {
    const h = providersHarness({ reply: accepting() })
    await custom(h)
    for (let i = 0; i < 5; i++) await h.type("\r") // through the five fields, the last one submits
    expect(h.text()).toContain("name: lowercase letters")
    expect(h.text()).toContain("❯ Name")
    expect(h.commands("providers.set")).toHaveLength(0)
  })
})

describe("/connect: entry points", () => {
  test("/connect <preset> opens that form; an unknown argument is not echoed anywhere", async () => {
    const h = providersHarness()
    await h.run("/connect Anthropic")
    expect(h.text()).toContain("Connect Anthropic")
    const other = providersHarness()
    await other.app.onInput(`/connect ${SECRET}`)
    const typed = other.frames.length // the prompt shows what the user types, until Enter
    await other.app.onKey("\r")
    await Bun.sleep(8)
    other.app.render()
    expect(other.text()).toContain("Connect a provider")
    expect(other.text()).toContain("unknown provider")
    expect(other.frames.slice(typed).map((frame) => frame.map(plain).join("\n")).join("\n")).not.toContain("TOPSECRET")
    // Not kept in the prompt history either: the up arrow on an empty prompt finds nothing.
    await other.type("\x1b")
    await other.type("\x1b[A")
    expect(other.app.editor.text).not.toContain("TOPSECRET")
  })

  test("the commands are in the help page", async () => {
    const h = providersHarness({ width: 140, height: 50 })
    await h.run("/help")
    expect(h.text()).toMatch(/\/connect\s+Connect an API-key/)
    expect(h.text()).toMatch(/\/providers\s+Manage API-key providers/)
  })
})

describe("renderConnectPage", () => {
  test("fits every width and height exactly, and never draws the key", () => {
    const states: ConnectState[] = [createConnectState(), createConnectState("anthropic"), connectPaste(createConnectState("anthropic"), SECRET), createConnectState("custom"), createConnectState("ollama")]
    for (const state of states) {
      for (const [width, height] of [[40, 12], [60, 20], [100, 30], [140, 40]] as const) {
        const out = renderConnectPage({ state, width, height })
        expect(out).toHaveLength(height)
        for (const line of out) expect(textWidth(plain(line))).toBeLessThanOrEqual(width)
        expect(out.map(plain).join("\n")).not.toContain("TOPSECRET")
      }
    }
  })

  test("maskSecret never contains the value and caps the bullets", () => {
    expect(maskSecret("")).toBe("")
    expect(maskSecret("abc")).toBe("•••  3 chars")
    expect(maskSecret("x".repeat(100))).toBe(`${"•".repeat(32)}…  100 chars`)
  })
})
