import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { COPILOT_AUTH_FILE, createCopilotAuth, type ModelRequest } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService } from "../src/providers"

const TOKEN = "private-github-token-0123456789"
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-copilot-daemon-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const remote = { id: "gpt-5", name: "GPT fixture", model_picker_enabled: true, capabilities: { limits: { max_context_window_tokens: 200000 }, supports: { vision: true, reasoning_effort: ["low", "high"] } } }

describe("B10.14 daemon and protocol", () => {
  test("additive Copilot config and model metadata parse; credentials remain mutable commands", () => {
    const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client") }
    expect(Command.safeParse({ ...base, type: "providers.set", provider: "github-copilot", providerType: "github-copilot", models: [{ id: "claude-fixture", copilotEndpoint: "/v1/messages", maxOutputTokens: 16000 }] }).success).toBe(true)
    for (const type of ["providers.auth.authorize", "providers.auth.action", "providers.set", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })
  test("env credentials leave Copilot off; enabling publishes namespaced models and native requests", async () => {
    const dir = temp(), sent: string[] = []
    const providers = createProviderService({ dir, env: { GITHUB_COPILOT_TOKEN: TOKEN }, fetch: async (url, init) => { sent.push(url); expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`); return new Response('data: {"type":"response.completed","response":{}}\n\n', { headers: { "content-type": "text/event-stream" } }) } })
    expect(providers.list()).toMatchObject([{ id: "github-copilot", enabled: false, hasKey: true }])
    expect(providers.models()).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(providers.set({ id: "github-copilot", enabled: true, models: [{ id: "gpt-5", copilotEndpoint: "/responses" }] })).toMatchObject({ ok: true })
    expect(providers.models()[0]).toMatchObject({ id: "github-copilot:gpt-5", provider: "github-copilot" })
    const request: ModelRequest = { model: "gpt-5", system: "Brief", messages: [{ role: "user", content: "Hi" }], tools: [], signal: new AbortController().signal }
    for await (const _event of providers.runtime()["github-copilot"]!.stream(request)) {}
    expect(sent).toEqual(["https://api.githubcopilot.com/responses"])
    expect(JSON.stringify(providers.list())).not.toContain(TOKEN)
    expect(providers.set({ id: "github-copilot", baseUrl: "http://public.example" })).toMatchObject({ ok: false, code: "invalid_command" })
  })
  test("refresh stores native metadata, preserving the previous catalog on failure", async () => {
    const dir = temp(); let fail = false
    const providers = createProviderService({ dir, env: {}, fetch: async () => fail ? new Response(`Denied ${TOKEN}`, { status: 401 }) : Response.json({ data: [remote, { ...remote, id: "hidden", model_picker_enabled: false }] }) })
    providers.set({ id: "github-copilot", apiKey: TOKEN, enabled: true })
    expect(await providers.refresh("github-copilot")).toMatchObject({ ok: true, provider: { models: [{ id: "gpt-5", copilotEndpoint: "/responses", context: 200000, images: true, variants: { high: { effort: "high" } } }] } })
    const file = path.join(dir, "providers.json"), bytes = readFileSync(file, "utf8")
    expect(providers.models()[0]?.name).toBe("GPT fixture")
    fail = true
    const result = await providers.refresh("github-copilot")
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(readFileSync(file, "utf8")).toBe(bytes)
  })
  test("offline methods/plan/status never contact GitHub or rewrite credentials", () => {
    const dir = temp(), file = path.join(dir, COPILOT_AUTH_FILE)
    const bytes = JSON.stringify({ access: TOKEN, issuer: "https://github.com" })
    writeFileSync(file, bytes); chmodSync(file, 0o644)
    const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("Must not request") } })
    const auth = createProviderAuth({ dir, providers, env: {} }); cleanups.push(() => auth.stop())
    expect(auth.plan("github-copilot")).toMatchObject({ callback: "device", callsProvider: false, writesSecrets: false, method: { id: "device", available: false } })
    expect(auth.methods("github-copilot")["github-copilot"]!.map((entry) => entry.id)).toEqual(["device", "api-key"])
    expect(auth.status("github-copilot")[0]).toMatchObject({ state: "authorized", source: "v2", accountIdPresent: false })
    expect(JSON.stringify([auth.status(), auth.methods(), providers.inventory!({ readOnly: true })])).not.toContain(TOKEN)
    expect(readFileSync(file, "utf8")).toBe(bytes)
    expect(statSync(file).mode & 0o777).toBe(0o644)
  })
  test("typed client device login enables and refreshes models; logout preserves provider config", async () => {
    const dir = temp(); let tick!: () => void
    const fetch = async (url: string) => Response.json(url.endsWith("/device/code") ? { device_code: "fixture-device", user_code: "ABCD-EFGH", verification_uri: "http://127.0.0.1:3210/login/device", interval: 1 } : url.endsWith("/access_token") ? { access_token: TOKEN } : { data: [remote] })
    const copilot = createCopilotAuth({ dir, clientId: "fixture", issuer: "http://127.0.0.1:3210", fetch, wait: (_ms, signal) => new Promise<void>((resolve, reject) => { tick = resolve; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }) }) })
    const providers = createProviderService({ dir, env: {}, copilot, fetch })
    providers.set({ id: "github-copilot", baseUrl: "http://127.0.0.1:3210", apiKeyEnv: "TEAM_COPILOT" })
    const providerAuth = createProviderAuth({ dir, providers, env: {} })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), providers, providerAuth, engine: ({ clock }) => createFauxEngine({ clock }), info: { engine: "native" }, models: { selectable: true, list: () => providers.models(), defaults: { model: "gpt-5" } } })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "Copilot test" }); await client.connect(); cleanups.push(() => client.close())
    expect(await client.providerLoginPlan("github-copilot")).toMatchObject({ ok: true, plan: { callback: "device" } })
    expect(await client.authorizeProvider("github-copilot", "device")).toMatchObject({ ok: true, authorization: { provider: "github-copilot", instructions: "Enter code: ABCD-EFGH" } })
    tick(); await Bun.sleep(5)
    expect(await client.providerAuthStatus("github-copilot")).toMatchObject({ ok: true, statuses: [{ state: "authorized" }] })
    expect(providers.models()[0]?.id).toBe("github-copilot:gpt-5")
    expect(await client.providersCatalog()).toMatchObject({ ok: true, report: { providers: expect.arrayContaining([expect.objectContaining({ id: "github-copilot", enabled: true, authReady: true, credentialStored: true })]) } })
    const file = path.join(dir, "providers.json"), before = readFileSync(file, "utf8")
    expect(await client.providerAuthAction("github-copilot", "refresh")).toMatchObject({ ok: true, status: { state: "authorized" } })
    expect(await client.send({ type: "providers.logout", provider: "github-copilot" })).toMatchObject({ ok: true })
    expect(await client.providerAuthStatus("github-copilot")).toMatchObject({ ok: true, statuses: [{ state: "none" }] })
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(providers.models()).toHaveLength(0)
  }, 15_000)
})
