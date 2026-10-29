import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createChatgptAuth } from "@mendcode/engine-native"
import { createMcpAuth, createMcpManager, loadMcpConfig, type McpClient } from "@mendcode/mcp"
import { createIdFactory, type RestTool } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { createProviderService } from "../src/providers"
import { createProviderAuth } from "../src/provider-auth"
import { remoteTokens } from "../src/remote"
import { httpConfig, httpOpenApi } from "../src/http"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const ids = createIdFactory()
const privateKey = "private-fixture-api-key"
const tools: RestTool[] = [{ id: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }, { id: "local_echo", description: "Local extension", parameters: { type: "object" } }]
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b83-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
function put(root: string, name: string, value: string) { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); return file }

async function boot(plugin = false) {
  const dir = temp(), project = temp()
  const tokens = remoteTokens(dir)
  const full = tokens.create({ name: "full" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const calls: string[] = []
  const providers = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("No provider requests in catalog tests") } })
  providers.set({ id: "openai", models: [{ id: "test-model", tool_call: true }, { id: "no-tools", tool_call: false }] })
  let callback!: (request: Request) => Promise<Response>
  const chatgpt = createChatgptAuth({ dir, clientId: "fixture-client", issuer: "https://auth.example.invalid", startCallback: (handler) => { callback = handler; return { redirectUri: "http://127.0.0.1:1455/auth/callback", close() {} } }, fetch: async (_url, init) => {
    calls.push("provider-exchange")
    expect(String(init?.body)).toContain("code_verifier=")
    return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ chatgpt_account_id: "fixture-account" })).toString("base64url")}.x` })
  } })
  const auth = createProviderAuth({ dir, providers, chatgpt, env: {} })
  if (plugin) {
    const file = put(dir, "fixture-plugin.ts", `export default async () => ({
      auth: {
        provider: "local",
        methods: [{
          type: "oauth", label: "Code login",
          async authorize(inputs: Record<string, string>) {
            if (inputs.team !== "example") throw new Error("private-auth-failure")
            return {
              url: "https://auth.example.invalid/login", instructions: "Enter code", method: "code",
              async callback(code?: string) {
                if (code === "delayed") await Bun.sleep(25)
                return ["fixture-code", "delayed"].includes(code ?? "")
                  ? { type: "success", access: "private-plugin-access", refresh: "private-plugin-refresh", expires: Date.now() + 60000 }
                  : { type: "failed" }
              },
            }
          },
        }],
      },
    })`)
    put(dir, "mendcode.json", JSON.stringify({ pluginCompatibility: true, plugin: [pathToFileURL(file).href] }))
  }
  const mcpAuth = createMcpAuth({ dir, startCallback: async () => {
    let finish!: (code: string) => void, fail!: (error: Error) => void, completed = false
    const done = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject })
    done.catch(() => undefined)
    return { redirectUri: "http://127.0.0.1:19876/callback", done, complete(code) { if (completed) throw new Error("Already completed"); completed = true; finish(code) }, close() { if (!completed) { completed = true; fail(new Error("Cancelled")) } } }
  }, fetch: async (url, init) => {
    calls.push(`mcp:${new URL(url).pathname}`)
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.invalid/mcp", authorization_servers: ["https://auth.example.invalid"] })
    if (url.includes("oauth-authorization-server")) return Response.json({ issuer: "https://auth.example.invalid", authorization_endpoint: "https://auth.example.invalid/authorize", token_endpoint: "https://auth.example.invalid/token", code_challenge_methods_supported: ["S256"] })
    if (url.endsWith("/token")) { expect(String(init?.body)).toContain("code_verifier="); return Response.json({ access_token: "private-mcp-access", refresh_token: "private-mcp-refresh", expires_in: 3600 }) }
    throw new Error("Unexpected fake request")
  } })
  const mcp = createMcpManager({ auth: mcpAuth, configLoader: (directory) => loadMcpConfig({ directory, userDir: dir, env: {} }), clientFactory: ({ name }) => {
    let state: McpClient["state"] = "stopped"
    return { name, get state() { return state }, get alive() { return state === "running" }, pid: undefined, toolCount: 1, lastError: undefined,
      async start() { calls.push(`start:${name}`); state = "running" }, async listTools() { state = "running"; return [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] },
      async callTool() { throw new Error("No tools execute in catalog tests") }, async close() { calls.push(`stop:${name}`); state = "stopped" }, stderr: () => "",
      async catalog() { return { resources: [{ name: "Guide", uri: "doc://guide", mimeType: "text/plain" }], prompts: [], templates: [] } },
    }
  } })
  cleanup.push(() => mcp.stop())
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true }, httpListen: false, extensionsEnabled: plugin,
    providers, providerAuth: auth, mcp, models: { selectable: true, defaults: { model: "openai:test-model" }, list: () => providers.models() },
    lsp: { query: async () => ({ result: [] }), status: (directory) => [{ id: "local-lsp", name: "Local LSP", root: directory, status: "connected" }] },
    formatter: { file: async ({ path }) => ({ file: path, formatted: false, results: [], issues: [] }), status: async () => ({ formatters: [{ name: "local-fmt", extensions: [".ts"], enabled: true }], issues: [] }) },
    engine: ({ clock }) => ({ ...createFauxEngine({ clock }), catalogTools: async ({ directory }) => { calls.push(`tools:${directory}`); return tools } }),
  })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B83", timeoutMs: 1000 })
  cleanup.push(() => client.close())
  await client.connect()
  const request = async (route: string, method = "GET", value?: unknown, token = full, headers: Record<string, string> = {}, signal?: AbortSignal) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), ...(signal ? { signal } : {}) }))
    if (!response) throw new Error("Unexpected WebSocket response")
    return response
  }
  const addRemote = () => request("/mcp", "POST", { name: "docs", config: { type: "remote", url: "https://mcp.example.invalid/mcp", oauth: { clientId: "fixture" }, timeout: 1000 } })
  return { dir, project, tokens, full, observer, calls, providers, auth, mcp, callback: (request: Request) => callback(request), daemon, client, request, addRemote }
}

test("B83 catalogs return donor envelopes, real schemas/default models, templates and native status", async () => {
  const h = await boot()
  await h.request("/auth/openai", "PUT", { type: "api", key: privateKey })
  put(h.project, ".mendcode/commands/check.md", "---\ndescription: Check changes\n---\nReview $ARGUMENTS")
  put(h.project, ".mendcode/skills/local/SKILL.md", "---\nname: local\ndescription: Local skill\n---\nRead the guide")
  const providers = await (await h.request("/provider")).json()
  expect(providers).toMatchObject({ connected: ["openai"], default: { openai: "test-model" } })
  expect(providers.all.find((entry: { id: string }) => entry.id === "openai").models["test-model"]).toMatchObject({ id: "test-model", providerID: "openai" })
  expect(Object.keys(providers.all.find((entry: { id: string }) => entry.id === "anthropic").models).length).toBeGreaterThan(0)
  expect(JSON.stringify(providers)).not.toContain(privateKey)
  expect(await (await h.request("/config/providers")).json()).toMatchObject({ providers: [expect.objectContaining({ id: "openai" })], default: { openai: "test-model" } })
  expect(await (await h.request("/provider/auth")).json()).toMatchObject({ openai: [{ type: "oauth" }, { type: "oauth" }, { type: "api" }] })
  expect(await (await h.request("/experimental/tool?provider=openai&model=test-model")).json()).toEqual(tools)
  expect(await (await h.request("/experimental/tool/ids")).json()).toEqual(["read", "local_echo"])
  expect(await (await h.request("/experimental/tool?provider=openai&model=no-tools")).json()).toEqual([])
  expect((await h.request("/experimental/tool?provider=openai&model=missing")).status).toBe(400)
  expect((await h.request("/experimental/tool")).status).toBe(400)
  expect(await (await h.request("/command")).json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "check", template: "Review $ARGUMENTS" })]))
  expect(await (await h.request("/agent")).json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "build" }), expect.objectContaining({ name: "plan" })]))
  expect(await (await h.request("/skill")).json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "local", location: path.join(h.project, ".mendcode/skills/local/SKILL.md") })]))
  expect(await (await h.request("/lsp")).json()).toEqual([{ id: "local-lsp", name: "Local LSP", root: h.project, status: "connected" }])
  expect(await (await h.request("/formatter")).json()).toEqual([{ name: "local-fmt", extensions: [".ts"], enabled: true }])
  expect(await h.client.restCatalog(h.project, { operation: "tool-ids" })).toMatchObject({ ok: true, result: { value: ["read", "local_echo"] } })
  const native = await h.request("/command", "POST", { id: ids("command"), clientId: ids("client"), type: "providers.list" })
  expect(native.status).toBe(200)
  expect(h.calls.every((call) => call.startsWith("tools:"))).toBe(true)
})

test("B83 credentials persist privately, remove idempotently, and unsupported imports fail atomically", async () => {
  const h = await boot()
  expect(await (await h.request("/auth/openai", "PUT", { type: "api", key: privateKey })).json()).toBe(true)
  expect(statSync(path.join(h.dir, "providers.json")).mode & 0o777).toBe(0o600)
  const before = readFileSync(path.join(h.dir, "providers.json"), "utf8")
  for (const credential of [{ type: "api", key: privateKey, metadata: { private: privateKey } }, { type: "oauth", access: privateKey, refresh: "", expires: 0, enterpriseUrl: "https://example.invalid" }]) {
    const response = await h.request("/auth/openai", "PUT", credential)
    expect([400, 501]).toContain(response.status)
    expect(JSON.stringify(await response.json())).not.toContain(privateKey)
  }
  expect(readFileSync(path.join(h.dir, "providers.json"), "utf8")).toBe(before)
  expect((await h.request("/auth/openai", "PUT", { type: "api", key: "\n", extra: true })).status).toBe(400)
  expect(await (await h.request("/auth/openai", "DELETE")).json()).toBe(true)
  expect(await (await h.request("/auth/openai", "DELETE")).json()).toBe(true)
  expect(h.providers.list()[0]?.models).toHaveLength(2)
  expect(h.providers.list()[0]?.hasKey).toBe(false)
  expect(await (await h.request("/auth/chatgpt", "PUT", { type: "oauth", access: "private-access", refresh: "private-refresh", expires: Date.now() + 3600000, accountId: "fixture-account" })).json()).toBe(true)
  expect(h.auth.chatgpt.status().state).toBe("authorized")
  expect((await h.request("/auth/chatgpt", "DELETE")).status).toBe(200)
  expect(h.auth.chatgpt.status().state).toBe("none")
})

test("R9 well-known credentials are stored privately, resolve through apiKeyEnv and are removed with the provider auth", async () => {
  const h = await boot()
  expect((await h.request("/auth/openai", "PUT", { type: "wellknown", key: "bad name", token: privateKey })).status).toBe(400)
  expect(await (await h.request("/auth/openai", "PUT", { type: "wellknown", key: "PRIVATE_FIXTURE_TOKEN", token: privateKey })).json()).toBe(true)
  const file = path.join(h.dir, "provider-metadata-auth.json")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(Object.values(JSON.parse(readFileSync(file, "utf8")))).toEqual([{ env: "PRIVATE_FIXTURE_TOKEN", token: privateKey }])
  expect(h.auth.metadata.keyForEnv("PRIVATE_FIXTURE_TOKEN")).toBe(privateKey)
  expect(JSON.stringify(await (await h.request("/provider")).json())).not.toContain(privateKey)
  expect(await (await h.request("/auth/openai", "DELETE")).json()).toBe(true)
  expect(h.auth.metadata.keyForEnv("PRIVATE_FIXTURE_TOKEN")).toBeUndefined()
  expect((await h.request("/auth/openai", "PUT", { type: "wellknown", key: "PRIVATE_FIXTURE_TOKEN", token: privateKey }, h.observer)).status).toBe(403)
})

test("R9 API credential metadata maps to native provider settings and unknown metadata is refused without mutation", async () => {
  const h = await boot()
  h.providers.set({ id: "cloudflare-workers-ai", enabled: false })
  expect(await (await h.request("/auth/cloudflare-workers-ai", "PUT", { type: "api", key: privateKey, metadata: { accountId: "acct-fixture" } })).json()).toBe(true)
  expect(readFileSync(path.join(h.dir, "providers.json"), "utf8")).toContain("acct-fixture")
  const before = readFileSync(path.join(h.dir, "providers.json"), "utf8")
  const refused = await h.request("/auth/cloudflare-workers-ai", "PUT", { type: "api", key: "other-private-key", metadata: { gatewayId: "nope" } })
  expect(refused.status).toBe(400)
  expect(JSON.stringify(await refused.json())).not.toContain("other-private-key")
  expect((await h.request("/auth/openai", "PUT", { type: "api", key: "other-private-key", metadata: { accountId: "x" } })).status).toBe(400)
  expect(readFileSync(path.join(h.dir, "providers.json"), "utf8")).toBe(before)
})

test("R9 manual and enterprise Copilot OAuth import validates the endpoint and never echoes tokens", async () => {
  const h = await boot()
  const access = "ghu_privateFixtureAccessToken"
  expect((await h.request("/auth/github-copilot", "PUT", { type: "oauth", access, refresh: access, expires: 0, enterpriseUrl: "http://evil.example.com" })).status).toBe(400)
  expect((await h.request("/auth/github-copilot", "PUT", { type: "oauth", access, refresh: access, expires: 0, enterpriseUrl: "https://user:pw@octo.example.com" })).status).toBe(400)
  expect(h.auth.copilot.status().state).not.toBe("authorized")
  expect(await (await h.request("/auth/github-copilot", "PUT", { type: "oauth", access, refresh: access, expires: 0 })).json()).toBe(true)
  expect(h.auth.copilot.status()).toMatchObject({ provider: "github-copilot", source: "v2", state: "authorized" })
  expect(h.auth.copilot.token()).toBe(access)
  expect(statSync(path.join(h.dir, "github-copilot-auth.json")).mode & 0o777).toBe(0o600)
  expect(await (await h.request("/auth/github-copilot-enterprise", "PUT", { type: "oauth", access, refresh: access, expires: Date.now() + 3_600_000, enterpriseUrl: "octo.example.com" })).json()).toBe(true)
  expect(readFileSync(path.join(h.dir, "providers.json"), "utf8")).toContain("https://copilot-api.octo.example.com")
  expect(JSON.parse(readFileSync(path.join(h.dir, "github-copilot-auth.json"), "utf8"))).not.toHaveProperty("refresh")
  expect(JSON.stringify(await (await h.request("/provider")).json())).not.toContain(access)
  expect(await (await h.request("/auth/github-copilot", "DELETE")).json()).toBe(true)
  expect(h.auth.copilot.token()).toBeUndefined()
})

test("B83 native provider OAuth supports indexed start/callback without browser launch or credential output", async () => {
  const h = await boot()
  expect((await h.request("/provider/openai/oauth/callback", "POST", { method: 0 })).status).toBe(400)
  const response = await h.request("/provider/openai/oauth/authorize", "POST", { method: 0 })
  expect(response.status).toBe(200)
  const start = await response.json()
  expect(start).toMatchObject({ method: "auto", instructions: "Complete authorization in your browser" })
  expect(new URL(start.url).searchParams.get("code_challenge_method")).toBe("S256")
  expect((await h.callback(new Request("http://127.0.0.1:1455/auth/callback?state=wrong&code=fixture-code"))).status).toBe(400)
  expect((await h.request("/provider/openai/oauth/callback", "POST", { method: 1, code: "fixture-code" })).status).toBe(400)
  expect(await (await h.request("/provider/openai/oauth/callback", "POST", { method: 0, code: "fixture-code" })).json()).toBe(true)
  expect((await h.request("/provider/openai/oauth/callback", "POST", { method: 0, code: "fixture-code" })).status).toBe(400)
  expect(h.auth.chatgpt.status().state).toBe("authorized")
  expect(h.calls).toEqual(["provider-exchange"])
  expect(JSON.stringify(start)).not.toContain("private-")
})

test("B83 plugin provider methods, inputs, one-use callback and credential removal stay project-bound", async () => {
  const h = await boot(true)
  expect(await (await h.request("/provider/auth")).json()).toMatchObject({ local: [{ label: "Code login", type: "oauth" }] })
  const bad = await h.request("/provider/local/oauth/authorize", "POST", { method: 0, inputs: { team: "wrong" } })
  expect(bad.status).toBe(400)
  expect(JSON.stringify(await bad.json())).not.toContain("private-")
  expect((await h.request("/provider/local/oauth/authorize", "POST", { method: 0, inputs: { team: "example" } })).status).toBe(200)
  const other = temp()
  await h.request("/experimental/workspace", "POST", { name: "other", directory: other })
  expect((await h.request(`/provider/local/oauth/callback?directory=${encodeURIComponent(other)}`, "POST", { method: 0, code: "fixture-code" })).status).toBe(400)
  expect(await (await h.request("/provider/local/oauth/callback", "POST", { method: 0, code: "fixture-code" })).json()).toBe(true)
  expect(statSync(path.join(h.dir, "plugin-auth.json")).mode & 0o777).toBe(0o600)
  expect((await h.request("/auth/local", "DELETE")).status).toBe(200)
  expect(JSON.parse(readFileSync(path.join(h.dir, "plugin-auth.json"), "utf8"))).toEqual({})
  await h.request("/provider/local/oauth/authorize", "POST", { method: 0, inputs: { team: "example" } })
  const delayed = h.request("/provider/local/oauth/callback", "POST", { method: 0, code: "delayed" })
  await Bun.sleep(5)
  await h.request("/auth/local", "DELETE")
  expect((await delayed).status).toBe(400)
  expect(JSON.parse(readFileSync(path.join(h.dir, "plugin-auth.json"), "utf8"))).toEqual({})
})

test("B83 REST MCP setup waits for local approval; connect, resources and authentication use native state", async () => {
  const h = await boot()
  const pending = await h.addRemote()
  expect(pending.status).toBe(202)
  expect(await pending.json()).toMatchObject({ docs: { status: "pending" } })
  expect(h.calls).toEqual([])
  const status = await h.client.send({ type: "mcp.status", directory: h.project })
  if (!status.ok) throw new Error("missing status")
  const revision = (status.result as { servers: Array<{ pending: { revision: string } }> }).servers[0]!.pending.revision
  expect(await h.client.send({ type: "mcp.decide", directory: h.project, scope: "project", server: "docs", revision, approve: true })).toMatchObject({ ok: true })
  expect(JSON.parse(readFileSync(path.join(h.project, ".mendcode/mcp.json"), "utf8")).servers.docs.timeoutMs).toBe(1000)
  expect(await (await h.request("/experimental/resource")).json()).toMatchObject({ "docs:Guide": { name: "Guide", uri: "doc://guide", client: "docs" } })
  const start = await (await h.request("/mcp/docs/auth", "POST")).json()
  expect(start.authorizationUrl).toContain("code_challenge_method=S256")
  expect(start.oauthState).toBeTruthy()
  expect(await (await h.request("/mcp")).json()).toEqual({ docs: { status: "needs_auth" } })
  expect(await (await h.request("/mcp/docs/auth/callback", "POST", { code: "fixture-code" })).json()).toEqual({ status: "connected" })
  expect((await h.request("/mcp/docs/auth/callback", "POST", { code: "fixture-code" })).status).toBe(400)
  expect(statSync(path.join(h.dir, "mcp-auth.json")).mode & 0o777).toBe(0o600)
  expect(await (await h.request("/mcp/docs/auth", "DELETE")).json()).toEqual({ success: true })
  const authenticate = await h.request("/mcp/docs/auth/authenticate", "POST")
  expect(authenticate.status).toBe(202)
  expect((await authenticate.json()).authorizationUrl).toContain("/authorize?")
  const waiting = h.request("/mcp/docs/auth/authenticate", "POST")
  await Bun.sleep(5)
  await h.request("/mcp/docs/auth/callback", "POST", { code: "fixture-code" })
  expect(await (await waiting).json()).toEqual({ status: "connected" })
  expect(await (await h.request("/mcp/docs/disconnect", "POST")).json()).toBe(true)
  expect(await (await h.request("/mcp")).json()).toEqual({ docs: { status: "disabled" } })
  const count = h.calls.filter((call) => call === "start:docs").length
  expect(await h.mcp.listTools(h.project)).toEqual({ tools: [], issues: [] })
  expect(h.calls.filter((call) => call === "start:docs")).toHaveLength(count)
  expect(await (await h.request("/mcp/docs/connect", "POST")).json()).toBe(true)
  expect((await h.request("/mcp", "POST", { name: "local", config: { type: "local", command: ["fake", "--flag"], cwd: "sub", environment: { FIXTURE: "yes" }, enabled: false } })).status).toBe(202)
  expect(await h.client.send({ type: "mcp.add", directory: h.project, scope: "project", name: "local", replace: true, config: { command: "fake", args: ["--flag"], cwd: "sub", env: { FIXTURE: "yes" }, enabled: false } })).toMatchObject({ ok: true })
  expect(JSON.parse(readFileSync(path.join(h.project, ".mendcode/mcp.json"), "utf8")).servers.local).toMatchObject({ command: "fake", args: ["--flag"], cwd: "sub", env: { FIXTURE: "yes" }, enabled: false })
})

test("B83 every REST route denies observers before executing, validates workspace and retains wire OpenAPI", async () => {
  const h = await boot()
  for (const [route, method] of [["/config/providers", "GET"], ["/auth/openai", "PUT"], ["/auth/openai", "DELETE"], ["/experimental/tool", "GET"], ["/experimental/tool/ids", "GET"], ["/command", "GET"], ["/agent", "GET"], ["/skill", "GET"], ["/lsp", "GET"], ["/formatter", "GET"], ["/mcp", "GET"], ["/mcp", "POST"], ["/mcp/docs/auth", "POST"], ["/mcp/docs/auth/callback", "POST"], ["/mcp/docs/auth/authenticate", "POST"], ["/mcp/docs/auth", "DELETE"], ["/mcp/docs/connect", "POST"], ["/mcp/docs/disconnect", "POST"], ["/provider", "GET"], ["/provider/auth", "GET"], ["/provider/openai/oauth/authorize", "POST"], ["/provider/openai/oauth/callback", "POST"]]) {
    expect((await h.request(route!, method!, undefined, h.observer)).status).toBe(403)
  }
  expect(h.calls).toEqual([])
  expect(httpConfig(h.dir).enabled).toBe(false)
  expect((await h.request("/provider?directory=/unregistered")).status).toBe(403)
  expect((await h.request("/provider", "GET", undefined, h.full, { Origin: "https://other.example.invalid" })).status).toBe(403)
  const api = httpOpenApi()
  expect(api.paths["/command"]).toHaveProperty("post.operationId", "command.execute")
  expect(api.paths["/command"]).toHaveProperty("get.operationId", "command.list")
  expect((api.paths as Record<string, unknown>)["/auth/{providerID}"]).toHaveProperty("put.operationId", "auth.set")
  const abort = new AbortController(); abort.abort()
  expect((await h.request("/mcp/docs/connect", "POST", undefined, h.full, {}, abort.signal)).status).toBe(400)
  expect(h.calls).toEqual([])
  expect((await h.request("/auth/openai", "PUT", { type: "api", key: "key" }, "invalid-token")).status).toBe(401)
})
