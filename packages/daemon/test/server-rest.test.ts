import { afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, ProcessMemory, type GlobalEvent, type McpStatusReport, type SessionEvent, type SessionId, type Settings } from "@mendcode/protocol"
import { startDaemon, type DaemonOptions } from "../src/daemon"
import { remoteTokens } from "../src/remote"
import { defaultPermissionFor, rolesFor, rolesPatch, shellFor } from "../src/profiles"
import { httpConfig, httpOpenApi } from "../src/http"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
const ids = createIdFactory()
const credential = `sk-proj-${"a1B2c3D4".repeat(5)}`
async function boot(options: { upgrade?: DaemonOptions["runtimeUpgrade"]; deltaMs?: number; memoryUsage?: DaemonOptions["memoryUsage"] } = {}) {
  const dir = tempDir(), project = realpathSync(tempDir())
  const tokens = remoteTokens(dir)
  const full = tokens.create({ name: "full" }).token
  const observer = tokens.create({ name: "observer", readOnly: true }).token
  const logs: Array<{ level: string; message: string }> = []
  const globals: GlobalEvent[] = [], events: SessionEvent[] = []
  const daemon = await startDaemon({
    dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true }, httpListen: false,
    extensionsEnabled: false, cancelGraceMs: 100,
    runtimeInfo: { version: "0.0.1-dev", channel: "dev" },
    ...(options.upgrade ? { runtimeUpgrade: options.upgrade } : {}),
    ...(options.memoryUsage ? { memoryUsage: options.memoryUsage } : {}),
    models: { selectable: true, defaults: { model: "alpha" }, list: () => ["alpha", "beta"].map((id) => ({ id, name: id, provider: "openai", efforts: ["low", "high"], variants: { high: { effort: "high" } } })) },
    log: (level, message) => { logs.push({ level, message }) },
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: options.deltaMs ?? 1 }),
  })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B82", onGlobal: (event) => globals.push(event), onEvent: (event) => events.push(event), timeoutMs: 1000 })
  cleanup.push(() => client.close())
  await client.connect()
  const clientId = ids("client")
  const request = async (route: string, options: { method?: string; value?: unknown; token?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${options.token ?? full}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }), ...(options.signal ? { signal: options.signal } : {}) }))
    if (!response) throw new Error("unexpected WebSocket response")
    return response
  }
  const command = (value: Record<string, unknown>, options: Parameters<typeof request>[1] = {}) => request("/command", { ...options, value: { id: ids("command"), clientId, ...value } })
  const register = async () => {
    const directory = realpathSync(tempDir())
    const response = await request("/experimental/workspace", { value: { directory, name: `project-${ids("command")}` } })
    expect(response.status).toBe(200)
    return { directory, headers: { "X-Opencode-Directory": directory } }
  }
  const create = async (headers?: Record<string, string>) => {
    const directory = headers?.["X-Opencode-Directory"] ?? project
    const response = await command({ type: "session.create", directory }, headers ? { headers } : {})
    expect(response.status).toBe(200)
    return (await response.json()).sessionId as SessionId
  }
  return { daemon, client, dir, project, tokens, full, observer, logs, globals, events, request, command, register, create }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1500
  while (!check()) { if (Date.now() >= deadline) throw new Error("B82 local event deadline"); await Bun.sleep(2) }
}
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
  let text = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => { while (!text.includes(needle)) { const part = await reader.read(); if (part.done) throw new Error(`SSE ended before ${needle}`); text += new TextDecoder().decode(part.value) } })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`SSE deadline: ${needle}`)), 1500) }),
    ])
    return text
  } finally { clearTimeout(timer) }
}

