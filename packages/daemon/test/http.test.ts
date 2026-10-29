import { afterEach, expect, test } from "bun:test"
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, isReadOnlyCommand, MAX_FRAME_BYTES } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { httpConfig, httpOpenApi } from "../src/http"
import { remoteListenerConfig, remoteTokens } from "../src/remote"
import { createWorkspaces } from "../src/workspaces"
import { HTTP_WEB } from "../src/http-web"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
const ids = createIdFactory()
async function boot() {
  const dir = tempDir(), project = realpathSync(tempDir())
  const tokens = remoteTokens(dir)
  const full = tokens.create({ name: "full" }).token
  const observer = tokens.create({ name: "observer", readOnly: true }).token
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true, cors: ["https://client.example"] }, httpListen: false, web: HTTP_WEB, extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const clientId = ids("client")
  const request = async (route: string, options: { method?: string; value?: unknown; token?: string; authorization?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: options.authorization ?? `Bearer ${options.token ?? full}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }), ...(options.signal ? { signal: options.signal } : {}) }))
  const command = (input: Record<string, unknown>, extra: Parameters<typeof request>[1] = {}) => request("/command", { ...extra, value: { id: ids("command"), clientId, ...input } })
  return { daemon, dir, project, tokens, full, observer, clientId, request, command }
}

test("HTTP is opt-in, validates loopback/config/CORS, and keeps TCP settings", () => {
  const dir = tempDir()
  expect(httpConfig(dir)).toMatchObject({ enabled: false, hostname: "127.0.0.1", port: 0, mdns: false })
  writeFileSync(path.join(dir, "remote.json"), JSON.stringify({ listen: "127.0.0.1:9010", server: { port: 4096, mdns: true, mdnsDomain: "review.local", cors: ["https://client.example"] } }))
  expect(() => httpConfig(dir)).toThrow("remove server.mdns")
  expect(remoteListenerConfig(dir, {})).toEqual({ listen: "127.0.0.1:9010" })
  expect(httpConfig(dir, { enabled: true, port: 0, mdns: false })).toMatchObject({ enabled: true, port: 0, mdns: false, mdnsDomain: "review.local", cors: ["https://client.example"] })
  expect(() => httpConfig(dir, { hostname: "0.0.0.0" as never })).toThrow("loopback")
  for (const cors of [["*"], ["https://client.example/path"], ["https://user:password@client.example"]]) expect(() => httpConfig(dir, { cors })).toThrow()
})

test("HTTP health/OpenAPI require tokens; Basic uses a remote token, no auth details leak", async () => {
  const h = await boot()
  const basic = await h.request("/global/health", { authorization: `Basic ${Buffer.from(`mendcode:${h.full}`).toString("base64")}` })
  expect(basic!.status).toBe(200)
  expect(await basic!.json()).toMatchObject({ healthy: true, mdns: { published: false, reason: "loopback listener" } })
  const spec = await h.request("/doc")
  expect(spec!.status).toBe(200)
  const api = await spec!.json()
  expect(api.openapi).toBe("3.1.0")
  expect(api.components.schemas.Command).toBeDefined()
  expect(api.paths["/command"].post.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/Command")
  expect(JSON.stringify(api)).not.toContain(h.full)
  const refused = await h.request("/global/health", { authorization: "Basic private-secret" })
  expect(refused!.status).toBe(401)
  expect(await refused!.text()).not.toContain("private-secret")
  expect((await h.request("/global/health"))!.status).toBe(429)
})

test("the HTTP web shell also requires a remote token", async () => {
  const h = await boot()
  const authorized = await h.request("/", { authorization: `Basic ${Buffer.from(`mendcode:${h.full}`).toString("base64")}` })
  expect(authorized!.status).toBe(200)
  expect(await authorized!.text()).toBe(HTTP_WEB)
  const unauthorized = await h.request("/", { authorization: "" })
  expect(unauthorized!.status).toBe(401)
  expect(unauthorized!.headers.get("www-authenticate")).toContain("Basic")
  const body = await unauthorized!.text()
  expect(body).not.toContain(HTTP_WEB)
  expect(body).not.toContain(h.full)
})

test("the opt-in REST listener binds literal loopback and keeps credentials out of responses and logs", async () => {
  const dir = tempDir(), logs: string[] = []
  const token = remoteTokens(dir).create({ name: "network-audit" }).token
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true, hostname: "localhost", port: 0 }, extensionsEnabled: false, log: (_level, text) => logs.push(text), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const url = new URL(daemon.httpUrl!)
  expect(url.hostname).toBe("127.0.0.1")
  expect(daemon.httpPort).toBeGreaterThan(0)
  const allowed = await fetch(new URL("/global/health", url), { headers: { authorization: `Bearer ${token}` } })
  expect(allowed.status).toBe(200)
  expect(await allowed.text()).not.toContain(token)
  const denied = await fetch(new URL("/global/health", url))
  expect(denied.status).toBe(401)
  expect(await denied.text()).not.toContain(token)
  expect(logs.join("\n")).not.toContain(token)
})

test("CORS exact origins and preflight, JSON bounds/unknown schemas are rejected before dispatch", async () => {
  const h = await boot()
  expect((await h.request("/global/health", { headers: { Origin: "https://evil.example" } }))!.status).toBe(403)
  const preflight = await h.request("/command", { method: "OPTIONS", authorization: "", headers: { Origin: "https://client.example" } })
  expect(preflight!.status).toBe(204)
  expect(preflight!.headers.get("access-control-allow-origin")).toBe("https://client.example")
  expect(preflight!.headers.get("access-control-allow-credentials")).toBeNull()
  expect((await h.command({ type: "secret.invalid", payload: "private-secret" }))!.status).toBe(400)
  const large = await h.command({ type: "session.create", directory: h.project, title: "x".repeat(MAX_FRAME_BYTES + 1) })
  expect(large!.status).toBe(400)
  expect(h.daemon.store.listSessions()).toHaveLength(0)
})

test("REST bridge creates/lists/forks and replays command ids once; read-only denied before cache", async () => {
  const h = await boot()
  const input = { type: "session.create", directory: h.project, title: "HTTP session", id: ids("command") }
  const first = await h.command(input)
  const created = await first!.json()
  expect((await (await h.command(input))!.json()).sessionId).toBe(created.sessionId)
  expect(h.daemon.store.listSessions()).toHaveLength(1)
  const list = await h.command({ type: "session.list", roots: true }, { token: h.observer })
  expect(await list!.json()).toMatchObject({ sessions: [{ sessionId: created.sessionId }] })
  const fork = await h.command({ type: "session.fork", sessionId: created.sessionId, transcript: true })
  expect(fork!.status).toBe(200)
  expect((await fork!.json()).sessionId).not.toBe(created.sessionId)
  for (const type of ["session.create", "secrets.reveal", "workspace.create"]) {
    const command = type === "session.create" ? input : type === "secrets.reveal" ? { type, sessionId: created.sessionId, n: 1 } : { type, adapter: "local", name: "local", directory: h.project }
    const refused = await h.command(command, { token: h.observer })
    expect(refused!.status).toBe(403)
  }
  expect(isReadOnlyCommand("workspace.query")).toBe(false)
  expect(isReadOnlyCommand("workspace.create")).toBe(false)
  expect(isReadOnlyCommand("workspace.remove")).toBe(false)
  h.tokens.revoke("full")
  expect((await h.command(input))!.status).toBe(401)
})

test("local workspace provisioner persists and routes canonical directories; no cross-project session or cached replies", async () => {
  const h = await boot(), project = realpathSync(tempDir())
  const rootSession = await (await h.command({ type: "session.create", directory: h.project }))!.json()
  const registered = await (await h.request("/experimental/workspace", { value: { name: "review", directory: project, adapter: "local" } }))!.json()
  const workspace = registered.workspace
  expect(workspace.type).toBe("local")
  expect(createWorkspaces(h.dir, h.project).list()).toContainEqual(workspace)
  expect(statSync(path.join(h.dir, "http-workspaces.json")).mode & 0o777).toBe(0o600)
  const headers = { "X-Mendcode-Workspace": workspace.id }
  const selected = await h.command({ type: "session.create", directory: project }, { headers })
  expect(selected!.status).toBe(200)
  expect((await h.command({ type: "session.get", sessionId: rootSession.sessionId }, { headers }))!.status).toBe(403)
  expect((await h.command({ type: "session.create", directory: h.project }, { headers }))!.status).toBe(403)
  expect((await h.command({ type: "session.create", directory: project, parentId: rootSession.sessionId }, { headers }))!.status).toBe(403)
  const input = { type: "session.list", id: ids("command") }
  expect((await (await h.command(input))!.json()).sessions).toHaveLength(1)
  const other = await (await h.command(input, { headers }))!.json()
  expect(other.sessions).toHaveLength(1)
  expect(other.sessions[0].directory).toBe(project)
  expect((await h.command({ type: "session.list" }, { headers: { "x-opencode-directory": tempDir() } }))!.status).toBe(403)
  const deleted = await h.request(`/experimental/workspace/${workspace.id}`, { method: "DELETE" })
  expect(deleted!.status).toBe(200)
  expect(existsSync(project)).toBe(true)
  expect((await h.command(input, { headers }))!.status).toBe(403)
})

test("SSE reuses replay/live frames and cleans subscriptions on cancellation", async () => {
  const h = await boot()
  const created = await (await h.command({ type: "session.create", directory: h.project }))!.json()
  const hello = await h.request("/event", { value: { clientId: h.clientId, hello: true }, token: h.observer })
  expect(await hello!.json()).toMatchObject({ directory: h.project, remote: { readOnly: true } })
  const controller = new AbortController()
  const response = await h.request("/event", { value: { clientId: h.clientId, sessionId: created.sessionId, afterSeq: 0 }, signal: controller.signal, token: h.observer })
  expect(response!.headers.get("content-type")).toBe("text/event-stream")
  const reader = response!.body!.getReader()
  let frames = ""
  while (!frames.includes('"lastSeq"')) {
    const part = await reader.read()
    if (part.done) throw new Error(`stream closed before subscription: ${frames}`)
    frames += new TextDecoder().decode(part.value)
  }
  expect(h.daemon.connections()).toBe(1)
  await h.command({ type: "user.submit", sessionId: created.sessionId, text: "HTTP streaming", attachments: [] })
  while (!frames.includes('"turn.completed"')) {
    const part = await reader.read()
    if (part.done) throw new Error(`stream closed before completion: ${frames}`)
    frames += new TextDecoder().decode(part.value)
  }
  expect(frames).toContain('"item.delta"')
  expect(frames).not.toContain(h.full)
  controller.abort()
  await reader.cancel()
  expect(h.daemon.connections()).toBe(0)
})

test("browser app has no remote assets/storage or unsafe content interpolation", async () => {
  const h = await boot()
  const page = await h.request("/")
  expect(page!.status).toBe(200)
  expect(page!.headers.get("content-security-policy")).toContain("connect-src 'self'")
  expect(await page!.text()).toContain("ctrl-enter send")
  expect(HTTP_WEB).not.toMatch(/localStorage|sessionStorage|innerHTML|https?:\/\//)
  expect(httpOpenApi().paths["/event"]).toBeDefined()
})

test("browser client login, new session, prompt and streaming execute against a local DOM/service fake", async () => {
  const h = await boot()
  type Element = { value: string; textContent: string; disabled: boolean; hidden: boolean; dataset: Record<string, string>; children: Element[]; scrollTop: number; scrollHeight: number; onclick?: () => Promise<void> | void; onsubmit?: (event: { preventDefault(): void }) => Promise<void>; replaceChildren(): void; append(item: Element): void; setAttribute(name: string, value: string): void; removeAttribute(name: string): void }
  const element = (): Element => ({ value: "", textContent: "", disabled: true, hidden: false, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0, replaceChildren() { this.children = [] }, append(item) { this.children.push(item) }, setAttribute() {}, removeAttribute() {} })
  const elements = new Map<string, Element>()
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id)! }
  const dom = { getElementById: el, createElement: element }
  const fetchLocal = (url: string, options: RequestInit) => h.daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${url}`, options))
  const script = HTTP_WEB.match(/<script>([\s\S]*)<\/script>/)![1]!
  new Function("document", "fetch", "crypto", script)(dom, fetchLocal, crypto)
  el("token").value = h.full
  await el("login").onsubmit!({ preventDefault() {} })
  expect(el("error").textContent).toBe("")
  expect(el("token").value).toBe("")
  expect(el("new").disabled).toBe(false)
  await el("new").onclick!()
  expect(el("sessions").children).toHaveLength(1)
  el("message").value = "browser prompt"
  await el("prompt").onsubmit!({ preventDefault() {} })
  const end = Date.now() + 1000
  while (!el("transcript").textContent.includes("browser prompt") || !el("transcript").textContent.includes("◆")) { if (Date.now() > end) throw new Error("browser fake streaming deadline"); await Bun.sleep(2) }
  expect(el("message").value).toBe("")
  expect(el("error").textContent).toBe("")
  el("rename").value = "Browser title"
  await el("tools").onsubmit!({ preventDefault() {} })
  expect(el("error").textContent).toBe("")
  expect(el("sessions").children[0]!.textContent).toBe("Browser title")
  await el("changes").onclick!()
  const shown = Date.now() + 1000
  while (el("diff").hidden !== false && el("error").textContent === "") { if (Date.now() > shown) break; await Bun.sleep(2) }
  expect(el("error").textContent).toBe("Session file snapshots are local only")
  expect(el("diff").textContent).toBe("")
  await el("disconnect").onclick!()
  expect(el("transcript").textContent).toBe("")
  expect(el("new").disabled).toBe(true)
  el("token").value = h.observer
  await el("login").onsubmit!({ preventDefault() {} })
  expect(el("new").disabled).toBe(true)
  expect(el("send").disabled).toBe(true)
  await el("disconnect").onclick!()
})

test("HTTP startup refuses absent token store before opening the daemon DB", async () => {
  const dir = tempDir()
  await expect(startDaemon({ dir, defaultDirectory: dir, http: { enabled: true }, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock }) })).rejects.toThrow("requires a remote token")
  expect(existsSync(path.join(dir, "mendd.lock"))).toBe(false)
})
