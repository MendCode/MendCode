import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createChatgptAuth } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderService } from "../src/providers"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderMetadataAuth } from "../src/provider-metadata-auth"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-daemon-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

describe("B10 protocol and daemon", () => {
  test("only methods, sanitized status and a non-executing plan are read-only", () => {
    const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client") }
    for (const type of ["providers.auth.methods", "providers.auth.status", "providers.auth.plan"] as const) {
      expect(Command.safeParse({ ...base, type, provider: "chatgpt" }).success).toBe(true)
      expect(isReadOnlyCommand(type)).toBe(true)
    }
    for (const type of ["providers.auth.authorize", "providers.auth.action", "providers.auth.metadata", "providers.logout", "providers.set"] as const) expect(isReadOnlyCommand(type)).toBe(false)
    expect(Command.safeParse({ ...base, type: "providers.auth.action", provider: "chatgpt", action: "print-tokens" }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "providers.set", provider: "openai", npm: "https://code.example/sdk.ts" }).success).toBe(false)
  })
  test("method labels, default OAuth plan and unknown methods are resolved without HTTP", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {} })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanups.push(() => auth.stop())
    expect(auth.methods("openai").openai!.map((method) => method.id)).toEqual(["browser", "headless", "api-key"])
    expect(auth.plan("openai")).toMatchObject({ executesNow: false, callsProvider: false, writesSecrets: false, callback: "loopback", method: { id: "browser", available: false } })
    expect(auth.plan("openai", "ChatGPT Pro/Plus (headless)").callback).toBe("device")
    expect(() => auth.plan("openai", "bad")).toThrow("Unknown method")
    expect(() => auth.methods("unknown")).toThrow("Unknown provider")
    expect(auth.status("chatgpt")[0]).toMatchObject({ source: "none", state: "none" })
  })
  test("read-only auth reports never rewrite credential bytes or permissions", () => {
    const dir = temp(), providers = createProviderService({ dir, env: {} })
    providers.set({ id: "openai", apiKey: "private-api-key" })
    const file = path.join(dir, "providers.json"), before = readFileSync(file, "utf8")
    chmodSync(file, 0o644)
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanups.push(() => auth.stop())
    const reports = [auth.methods(), auth.status(), auth.plan("openai")]
    expect(JSON.stringify(reports)).not.toContain("private-api-key")
    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(readFileSync(file, "utf8")).toBe(before)
    providers.list()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  test("typed client methods cross the real socket; own logout preserves API config and unrelated Codex fixture", async () => {
    const dir = temp(), donor = path.join(dir, "codex-donor.json")
    writeFileSync(donor, "untouched-donor")
    let callback!: (request: Request) => Promise<Response>
    const providers = createProviderService({ dir, env: {} })
    providers.set({ id: "openai", apiKeyEnv: "TEAM_KEY", models: [{ id: "model" }] })
    const original = readFileSync(path.join(dir, "providers.json"), "utf8")
    const chatgpt = createChatgptAuth({ dir, clientId: "fixture-client", issuer: "https://oauth.example", fetch: async () => Response.json({ access_token: "private-access", refresh_token: "private-refresh", id_token: `x.${Buffer.from(JSON.stringify({ chatgpt_account_id: "private-account" })).toString("base64url")}.y` }), startCallback: (handler) => { callback = handler; return { redirectUri: "http://localhost:1455/auth/callback", close() {} } } })
    const providerAuth = createProviderAuth({ dir, providers, chatgpt, openBrowser: async () => {} })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), providers, providerAuth, engine: ({ clock }) => createFauxEngine({ clock }), info: { engine: "native" } })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "B10" }); await client.connect(); cleanups.push(() => client.close())
    expect(await client.providerAuthMethods("openai")).toMatchObject({ ok: true, methods: { openai: [{ id: "browser" }, { id: "headless" }, { id: "api-key" }] } })
    expect(await client.providerLoginPlan("chatgpt")).toMatchObject({ ok: true, plan: { callsProvider: false } })
    const start = await client.authorizeProvider("chatgpt", "browser")
    if (!start.ok) throw new Error(start.error.message)
    expect(await client.providerAuthStatus("chatgpt")).toMatchObject({ ok: true, statuses: [{ state: "pending" }] })
    const state = new URL(start.authorization.url).searchParams.get("state")!
    await callback(new Request(`http://localhost:1455/auth/callback?${new URLSearchParams({ state, code: "fixture-code" })}`))
    const status = await client.providerAuthStatus("chatgpt")
    expect(status).toMatchObject({ ok: true, statuses: [{ state: "authorized", source: "v2" }] })
    expect(JSON.stringify(status)).not.toContain("private-")
    expect(await client.providersCatalog()).toMatchObject({ ok: true, report: { providers: expect.arrayContaining([expect.objectContaining({ id: "chatgpt", credentialStored: true, authReady: true })]) } })
    expect(await client.send({ type: "providers.logout", provider: "chatgpt" })).toMatchObject({ ok: true })
    expect(await client.providerAuthStatus("chatgpt")).toMatchObject({ ok: true, statuses: [{ state: "none" }] })
    expect(readFileSync(donor, "utf8")).toBe("untouched-donor")
    expect(readFileSync(path.join(dir, "providers.json"), "utf8")).toBe(original)
  }, 15_000)
  test("metadata plans are offline, default off, and remote or unauthenticated execution is refused", async () => {
    const auth = createProviderMetadataAuth({ dir: temp(), env: {}, fetch: async () => { throw new Error("must not request") }, runCommand: async () => { throw new Error("must not spawn") } })
    expect(await auth.login({ url: "http://127.0.0.1:1234" })).toMatchObject({ executesNow: false, enabled: false, callsProvider: false })
    await expect(auth.login({ url: "http://127.0.0.1:1234", execute: true })).rejects.toThrow("enable metadata")
    for (const url of ["https://auth.example", "http://auth.example", "https://10.0.0.5", "http://user:secret@localhost", "http://localhost?token=private"]) await expect(auth.login({ url, execute: true })).rejects.toThrow(/without credentials|MENDCODE_PROVIDER_METADATA_HOSTS/)
  })
  test("public metadata hosts need https and an explicit trusted-host entry, and never receive the local token", async () => {
    const dir = temp(), requests: Array<{ url: string; headers: Headers; redirect?: string }> = [], commands: string[][] = []
    const env = { MENDCODE_PROVIDER_METADATA: "1", MENDCODE_PROVIDER_METADATA_TOKEN: "local-auth", MENDCODE_PROVIDER_METADATA_HOSTS: "Auth.Example.com, *.evil.com, 10.0.0.5" }
    const auth = createProviderMetadataAuth({ dir, env, fetch: async (url, init) => { requests.push({ url, headers: new Headers(init?.headers), ...(init?.redirect ? { redirect: init.redirect } : {}) }); return Response.json({ auth: { env: "TEAM_KEY", command: ["/usr/bin/auth-fixture"] } }) }, runCommand: async (argv) => { commands.push(argv); return "public-host-token\n" } })
    expect(await auth.login({ url: "https://auth.example.com/team" })).toMatchObject({ executesNow: false, callsProvider: false, trustedHost: true, loopbackOnly: false, tokenAuthRequired: false })
    for (const url of ["https://other.example.com", "https://sub.evil.com", "https://10.0.0.5", "http://auth.example.com"]) await expect(auth.login({ url, execute: true })).rejects.toThrow("MENDCODE_PROVIDER_METADATA_HOSTS")
    expect(requests).toHaveLength(0)
    expect(await auth.login({ url: "https://auth.example.com/team/", execute: true })).toMatchObject({ credentialStored: true, environment: "TEAM_KEY", secretsPrinted: false })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: "https://auth.example.com/team/.well-known/opencode", redirect: "error" })
    expect(requests[0]!.headers.get("authorization")).toBeNull()
    expect(commands).toEqual([["/usr/bin/auth-fixture"]])
    expect(auth.keyForEnv("TEAM_KEY")).toBe("public-host-token")
    const off = createProviderMetadataAuth({ dir: temp(), env: { MENDCODE_PROVIDER_METADATA_HOSTS: "auth.example.com" }, fetch: async () => { throw new Error("must not request") }, runCommand: async () => { throw new Error("must not spawn") } })
    await expect(off.login({ url: "https://auth.example.com", execute: true })).rejects.toThrow("enable metadata")
  })
  test("authenticated local metadata executes argv without a shell and supplies only explicitly referenced credentials", async () => {
    const dir = temp(), requests: string[] = [], commands: string[][] = []
    const auth = createProviderMetadataAuth({ dir, env: { MENDCODE_PROVIDER_METADATA: "1", MENDCODE_PROVIDER_METADATA_TOKEN: "local-auth" }, fetch: async (url, init) => { requests.push(url); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-auth"); expect(init?.redirect).toBe("error"); return Response.json({ auth: { env: "TEAM_KEY", command: ["/usr/bin/auth-fixture", "$(never-run)"] } }) }, runCommand: async (argv, directory) => { expect(directory).toBe(dir); commands.push(argv); return "private-metadata-token\n" } })
    const report = await auth.login({ url: "http://127.0.0.1:1234/team/", execute: true })
    expect(report).toMatchObject({ credentialStored: true, environment: "TEAM_KEY", secretsPrinted: false })
    expect(JSON.stringify(report)).not.toContain("private-")
    expect(requests).toEqual(["http://127.0.0.1:1234/team/.well-known/opencode"])
    expect(commands).toEqual([["/usr/bin/auth-fixture", "$(never-run)"]])
    expect(statSync(path.join(dir, "provider-metadata-auth.json")).mode & 0o777).toBe(0o600)
    const providers = createProviderService({ dir, env: {}, keyForEnv: auth.keyForEnv })
    providers.set({ id: "openai", apiKeyEnv: "TEAM_KEY" })
    expect(providers.list()[0]).toMatchObject({ hasKey: true })
    expect(providers.inventory!()[0]).toMatchObject({ credentialStored: false })
    expect(auth.keyForEnv("OTHER_KEY")).toBeUndefined()
  })
  test("invalid metadata and secret-bearing command failures never write credentials or echo output", async () => {
    for (const command of [["relative-command"], ["/bin/auth"]]) {
      const dir = temp()
      const auth = createProviderMetadataAuth({ dir, env: { MENDCODE_PROVIDER_METADATA: "1", MENDCODE_PROVIDER_METADATA_TOKEN: "local-auth" }, fetch: async () => Response.json({ auth: { env: "TEAM_KEY", command } }), runCommand: async () => { throw new Error("private-token") } })
      try { await auth.login({ url: "http://localhost:1234", execute: true }); throw new Error("unexpected success") } catch (error) { expect(String(error)).not.toContain("private-token"); expect(String(error)).toContain("Provider metadata") }
      expect(() => readFileSync(path.join(dir, "provider-metadata-auth.json"))).toThrow()
    }
  })
  test("custom SDK modules are disabled until explicitly enabled and load lazily", async () => {
    const dir = temp(), module = path.join(dir, "sdk.ts"), imported = path.join(dir, "loaded")
    writeFileSync(module, `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(imported)}, "yes")\nexport const createProvider = ({ provider }) => ({ id: provider.id, model: "model", async *stream(request) { yield { type: "text", delta: request.system }; yield { type: "usage", usage: { input: 3, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }; yield { type: "tool_call", call: { callId: "call", name: "read", args: { path: "file" } } }; yield { type: "finish", reason: "tool_calls" } } })`)
    const providers = createProviderService({ dir, env: {} })
    expect(providers.set({ id: "sdk", npm: module, providerType: "openai-compatible", baseUrl: "http://localhost:1234", models: [{ id: "model" }] })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(() => readFileSync(imported)).toThrow()
    expect(providers.models()).toHaveLength(0)
    providers.set({ id: "sdk", enabled: true })
    const runtime = providers.runtime().sdk!
    expect(() => readFileSync(imported)).toThrow()
    const events = []
    for await (const event of runtime.stream({ system: "test", messages: [], tools: [], signal: new AbortController().signal })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(["text", "usage", "tool_call", "finish"])
    expect(readFileSync(imported, "utf8")).toBe("yes")
  })
})