test("B82 health/memory are authenticated, observational and have exact v1 guardrail units", async () => {
  const warnBytes = 2 * 1024 ** 3, criticalBytes = 4 * 1024 ** 3
  const sample = { rss: warnBytes - 1, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }
  const h = await boot({ memoryUsage: () => sample })
  expect(httpConfig(h.dir).enabled).toBe(false)
  const gc = spyOn(Bun, "gc").mockImplementation(() => { throw new Error("memory sample must not GC") })
  try {
    expect(await (await h.request("/global/health", { token: h.observer })).json()).toMatchObject({ healthy: true, version: "0.0.1-dev", channel: "dev" })
    for (const [rss, status] of [[warnBytes - 1, "ok"], [warnBytes, "warning"], [criticalBytes - 1, "warning"], [criticalBytes, "critical"]] as const) {
      sample.rss = rss
      const response = await h.request("/global/diagnostics/memory", { token: h.observer })
      expect(response.status).toBe(200)
      const memory = ProcessMemory.parse(await response.json())
      expect(memory.pid).toBe(process.pid)
      expect(memory).toMatchObject(sample)
      expect(memory.memoryGuardrail).toEqual({ status, warnBytes, criticalBytes })
      expect(await h.client.serverMemory()).toMatchObject({ ok: true, memory: { ...sample, role: "server", memoryGuardrail: { status, warnBytes, criticalBytes } } })
    }
    expect(existsSync(path.join(h.dir, "diagnostics"))).toBe(false)
    expect(gc).not.toHaveBeenCalled()
  } finally { gc.mockRestore() }
  const unauthorized = await h.request("/global/config", { token: "invalid" })
  expect(unauthorized.status).toBe(401)
})

test("B82 global config deep merges, translates model aliases and notifies native clients once", async () => {
  const h = await boot()
  expect((await h.request("/global/config", { method: "PATCH", value: { model: "openai/alpha", small_model: "openai/beta", default_agent: "plan", tools: { read: true } } })).status).toBe(200)
  const update = await h.request("/global/config", { method: "PATCH", value: { subagent_model: "openai/alpha", subagent_variant: "high", tools: { write: false }, plan_exit_agent: "build" } })
  expect(await update.json()).toMatchObject({ model: "openai/alpha", small_model: "openai/beta", subagent_model: "openai/alpha", subagent_variant: "high", tools: { read: true, write: false }, planExitAgent: "build" })
  await until(() => h.globals.filter((event) => event.type === "settings.changed").length === 2)
  expect(await h.client.serverConfig()).toMatchObject({ ok: true, config: { models: { main: { model: "alpha" }, small: { model: "beta" } } } })
  expect((await h.request("/global/config", { method: "PATCH", value: { tools: { write: false } } })).status).toBe(200)
  await Bun.sleep(10)
  expect(h.globals.filter((event) => event.type === "settings.changed")).toHaveLength(2)
  const stored = JSON.stringify(h.daemon.store.settings.get())
  expect((await h.request("/global/config", { method: "PATCH", value: { model: "openai/missing", tools: { read: false } } })).status).toBe(400)
  expect(JSON.stringify(h.daemon.store.settings.get())).toBe(stored)
  expect((await h.request("/global/config", { method: "PATCH", value: { model: "openai/alpha", models: { main: { model: "beta" } } } })).status).toBe(400)
})

test("B82 project config isolates real defaults and inherits later global role changes", async () => {
  const h = await boot(), other = await h.register()
  expect((await h.client.updateServerConfig({ model: "openai/alpha", small_model: "openai/alpha", defaultPermission: "ask" })).ok).toBe(true)
  const response = await h.request("/config", { method: "PATCH", value: { model: "openai/beta", default_agent: "plan", memoryUse: false } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ model: "openai/beta", default_agent: "plan", memoryUse: false })
  expect((await h.client.updateServerConfig({ small_model: "openai/beta" })).ok).toBe(true)
  expect(await (await h.request("/config")).json()).toMatchObject({ model: "openai/beta", small_model: "openai/beta" })
  expect(await (await h.request("/config", { headers: other.headers })).json()).toMatchObject({ model: "openai/alpha", small_model: "openai/beta" })
  expect(await (await h.request("/global/config")).json()).not.toHaveProperty("memoryUse")
  const first = await h.create(), second = await h.create(other.headers)
  expect(h.daemon.store.permissionModeOf(first)).toBe("plan")
  expect(h.daemon.store.permissionModeOf(second)).toBe("ask")
  expect(await h.client.serverConfig(h.project)).toMatchObject({ ok: true, config: { model: "openai/beta", memoryUse: false } })
  expect((await h.request("/config?directory=/unregistered", { method: "PATCH", value: { defaultPermission: "full" } })).status).toBe(403)
})

