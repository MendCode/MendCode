import { describe, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import { parseAutomation } from "../src/automation"
import { textWidth } from "../src/view/wrap"
import { catalogHarness, catalogPromptHarness, CATALOG_MCP, CATALOG_MODELS } from "./catalog-harness"

const parsed = (args: string[]) => { const value = parseAutomation(args); if (value.ok !== true) throw new Error(JSON.stringify(value)); return value.command }
const payload = (h: ReturnType<typeof catalogHarness>) => JSON.parse(h.out.at(-1)!)

describe("B17 parsing", () => {
  test("models filters and flags; global data dir is separate from model arguments", () => {
    expect(parsed(["--dir", "/tmp/data", "models", "openrouter", "--verbose", "--refresh", "--format=json"])).toMatchObject({ kind: "catalog.models", provider: "openrouter", dir: "/tmp/data", json: true, verbose: true, refresh: true })
    expect(parsed(["models", "--verbose=false"])).toMatchObject({ verbose: false })
    expect(parsed(["models", "--help"])).toMatchObject({ kind: "help", topic: "models" })
  })
  test("control-plane models has every audited operation", () => {
    for (const operation of ["status", "show", "plan", "presets"]) expect(parsed(["control-plane", "models", operation])).toMatchObject({ kind: "catalog.models.control", operation })
    expect(parsed(["control-plane", "models", "set-default", "openai", "gpt-6-astra", "--auth-mode", "chatgpt-subscription-oauth", "--enable", "--dry-run"])).toMatchObject({ provider: "openai", model: "gpt-6-astra", dryRun: true, authMode: "chatgpt-subscription-oauth" })
    expect(parsed(["control-plane", "models", "use-preset", "openai-api-gpt-5-nano"])).toMatchObject({ preset: "openai-api-gpt-5-nano" })
  })
  test("providers aliases, provider name and smoke execute", () => {
    expect(parsed(["auth", "ls"])).toMatchObject({ kind: "catalog.providers", operation: "list" })
    expect(parsed(["providers", "login", "-p", "OpenRouter", "--api-key-env", "KEY"])).toMatchObject({ provider: "OpenRouter", apiKeyEnv: "KEY" })
    for (const operation of ["auth", "status", "adapters", "smoke"]) expect(parsed(["control-plane", "providers", operation])).toMatchObject({ operation })
    expect(parsed(["control-plane", "providers", "smoke", "--provider", "openrouter", "--model", "google/gemini-3-pro", "--execute"])).toMatchObject({ execute: true, model: "google/gemini-3-pro" })
  })
  test("MCP auth list and local argv preserve quoted arguments and binary flags", () => {
    expect(parsed(["mcp", "auth", "ls"])).toMatchObject({ operation: "auth.list" })
    expect(parsed(["mcp", "add", "local", "--scope", "project", "--", "bun", "script with spaces.ts", "--json"])).toMatchObject({ operation: "add", scope: "project", config: { command: "bun", args: ["script with spaces.ts", "--json"] } })
    expect(parsed(["control-plane", "mcp", "add-local", "local", "bun", "--", "--flag"])).toMatchObject({ scope: "project", config: { command: "bun", args: ["--flag"] } })
  })
  test("MCP remote stores variable references, never resolves a secret in CLI", () => {
    expect(parsed(["mcp", "add", "docs", "--url", "https://docs.test/mcp", "--client-id", "client", "--client-secret-env", "SECRET", "--scope", "user"])).toMatchObject({ config: { url: "https://docs.test/mcp", oauth: { clientId: "client", clientSecret: "${SECRET}" } } })
  })
  for (const args of [
    ["models", "a", "b"], ["models", "--refresh=maybe"], ["models", "--execute"], ["control-plane", "models", "set-default", "openai"],
    ["control-plane", "models", "status", "--dry-run"], ["control-plane", "models", "use-preset"], ["providers", "login", "--api-key-env", "bad name"],
    ["providers", "list", "--execute"], ["providers", "logout", "x", "y"], ["mcp", "debug"], ["mcp", "add", "../bad"], ["mcp", "add", "web", "--url", "ftp://x"],
    ["mcp", "add", "web", "--url", "https://x", "--", "bun"], ["mcp", "add", "web", "--scope", "else"], ["mcp", "auth", "x", "y"],
    ["mcp", "add", "web", "--url", "https://x", "--no-oauth", "--client-id", "c"],
    ["mcp", "add", "web", "--client-id", "c"], ["mcp", "add", "web", "--url", "https://x", "--client-secret-env", "SECRET"],
  ]) test(`rejects ${args.join(" ")}`, () => expect(parseAutomation(args).ok).toBe(false))
  test("unrelated lane parsers retain their flags", () => {
    expect(parseAutomation(["session", "list"]).ok).toBe(true)
    expect(parseAutomation(["control-plane", "ai", "status"]).ok).toBe(true)
  })
})

describe("B17 CLI factories", () => {
  test("models print stable v1 references; verbose and JSON preserve metadata", async () => {
    const h = catalogHarness()
    expect(await h.run(["models"])).toBe(0)
    expect(h.out.join("")).toBe("chatgpt/gpt-6-luna\nollama/llama3:8b\nopenrouter/google/gemini-3-pro\n")
    h.out.length = 0
    expect(await h.run(["models", "openrouter", "--verbose"])).toBe(0)
    expect(h.out.join("")).toContain('"contextWindow": 1000000')
    h.out.length = 0
    expect(await h.run(["models", "ollama", "--json"])).toBe(0)
    expect(payload(h).data.models[0].reference).toBe("ollama/llama3:8b")
    expect(await h.run(["models", "missing"])).toBe(1)
  })
  test("verbose shows a model's known maximum window and the window kept for it (modelContext)", async () => {
    const astra = { id: "gpt-6-astra", name: "GPT-6 Astra", efforts: [], contextWindow: 272000, maxContextWindow: 872000, contextSetting: { window: 500000 }, compactAtTokens: 475000 }
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "models.list" ? { ...CATALOG_MODELS, models: [astra] } : {} }) })
    expect(await h.run(["models", "chatgpt", "--verbose"])).toBe(0)
    const shown = h.out.join("")
    expect(shown).toStartWith("chatgpt/gpt-6-astra\n")
    for (const line of ['"contextWindow": 272000', '"maxContextWindow": 872000', '"window": 500000', '"compactAtTokens": 475000']) expect(shown).toContain(line)
  })
  test("refresh is explicit, filtered, errors propagate and the refreshed catalog is reread", async () => {
    const h = catalogHarness()
    expect(await h.run(["models", "openrouter", "--refresh"])).toBe(0)
    expect(h.sent.filter((command) => command.type === "providers.refresh")).toEqual([{ type: "providers.refresh", provider: "openrouter" }])
    expect(h.sent.filter((command) => command.type === "models.list")).toHaveLength(2)
    const error = catalogHarness({ send: () => ({ ok: false, error: { code: "internal", message: "refresh failed" } }) })
    expect(await error.run(["models", "--refresh"])).toBe(1)
    expect(error.err.join("")).toContain("refresh failed")
  })
  test("default and preset write through protocol, and dry-run is sent to daemon", async () => {
    const h = catalogHarness()
    expect(await h.run(["control-plane", "models", "set-default", "openai", "gpt-6-astra", "--dry-run"])).toBe(0)
    expect(h.sent[0]).toMatchObject({ type: "models.default.set", directory: "/work/catalog", provider: "openai", model: "gpt-6-astra", dryRun: true })
    expect(await h.run(["control-plane", "models", "use-preset", "openai-api-gpt-5-nano"])).toBe(0)
    expect(h.sent[1]).toMatchObject({ preset: "openai-api-gpt-5-nano", dryRun: false })
  })
  test("model plan fails when the daemon finds invalid roles", async () => {
    const h = catalogHarness({ send: () => ({ ok: true, result: { failures: ["main unavailable"], warnings: [], presets: [] } }) })
    expect(await h.run(["control-plane", "models", "plan", "--json"])).toBe(1)
    expect(payload(h).data.failures).toEqual(["main unavailable"])
  })
  test("provider list exposes credential presence and environment names only", async () => {
    const h = catalogHarness()
    expect(await h.run(["providers", "list"])).toBe(0)
    expect(h.out.join("")).toContain("OPENROUTER_API_KEY")
    expect(await h.run(["control-plane", "providers", "adapters", "--json"])).toBe(0)
    expect(payload(h).data.providers).toHaveLength(3)
  })
  test("login --provider matches display name and sends a reference; logout selects only stored credentials", async () => {
    const h = catalogHarness({ prompts: ["openrouter"] })
    expect(await h.run(["providers", "login", "--provider", "OpenRouter", "--api-key-env", "ROUTER_KEY"])).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "providers.set", provider: "openrouter", apiKeyEnv: "ROUTER_KEY" })
    expect(await h.run(["providers", "logout"])).toBe(0)
    expect(h.prompts[0]!.options!.map((option) => option.value)).toEqual(["openrouter"])
    expect(h.sent.at(-1)).toEqual({ type: "providers.logout", provider: "openrouter" })
  })
  test("password login never echoes the key", async () => {
    const h = catalogHarness({ prompts: ["fake-secret-value"] })
    expect(await h.run(["providers", "login", "--provider", "openrouter"])).toBe(0)
    expect(h.prompts[0]!.secret).toBe(true)
    expect(h.sent.at(-1)).toMatchObject({ apiKey: "fake-secret-value" })
    expect(h.out.join("") + h.err.join("")).not.toContain("fake-secret-value")
  })
  test("smoke defaults to dry-run; only explicit execution calls ready API adapters", async () => {
    const h = catalogHarness()
    expect(await h.run(["control-plane", "providers", "smoke", "--json"])).toBe(0)
    expect(h.sent.some((command) => command.type === "providers.test")).toBe(false)
    expect(payload(h).data.executedCount).toBe(0)
    expect(await h.run(["control-plane", "providers", "smoke", "--provider", "openrouter", "--execute", "--json"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "providers.test", model: "google/gemini-3-pro" })
    expect(payload(h).data).toMatchObject({ executedCount: 1, okCount: 1 })
  })
  test("an executed smoke failure exits one; subscription refresh fails explicitly without calling an API", async () => {
    const h = catalogHarness()
    const send = h.deps.client.send
    h.deps.client.send = async (command) => command.type === "providers.test" ? { ok: true, result: { ok: false, error: "provider rejected model" } } : send(command)
    expect(await h.run(["control-plane", "providers", "smoke", "--provider", "openrouter", "--execute", "--json"])).toBe(1)
    expect(payload(h).data.okCount).toBe(0)
    expect(await h.run(["models", "chatgpt", "--refresh"])).toBe(1)
    expect(h.err.join("")).toContain("subscription catalogs")
    expect(h.sent.some((command) => command.type === "providers.refresh")).toBe(false)
  })
  test("MCP auth list filters local and disabled OAuth; expired credentials remain selectable for logout", async () => {
    const h = catalogHarness({ prompts: ["expired"] })
    expect(await h.run(["mcp", "auth", "list", "--json"])).toBe(0)
    expect(payload(h).data.servers.map((entry: { name: string }) => entry.name)).toEqual(["docs", "expired"])
    expect(await h.run(["mcp", "logout"])).toBe(0)
    expect(h.prompts[0]!.options).toHaveLength(1)
    expect(h.sent.at(-1)).toEqual({ type: "mcp.auth", directory: "/work/catalog", server: "expired", action: "forget" })
  })
  test("MCP add local wizard preserves spaces and writes once after every choice", async () => {
    const h = catalogHarness({ prompts: ["tools", "project", "local", "bun", '["script with spaces.ts", "--flag"]'] })
    expect(await h.run(["mcp", "add"])).toBe(0)
    expect(h.sent).toEqual([{ type: "mcp.add", name: "tools", directory: "/work/catalog", scope: "project", config: { command: "bun", args: ["script with spaces.ts", "--flag"] }, replace: false, dryRun: false }])
  })
  test("remote wizard captures OAuth registration settings as references", async () => {
    const h = catalogHarness({ prompts: ["docs", "user", "remote", "https://docs.test/mcp", "yes", "client", "CLIENT_SECRET"] })
    expect(await h.run(["mcp", "add", "--dry-run"])).toBe(0)
    expect(h.sent[0]).toMatchObject({ dryRun: true, config: { oauth: { clientId: "client", clientSecret: "${CLIENT_SECRET}" } } })
  })
  test("cancelled wizard and missing noninteractive input never write", async () => {
    const h = catalogHarness({ prompts: ["tools", undefined] })
    expect(await h.run(["mcp", "add"])).toBe(2)
    expect(h.sent).toEqual([])
    const unattended = catalogHarness()
    expect(await unattended.run(["mcp", "add", "--json"])).toBe(64)
    expect(unattended.sent).toEqual([])
  })
  test("control-plane MCP preview stays nonmutating; debug HTTP errors exit one", async () => {
    const h = catalogHarness()
    expect(await h.run(["control-plane", "mcp", "preview"])).toBe(0)
    expect(JSON.parse(h.out.join("")).servers).toHaveLength(4)
    expect(h.sent).toEqual([{ type: "mcp.status", directory: "/work/catalog" }])
    const broken = catalogHarness({ send: () => ({ ok: true, result: { server: "docs", httpStatus: 503, error: "HTTP 503" } }) })
    expect(await broken.run(["mcp", "debug", "docs"])).toBe(1)
    expect(broken.out.join("")).toContain("HTTP 503")
  })
  test("OAuth waits for completion, even when a change pushes before the start ack", async () => {
    let pending = false, completed = false
    const h = catalogHarness({ send: async (command): Promise<CommandReply> => {
      if (command.type === "mcp.status") return { ok: true, result: { issues: [], servers: [{ ...CATALOG_MCP.servers[1], auth: completed ? "authorized" : pending ? "pending" : "none", state: completed ? "running" : "stopped" }] } }
      if (command.type === "mcp.auth") {
        pending = true
        h.push({ type: "mcp.changed", gseq: 1, at: 0, directory: "/work/catalog", server: "docs" })
        queueMicrotask(() => { completed = true; h.push({ type: "mcp.changed", gseq: 2, at: 0, directory: "/work/catalog", server: "docs" }) })
        return { ok: true, result: { url: "https://auth.test/authorize?state=local" } }
      }
      return { ok: true }
    } })
    expect(await h.run(["mcp", "auth", "docs", "--json"])).toBe(0)
    expect(payload(h).data.server.auth).toBe("authorized")
    expect(h.hasGlobal()).toBe(false)
    expect(h.err.join("")).toContain("Authorize:")
  })
  test("OAuth interrupt cancels its flow and cleans the global listener", async () => {
    let pending = false
    const h = catalogHarness({ send: (command) => {
      if (command.type === "mcp.status") return { ok: true, result: { issues: [], servers: [{ ...CATALOG_MCP.servers[1], auth: pending ? "pending" : "none" }] } }
      if (command.type === "mcp.auth" && !command.action) { pending = true; queueMicrotask(() => h.interrupt()); return { ok: true, result: { url: "https://auth.test" } } }
      return { ok: true }
    } })
    expect(await h.run(["mcp", "auth", "docs"])).toBe(2)
    expect(h.sent.at(-1)).toMatchObject({ action: "cancel" })
    expect(h.hasGlobal()).toBe(false)
  })
  test("OAuth timeout cancels only its flow and clears its timer; authorization denial exits one", async () => {
    let cancel = false, pending = false
    const h = catalogHarness({ send: (command) => {
      if (command.type === "mcp.status") return { ok: true, result: { issues: [], servers: [{ ...CATALOG_MCP.servers[1], auth: pending ? "pending" : "none" }] } }
      if (command.type === "mcp.auth" && !command.action) { pending = true; return { ok: true, result: { url: "https://auth.test" } } }
      return { ok: true }
    } })
    h.deps.setTimer = (ms, callback) => { expect(ms).toBe(300000); queueMicrotask(callback); return { cancel: () => { cancel = true } } }
    expect(await h.run(["mcp", "auth", "docs"])).toBe(3)
    expect(h.sent.at(-1)).toMatchObject({ action: "cancel" })
    expect(cancel).toBe(true)
    expect(h.hasGlobal()).toBe(false)
    const denied = catalogHarness({ send: (command) => command.type === "mcp.status" ? { ok: true, result: { issues: [], servers: [{ ...CATALOG_MCP.servers[1], auth: "none", state: "failed", lastError: "access denied" }] } } : { ok: true, result: { url: "https://auth.test" } } })
    expect(await denied.run(["mcp", "auth", "docs"])).toBe(1)
    expect(denied.err.join("")).toContain("access denied")
    expect(denied.hasGlobal()).toBe(false)
  })
})

