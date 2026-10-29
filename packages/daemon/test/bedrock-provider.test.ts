import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter, type ModelEvent, type Fetch } from "@mendcode/engine-native"
import { BedrockOptions, Command, ProviderConfig, ProviderInfo, ProviderType, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"
import { createProviderAuth } from "../src/provider-auth"
import { bedrockResponse } from "../../engine-native/test/bedrock-fixtures"

const KEY = "fixture-bedrock-token-never-print"
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-bedrock-daemon-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, env: { AWS_CONFIG_FILE: path.join(dir, "aws-config"), AWS_SHARED_CREDENTIALS_FILE: path.join(dir, "aws-credentials") } as Record<string, string | undefined> }
}
const collect = async (events: AsyncIterable<ModelEvent>) => { const out: ModelEvent[] = []; for await (const event of events) out.push(event); return out }
const fake: Fetch = async (_, init) => { expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`); return bedrockResponse() }

describe("B10.01 Bedrock daemon and protocol", () => {
  test("additive config/protocol, no secrets in options, no new read-only mutation classification", () => {
    const ids = createIdFactory()
    expect(ProviderType.parse("amazon-bedrock")).toBe("amazon-bedrock")
    expect(ProviderConfig.parse({ type: "amazon-bedrock", bedrock: { region: "us-east-1", profile: "team" } }).bedrock?.profile).toBe("team")
    expect(Command.safeParse({ type: "providers.set", id: ids("command"), clientId: ids("client"), provider: "amazon-bedrock", bedrock: { auth: "chain" }, enabled: true }).success).toBe(true)
    expect(BedrockOptions.safeParse({ secretAccessKey: KEY }).success).toBe(false)
    expect(BedrockOptions.safeParse({ region: "evil.example" }).success).toBe(false)
    expect(BedrockOptions.safeParse({ profile: "../secret" }).success).toBe(false)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("AWS environment preset is off; enable routes, live disable refuses and reports stay private", async () => {
    const f = fixture()
    Object.assign(f.env, { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret-fixture", AWS_SESSION_TOKEN: "session-fixture", AWS_REGION: "eu-west-1" })
    let calls = 0
    const providers = createProviderService({ ...f, fetch: async (url, init) => { calls++; expect(url).toContain("bedrock-runtime.eu-west-1.amazonaws.com"); expect(new Headers(init.headers).get("authorization")).toContain("/eu-west-1/bedrock/aws4_request"); return bedrockResponse() } })
    expect(providers.list()[0]).toMatchObject({ id: "amazon-bedrock", type: "amazon-bedrock", enabled: false, hasKey: false, authReady: true, source: "env" })
    expect(providers.models()).toEqual([])
    expect((await providers.test("amazon-bedrock"))?.error).toContain("disabled")
    expect((await providers.refresh("amazon-bedrock")).ok).toBe(false)
    expect(calls).toBe(0)
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not reach subscription") } }, providers: providers.runtime })
    const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "amazon-bedrock:amazon.nova-lite-v1:0", signal: new AbortController().signal }
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    providers.set({ id: "amazon-bedrock", enabled: true })
    expect(providers.models().some((model) => model.id === request.model)).toBe(true)
    expect((await collect(router.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    providers.set({ id: "amazon-bedrock", enabled: false })
    await expect(collect(router.stream(request))).rejects.toThrow("disabled")
    expect(calls).toBe(1)
    const report = JSON.stringify([providers.list(), providers.inventory!()])
    for (const secret of ["AKIDEXAMPLE", "secret-fixture", "session-fixture"]) expect(report).not.toContain(secret)
  })

  test("v1 options precedence, endpoint over baseURL, native SDK mapping and profile-based catalog", async () => {
    const f = fixture()
    f.env.AWS_REGION = "eu-west-1"; f.env.AWS_PROFILE = "env-profile"
    writeFileSync(f.env.AWS_SHARED_CREDENTIALS_FILE!, "[team]\naws_access_key_id=AKIDEXAMPLE\naws_secret_access_key=secret-fixture\n")
    writeFileSync(path.join(f.dir, PROVIDERS_FILE), JSON.stringify({ providers: { "amazon-bedrock": { npm: "@ai-sdk/amazon-bedrock", enabled: true, options: { region: "ap-northeast-1", profile: "team", endpoint: "http://127.0.0.1:1234", baseURL: "https://unused.example" }, models: [{ id: "amazon.nova-lite-v1:0" }] } } }))
    const providers = createProviderService({ ...f, fetch: async (url, init) => { expect(url).toContain("http://127.0.0.1:1234/model/jp."); expect(new Headers(init.headers).get("authorization")).toContain("/ap-northeast-1/bedrock/aws4_request"); return bedrockResponse() } })
    expect(providers.list()[0]).toMatchObject({ type: "amazon-bedrock", enabled: true, baseUrl: "http://127.0.0.1:1234", authReady: true, bedrock: { region: "ap-northeast-1", profile: "team" } })
    expect((await providers.test("amazon-bedrock"))?.ok).toBe(true)
    expect(providers.inventory!().find((entry) => entry.id === "amazon-bedrock")).toMatchObject({ authMode: "aws-chain", configured: true, authReady: true })
  })

  test("bearer wins, login methods and status are offline, secrets remain private on logout", async () => {
    const f = fixture()
    Object.assign(f.env, { AWS_BEARER_TOKEN_BEDROCK: KEY, AWS_PROFILE: "missing" })
    let calls = 0
    const providers = createProviderService({ ...f, fetch: async (url, init) => { calls++; return fake(url, init) } })
    providers.set({ id: "amazon-bedrock", apiKey: "stored-token-never-print", bedrock: { auth: "chain" }, enabled: true })
    const auth = createProviderAuth({ dir: f.dir, providers, env: {} }); cleanup.push(auth.stop)
    expect(auth.methods("amazon-bedrock")["amazon-bedrock"]!.map((entry) => entry.id)).toEqual(["aws-chain", "api-key"])
    expect(auth.plan("amazon-bedrock")).toMatchObject({ method: { id: "aws-chain" }, callback: "none", callsProvider: false })
    expect(auth.status("amazon-bedrock")[0]?.state).toBe("authorized")
    expect(calls).toBe(0)
    expect((await providers.test("amazon-bedrock"))?.ok).toBe(true)
    expect(statSync(path.join(f.dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), auth.status(), providers.inventory!()])).not.toContain("never-print")
    expect(providers.logout!("amazon-bedrock")).toMatchObject({ ok: true, provider: { hasKey: true, enabled: true } })
    expect(readFileSync(path.join(f.dir, PROVIDERS_FILE), "utf8")).not.toContain("stored-token")
    expect(ProviderInfo.safeParse(providers.list()[0]).success).toBe(true)
  })

  test("refresh retains configured model options, failures leave catalog and file untouched", async () => {
    const f = fixture(); f.env.AWS_BEARER_TOKEN_BEDROCK = KEY
    let fail = false
    const providers = createProviderService({ ...f, fetch: async () => fail ? new Response(`${KEY} private`, { status: 403 }) : Response.json({ modelSummaries: [{ modelId: "amazon.nova-lite-v1:0", modelName: "Nova Lite", inputModalities: ["TEXT"], outputModalities: ["TEXT"], responseStreamingSupported: true }] }) })
    providers.set({ id: "amazon-bedrock", enabled: true, models: [{ id: "amazon.nova-lite-v1:0", context: 300_000, effort: true, variants: { high: { parameters: { temperature: 0 } } } }] })
    expect((await providers.refresh("amazon-bedrock")).ok).toBe(true)
    expect(providers.list()[0]!.models[0]).toMatchObject({ id: "amazon.nova-lite-v1:0", context: 300_000, effort: true, variants: { high: { parameters: { temperature: 0 } } } })
    const before = readFileSync(path.join(f.dir, PROVIDERS_FILE), "utf8")
    fail = true
    const failed = await providers.refresh("amazon-bedrock")
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(failed)).not.toContain(KEY)
    expect(readFileSync(path.join(f.dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("invalid settings/endpoints are rejected, invalid legacy settings do not break other providers", () => {
    const f = fixture()
    const providers = createProviderService(f)
    for (const baseUrl of ["http://remote.example", "https://user:secret@example.com", "https://example.com?q=secret"]) expect(providers.set({ id: "amazon-bedrock", baseUrl }).ok).toBe(false)
    expect(providers.set({ id: "openai", bedrock: { auth: "chain" } }).ok).toBe(false)
    writeFileSync(path.join(f.dir, PROVIDERS_FILE), JSON.stringify({ providers: { "amazon-bedrock": { enabled: true, options: { region: "bad.example" } }, ollama: {} } }))
    expect(providers.list().find((entry) => entry.id === "amazon-bedrock")).toMatchObject({ enabled: false, error: "invalid Bedrock settings" })
    expect(providers.list().find((entry) => entry.id === "ollama")).toMatchObject({ enabled: true })
  })

  test("daemon + typed client configure, test, select namespaced model and disable without leaks", async () => {
    const f = fixture()
    const providers = createProviderService({ ...f, fetch: fake })
    const daemon = await startDaemon({ dir: f.dir, socketPath: path.join(f.dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "amazon-bedrock:amazon.nova-lite-v1:0" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-01" }); cleanup.push(() => client.close())
    await client.connect()
    const saved = await client.configureBedrock({ apiKey: KEY, bedrock: { region: "us-east-1", auth: "bearer" }, models: [{ id: "amazon.nova-lite-v1:0" }] })
    expect(saved).toMatchObject({ ok: true, provider: { enabled: false, type: "amazon-bedrock" } })
    expect(await client.providerLoginPlan("amazon-bedrock", "aws-chain")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    expect(await client.configureBedrock({ enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
    expect(await client.send({ type: "providers.test", provider: "amazon-bedrock" })).toMatchObject({ ok: true, result: { ok: true } })
    const session = await client.send({ type: "session.create", directory: f.dir })
    if (!session.ok) throw new Error("session creation failed")
    expect((await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "amazon-bedrock:amazon.nova-lite-v1:0" } })).ok).toBe(true)
    expect(await client.configureBedrock({ enabled: false })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(JSON.stringify([saved, await client.providersCatalog()])).not.toContain(KEY)
  }, 15_000)
})