test("B82 unsupported donor config returns 501, malformed fields 400, and read-only controls 403", async () => {
  const h = await boot()
  const stored = h.daemon.store.settings.get()
  expect((await h.request("/global/config", { method: "PATCH", value: { provider: { openai: { apiKey: credential } } } })).status).toBe(501)
  expect((await h.request("/config", { method: "PATCH", value: { theme: "matrix" } })).status).toBe(501)
  expect((await h.request("/global/config", { method: "PATCH", value: { defaultPermission: "dangerous" } })).status).toBe(400)
  expect(h.daemon.store.settings.get()).toEqual(stored)
  for (const [route, method, value] of [
    ["/config", "GET", undefined], ["/config", "PATCH", { model: "openai/alpha" }],
    ["/global/config", "GET", undefined], ["/global/config", "PATCH", { theme: "matrix" }],
    ["/log", "POST", { service: "test", level: "info", message: "entry" }],
    ["/global/dispose", "POST", {}], ["/instance/dispose", "POST", {}], ["/global/upgrade", "POST", {}], ["/global/event", "GET", undefined],
  ] as const) expect((await h.request(route, { method, ...(value === undefined ? {} : { value }), token: h.observer })).status).toBe(403)
  expect((await h.command({ type: "server.config.get" }, { token: h.observer })).status).toBe(403)
  expect((await h.command({ type: "server.dispose" }, { token: h.observer })).status).toBe(403)
  expect(h.logs).toEqual([])
  expect(h.daemon.serverEventSubscriptions()).toBe(0)
})

test("B82 canonical project overrides preserve existing profiles configured through a symlink", () => {
  const directory = realpathSync(tempDir()), link = path.join(tempDir(), "project")
  symlinkSync(directory, link)
  const settings: Settings = { models: { main: { model: "global" } }, defaultPermission: "ask", profiles: [{ name: "work", directories: [link], models: { main: { model: "profile" } }, defaultPermission: "edits" }] }
  expect(rolesFor(settings, link)).toEqual({ main: { model: "profile" } })
  expect(defaultPermissionFor(settings, link)).toBe("edits")
  expect(rolesPatch(settings, link, { main: { model: "changed" } })).toMatchObject({ profiles: [{ name: "work", models: { main: { model: "changed" } } }] })
  settings.projectConfig = { [directory]: { models: { small: { model: "project" } }, defaultPermission: "full" } }
  expect(rolesFor(settings, link)).toEqual({ main: { model: "profile" }, small: { model: "project" } })
  expect(defaultPermissionFor(settings, link)).toBe("full")
  expect(rolesPatch(settings, link, { main: { model: "changed" } })).toMatchObject({ projectConfig: { [directory]: { models: { main: { model: "changed" } } } } })
})