describe("B17 prompt app harness", () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`frames and keyboard selection fit ${width}x${height}`, () => {
    const h = catalogPromptHarness({ title: "Add MCP server", label: "Server type", options: [{ value: "local", label: "Local" }, { value: "remote", label: "Remote" }] }, width, height)
    h.app.key("\x1b[A"); h.app.key("\x1b[B"); h.app.key("\x1b[B")
    expect(h.frames.at(-1)).toHaveLength(height!)
    expect(h.text().every((row) => textWidth(row) === width && !row.includes("\x1b"))).toBe(true)
    h.app.key("\r")
    expect(h.value()).toBe("remote")
    if (width! >= 70) expect(h.text().join("\n")).toContain("┌")
  })
  test("text validation retains input, arrows edit, secret input is masked and escape cancels", () => {
    const h = catalogPromptHarness({ title: "Add credential", label: "API key", secret: true, validate: (value) => value.length < 3 ? "Too short" : undefined })
    h.app.key("a"); h.app.key("\r")
    expect(h.finished()).toBe(false)
    expect(h.text().join("\n")).toContain("Too short")
    h.app.key("bc"); h.app.key("\x1b[D"); h.app.key("X")
    expect(h.text().join("\n")).not.toContain("abXc")
    expect(h.text().join("\n")).toContain("****")
    h.app.key("\r")
    expect(h.value()).toBe("abXc")
    h.app.key("more"); h.app.paste("text")
    expect(h.value()).toBe("abXc")
    const cancelled = catalogPromptHarness({ title: "Add MCP server", label: "Name" })
    cancelled.app.key("\x1b")
    expect(cancelled.finished()).toBe(true)
    expect(cancelled.value()).toBeUndefined()
  })
})