test("B82 app.log respects all severity levels and redacts secrets and terminal control characters", async () => {
  const h = await boot()
  expect((await h.request("/log", { value: { service: "sdk", level: "debug", message: "hidden" } })).status).toBe(200)
  expect(h.logs).toEqual([])
  expect((await h.client.updateServerConfig({ logLevel: "DEBUG" })).ok).toBe(true)
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const response = await h.request("/log", { value: { service: "sdk\u001b", level, message: `API_KEY=${credential}\nentry`, extra: { key: credential, count: 2 } } })
    expect(await response.json()).toBe(true)
  }
  expect(h.logs.map((entry) => entry.level)).toEqual(["debug", "info", "warn", "error"])
  expect(JSON.stringify(h.logs)).not.toContain(credential)
  expect(h.logs.some((entry) => /[\x00-\x1f\x7f]/.test(entry.message))).toBe(false)
  expect((await h.client.appLog({ service: "client", level: "info", message: "native" })).ok).toBe(true)
  expect(h.logs.at(-1)?.message).toContain("[client] native")
})

test("HTTP logging redacts opaque and short credentials in text and nested extras", async () => {
  const h = await boot()
  const secrets = ["s3cr3t", "opaquePrivateValue", "short", "4321", "opaqueCookie"]
  const response = await h.request("/log", { value: {
    service: "sdk", level: "info", message: `password=${secrets[0]} Authorization: Bearer ${secrets[2]}`,
    extra: { clientSecret: secrets[1], nested: [{ api_key: secrets[3], cookie: secrets[4], count: 2 }] },
  } })
  expect(response.status).toBe(200)
  expect(h.logs).toHaveLength(1)
  const logged = JSON.stringify(h.logs)
  for (const secret of secrets) expect(logged).not.toContain(secret)
  expect(logged).toContain("count")
  expect(logged).toContain("[redacted:secret]")
})

test("B82 global SSE wraps live v2 events, filters projects, and releases cancelled/revoked subscriptions", async () => {
  const h = await boot(), other = await h.register()
  const controller = new AbortController()
  const response = await h.request("/global/event", { signal: controller.signal })
  const reader = response.body!.getReader()
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(await readUntil(reader, "server.connected")).toContain("event: message")
  expect(h.daemon.serverEventSubscriptions()).toBe(1)
  await h.client.updateServerConfig({ theme: "matrix" })
  expect(await readUntil(reader, "settings.changed")).toContain('"directory":"global"')
  const selected = await h.request(`/global/event?directory=${encodeURIComponent(h.project)}`)
  const selectedReader = selected.body!.getReader()
  await readUntil(selectedReader, "server.connected")
  const elsewhere = await h.create(other.headers)
  await h.command({ type: "user.submit", sessionId: elsewhere, text: "elsewhere", attachments: [] }, { headers: other.headers })
  const local = await h.create()
  await h.command({ type: "user.submit", sessionId: local, text: `API_KEY=${credential}`, attachments: [] })
  const frames = await readUntil(selectedReader, '"item.completed"')
  expect(frames).toContain(h.project)
  expect(frames).not.toContain(elsewhere)
  expect(frames).not.toContain(credential)
  controller.abort()
  await reader.cancel()
  expect(h.daemon.serverEventSubscriptions()).toBe(1)
  h.tokens.revoke("full")
  h.daemon.httpAdapter!.sweep()
  expect(h.daemon.serverEventSubscriptions()).toBe(0)
  while (!(await selectedReader.read()).done) {}
  await selectedReader.cancel()
})

test("B82 global SSE closes a slow reader and enforces the shared 128-stream limit", async () => {
  const h = await boot()
  const slow = await h.request("/global/event")
  const permissionAllow = Array.from({ length: 100 }, (_, n) => `${n} ${"x".repeat(190)}`)
  for (let n = 0; n < 35 && h.daemon.serverEventSubscriptions(); n++) expect((await h.client.updateServerConfig({ permissionAllow, theme: n % 2 ? "matrix" : "mint" })).ok).toBe(true)
  expect(h.daemon.serverEventSubscriptions()).toBe(0)
  await slow.body!.cancel()
  const streams: Response[] = []
  for (let n = 0; n < 128; n++) streams.push(await h.request("/global/event"))
  expect((await h.request("/global/event")).status).toBe(503)
  expect(h.daemon.serverEventSubscriptions()).toBe(128)
  await Promise.all(streams.map((response) => response.body!.cancel()))
  expect(h.daemon.serverEventSubscriptions()).toBe(0)
}, 10_000)

test("B82 instance/global disposal interrupts turns, preserves durable sessions and keeps the server available", async () => {
  const h = await boot({ deltaMs: 1000 }), other = await h.register()
  const first = await h.create(), second = await h.create(other.headers)
  await h.client.subscribe(first, 0)
  await h.client.subscribe(second, 0)
  await h.command({ type: "user.submit", sessionId: first, text: "first active", attachments: [] })
  await h.command({ type: "user.submit", sessionId: first, text: "queued", attachments: [] })
  await h.command({ type: "user.submit", sessionId: second, text: "second active", attachments: [] }, { headers: other.headers })
  await until(() => h.events.filter((event) => event.type === "turn.started").length === 2)
  const disposed = await h.request("/instance/dispose", { value: {} })
  expect(await disposed.json()).toBe(true)
  await until(() => h.events.some((event) => event.sessionId === first && event.type === "turn.interrupted"))
  expect(h.events.some((event) => event.sessionId === second && event.type === "turn.interrupted")).toBe(false)
  expect(h.daemon.store.hasSession(first)).toBe(true)
  expect(h.daemon.store.queueOf(first)).toHaveLength(1)
  expect((await h.client.disposeInstances()).ok).toBe(true)
  await until(() => h.events.some((event) => event.sessionId === second && event.type === "turn.interrupted"))
  expect(h.daemon.store.hasSession(second)).toBe(true)
  expect((await h.client.serverHealth()).ok).toBe(true)
  expect((await h.request("/session")).status).toBe(200)
  expect((await h.request("/global/dispose", { value: { force: true } })).status).toBe(400)
  await until(() => h.globals.some((event) => event.type === "server.lifecycle" && !event.directory))
})

test("B82 runtime upgrade is off by default, validates targets and uses an explicit local port once per command", async () => {
  const h = await boot()
  const disabled = await h.request("/global/upgrade", { value: {} })
  expect(disabled.status).toBe(400)
  expect(await disabled.json()).toMatchObject({ success: false, error: expect.stringContaining("disabled") })
  expect((await h.request("/global/upgrade", { value: { target: "../../binary" } })).status).toBe(400)
  let calls = 0
  const enabled = await boot({ upgrade: async (input, signal) => { calls++; expect(signal.aborted).toBe(false); return { success: true, version: input.target ?? "2.1.0" } } })
  const command = { type: "server.upgrade", id: ids("command"), input: { target: "2.1.0" } }
  for (let n = 0; n < 2; n++) expect(await (await enabled.command(command)).json()).toEqual({ upgrade: { success: true, version: "2.1.0" } })
  expect(calls).toBe(1)
  await until(() => enabled.globals.some((event) => event.type === "server.lifecycle" && event.version === "2.1.0"))
  expect((await enabled.client.upgradeRuntime({ target: "2.2.0" })).ok).toBe(true)
})

test("B82 disposal refuses scheduled orchestrators until paused without rewriting their state", async () => {
  const h = await boot()
  const created = await h.client.send({ type: "loop.create", directory: h.project, name: "scheduled", objective: "inspect", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" } })
  expect(created.ok).toBe(true)
  const loop = created.ok ? created.result!.loop as { loopId: import("@mendcode/protocol").LoopId } : undefined
  expect((await h.request("/global/dispose", { value: {} })).status).toBe(409)
  expect((await h.client.send({ type: "loop.control", loopId: loop!.loopId, action: "pause" })).ok).toBe(true)
  expect(await (await h.request("/global/dispose", { value: {} })).json()).toBe(true)
  expect(h.daemon.store.loops.all()[0]?.state).toBe("paused")
})

test("B82 the opt-in upgrade port serializes different installation requests", async () => {
  let finish!: () => void
  let calls = 0
  const h = await boot({ upgrade: async () => { calls++; await new Promise<void>((resolve) => { finish = resolve }); return { success: true, version: "2.1.0" } } })
  const first = h.request("/global/upgrade", { value: {} })
  await until(() => calls === 1)
  const second = await h.request("/global/upgrade", { value: {} })
  expect(await second.json()).toEqual({ success: false, error: "Upgrade already running" })
  finish()
  expect(await (await first).json()).toEqual({ success: true, version: "2.1.0" })
  expect(calls).toBe(1)
})

test("B82 upgrade failures keep the v1 result shape without leaking port error text", async () => {
  const h = await boot({ upgrade: async () => { throw new Error(credential) } })
  const response = await h.request("/global/upgrade", { value: { target: "2.1.0" } })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ success: false, error: "Update failed" })
  expect(h.globals.some((event) => event.type === "server.lifecycle")).toBe(false)
})

test("R9 mcp config round-trips through mcp.json, masks secrets and restores them when sent back unchanged", async () => {
  const h = await boot()
  const approve = async (scope: "user" | "project", names: string[]) => {
    const status = await h.client.send({ type: "mcp.status", directory: h.project })
    expect(status.ok).toBe(true)
    for (const server of names) {
      const pending = status.ok ? (status.result as McpStatusReport).servers.find((entry) => entry.name === server)?.pending : undefined
      expect(pending?.scope).toBe(scope)
      expect(await h.client.send({ type: "mcp.decide", directory: h.project, scope, server, revision: pending!.revision, approve: true })).toMatchObject({ ok: true })
    }
  }
  const patch = { mcp: {
    docs: { type: "remote", url: "https://mcp.example.invalid/mcp?token=abc123", headers: { Authorization: `Bearer ${credential}`, Accept: "text/plain" }, timeout: 5000 },
    tools: { type: "local", command: ["node", "server.js", "--flag"], environment: { API_KEY: credential, MODE: "test" }, enabled: false },
  } }
  const first = await h.request("/global/config", { method: "PATCH", value: patch })
  expect(first.status).toBe(200)
  const pendingConfig = await first.json()
  expect(pendingConfig.mcp).toBeUndefined()
  expect(JSON.stringify(pendingConfig)).not.toContain(credential)
  await approve("user", ["docs", "tools"])
  const config = await (await h.request("/global/config")).json()
  expect(JSON.stringify(config)).not.toContain(credential)
  expect(config.mcp.docs).toMatchObject({ type: "remote", headers: { Authorization: "[redacted:secret]", Accept: "text/plain" }, timeout: 5000 })
  expect(config.mcp.tools).toMatchObject({ type: "local", command: ["node", "server.js", "--flag"], environment: { API_KEY: "[redacted:secret]", MODE: "test" }, enabled: false })
  const file = path.join(h.dir, "mcp.json")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const stored = JSON.parse(readFileSync(file, "utf8")).servers
  expect(stored.docs.headers.Authorization).toBe(`Bearer ${credential}`)
  expect(stored.tools).toMatchObject({ command: "node", args: ["server.js", "--flag"], env: { API_KEY: credential }, enabled: false })
  const again = await h.request("/global/config", { method: "PATCH", value: { mcp: { docs: { ...config.mcp.docs, timeout: 7000 }, tools: { enabled: true } } } })
  expect(again.status).toBe(200)
  expect((await again.json()).mcp).toBeUndefined()
  await approve("user", ["docs", "tools"])
  const restored = JSON.parse(readFileSync(file, "utf8")).servers
  expect(restored.docs).toMatchObject({ url: "https://mcp.example.invalid/mcp?token=abc123", headers: { Authorization: `Bearer ${credential}` }, timeoutMs: 7000 })
  expect(restored.tools).toMatchObject({ enabled: true, env: { API_KEY: credential } })
  const before = readFileSync(file, "utf8")
  expect((await h.request("/global/config", { method: "PATCH", value: { mcp: { ghost: { enabled: false } } } })).status).toBe(400)
  expect((await h.request("/global/config", { method: "PATCH", value: { mcp: { fresh: { type: "local", command: ["x"], environment: { API_KEY: "[redacted:secret]" } } } } })).status).toBe(400)
  expect((await h.request("/global/config", { method: "PATCH", value: { mcp: { bad: { type: "local", command: [] } } } })).status).toBe(400)
  expect(readFileSync(file, "utf8")).toBe(before)
  expect((await h.request("/global/config", { method: "PATCH", value: patch, token: h.observer })).status).toBe(403)
  const project = await h.request("/config", { method: "PATCH", value: { mcp: { local: { type: "local", command: ["bun", "run", "mcp"] } } } })
  expect(project.status).toBe(200)
  expect((await project.json()).mcp).toBeUndefined()
  await approve("project", ["local"])
  expect(Object.keys((await (await h.request("/config")).json()).mcp)).toEqual(["local"])
  expect(JSON.parse(readFileSync(path.join(h.project, ".mendcode/mcp.json"), "utf8")).servers.local.command).toBe("bun")
  expect(Object.keys((await (await h.request("/global/config")).json()).mcp)).toEqual(["docs", "tools"])
})

test("R9 plugin config installs through the offline installer, preserves options and removes by omission", async () => {
  const h = await boot()
  const file = path.join(h.dir, "demo plugin.ts")
  writeFileSync(file, "export default async () => ({})")
  const spec = pathToFileURL(file).href
  const response = await h.request("/global/config", { method: "PATCH", value: { plugin: [[spec, { region: "eu", apiKey: credential }]] } })
  expect(response.status).toBe(200)
  expect((await response.json()).plugin).toEqual([[spec, { region: "eu", apiKey: "[redacted:secret]" }]])
  const saved = JSON.parse(readFileSync(path.join(h.dir, "mendcode.json"), "utf8"))
  expect(saved).toMatchObject({ pluginCompatibility: true, plugin: [[spec, { region: "eu", apiKey: credential }]] })
  const masked = (await (await h.request("/global/config")).json()).plugin
  expect((await h.request("/global/config", { method: "PATCH", value: { plugin: masked } })).status).toBe(200)
  expect(JSON.parse(readFileSync(path.join(h.dir, "mendcode.json"), "utf8")).plugin[0][1].apiKey).toBe(credential)
  const before = readFileSync(path.join(h.dir, "mendcode.json"), "utf8")
  expect((await h.request("/global/config", { method: "PATCH", value: { plugin: [spec, "./missing.ts"] } })).status).toBe(400)
  expect((await h.request("/global/config", { method: "PATCH", value: { plugin: [["other", { apiKey: "[redacted:secret]" }]] } })).status).toBe(400)
  expect(readFileSync(path.join(h.dir, "mendcode.json"), "utf8")).toBe(before)
  expect((await h.request("/global/config", { method: "PATCH", value: { plugin: [] } })).status).toBe(200)
  expect(JSON.parse(readFileSync(path.join(h.dir, "mendcode.json"), "utf8")).plugin).toEqual([])
  expect(await (await h.request("/global/config")).json()).not.toHaveProperty("plugin")
})

test("R9 server config is stored for the next start, loopback-only, and refused for projects", async () => {
  const h = await boot()
  expect((await h.request("/global/config", { method: "PATCH", value: { server: { hostname: "0.0.0.0" } } })).status).toBe(400)
  expect((await h.request("/global/config", { method: "PATCH", value: { server: { cors: ["https://app.example.com/path"] } } })).status).toBe(400)
  expect(existsSync(path.join(h.dir, "remote.json"))).toBe(false)
  expect((await h.request("/global/config", { method: "PATCH", value: { server: { port: 4999, mdns: true } } })).status).toBe(400)
  expect(existsSync(path.join(h.dir, "remote.json"))).toBe(false)
  const response = await h.request("/global/config", { method: "PATCH", value: { server: { port: 4999, cors: ["https://app.example.com"], mdns: false, mdnsDomain: "box.local" } } })
  expect(response.status).toBe(200)
  expect((await response.json()).server).toEqual({ port: 4999, cors: ["https://app.example.com"], mdns: false, mdnsDomain: "box.local" })
  const stored = JSON.parse(readFileSync(path.join(h.dir, "remote.json"), "utf8"))
  expect(stored.server).toMatchObject({ port: 4999, mdns: false })
  expect(stored.server).not.toHaveProperty("enabled")
  expect(statSync(path.join(h.dir, "remote.json")).mode & 0o777).toBe(0o600)
  expect(httpConfig(h.dir)).toMatchObject({ enabled: false, port: 4999, hostname: "127.0.0.1" })
  expect((await h.request("/config", { method: "PATCH", value: { server: { port: 1 } } })).status).toBe(501)
})

test("R9 project config carries shell, instructions and skills in the project's own files and never leaks into global", async () => {
  const h = await boot()
  const other = await h.register()
  expect((await h.request("/global/config", { method: "PATCH", value: { shell: "/bin/zsh", instructions: ["~/global.md"] } })).status).toBe(200)
  writeFileSync(path.join(h.project, "AGENTS.md"), "rules")
  mkdirSync(path.join(h.project, "docs"))
  const response = await h.request("/config", { method: "PATCH", value: { shell: "/bin/sh", instructions: ["AGENTS.md", "docs/*.md"], skills: { paths: ["skills"], urls: ["https://example.com/skills"] } } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ shell: "/bin/sh", instructions: ["AGENTS.md", "docs/*.md"], skills: { paths: ["skills"], urls: ["https://example.com/skills"] } })
  expect(shellFor(h.daemon.store.settings.get(), h.project)).toBe("/bin/sh")
  expect(shellFor(h.daemon.store.settings.get(), other.directory)).toBe("/bin/zsh")
  expect(JSON.parse(readFileSync(path.join(h.project, ".mendcode/project.json"), "utf8"))).toMatchObject({ instructions: ["AGENTS.md", "docs/*.md"], skills: { paths: ["skills"] } })
  const global = await (await h.request("/global/config")).json()
  expect(global).toMatchObject({ shell: "/bin/zsh", instructions: ["~/global.md"] })
  expect(await (await h.request("/config", { headers: other.headers })).json()).not.toHaveProperty("instructions")
  const projectFile = readFileSync(path.join(h.project, ".mendcode/project.json"), "utf8")
  for (const instructions of [["../outside.md"], ["~/secret.md"], ["/etc/passwd"], ["https://example.com/rules.md"]]) expect((await h.request("/config", { method: "PATCH", value: { instructions } })).status).toBe(400)
  expect(readFileSync(path.join(h.project, ".mendcode/project.json"), "utf8")).toBe(projectFile)
  expect((await h.request("/config", { method: "PATCH", value: { theme: "matrix" } })).status).toBe(501)
})

test("B82 OpenAPI publishes every audited operation with request/response schemas", () => {
  const paths = httpOpenApi().paths as Record<string, Record<string, any>>
  const operations = Object.values(paths).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId))
  for (const id of ["config.get", "config.update", "app.log", "global.health", "global.diagnostics.memory", "global.event", "global.config.get", "global.config.update", "global.dispose", "global.upgrade", "instance.dispose"]) expect(operations).toContain(id)
  expect(paths["/global/event"]!.get.responses["200"].content["text/event-stream"]).toBeDefined()
  expect(paths["/global/config"]!.patch.requestBody.content["application/json"].schema.additionalProperties).toBe(false)
})
