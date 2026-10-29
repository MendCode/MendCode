import { afterEach, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createClient } from "@mendcode/client"
import { Command, createIdFactory, isReadOnlyCommand, TuiRequestInput, type GlobalEvent, type TuiRequest } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { createTuiRequests } from "../src/tui-requests"
import { httpOpenApi } from "../src/http"
import { remoteTokens } from "../src/remote"
import { appHarness, cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); cleanTemps() })
const ids = createIdFactory()
const append = { path: "/tui/append-prompt", body: { text: "Review this change" } } as const
async function boot() {
  const dir = tempDir(), directory = realpathSync(tempDir())
  const tokens = remoteTokens(dir)
  const full = tokens.create({ name: "full" }).token
  const other = tokens.create({ name: "other" }).token
  const observer = tokens.create({ name: "observer", readOnly: true }).token
  const daemon = await startDaemon({ dir, defaultDirectory: directory, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true }, httpListen: false, extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const clientId = ids("client")
  const request = (route: string, options: { method?: string; value?: unknown; token?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${options.token ?? full}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }), ...(options.signal ? { signal: options.signal } : {}) }))
  const command = (value: Record<string, unknown>, options: Parameters<typeof request>[1] = {}) => request("/command", { ...options, value: { ...value, id: value.id ?? ids("command"), clientId } })
  return { dir, directory, daemon, tokens, full, other, observer, request, command }
}

test("B84 broker correlates FIFO responses, rejects wrong owners/stale IDs and bounds pending work", async () => {
  const broker = createTuiRequests(), owner = {}, stranger = {}, deliveries: TuiRequest[] = []
  cleanup.push(() => broker.stop())
  expect(broker.register("/project", owner, true, (request) => deliveries.push(request))).toMatchObject({ ok: true })
  expect(broker.register("/project", stranger, true, () => {})).toMatchObject({ ok: false, code: "busy" })
  const first = ids("command"), second = ids("command")
  const one = broker.send("/project", first, append), two = broker.send("/project", second, append)
  expect(deliveries.map((entry) => entry.requestID)).toEqual([first])
  expect(broker.respond("/project", stranger, first, true)).toMatchObject({ ok: false, code: "forbidden" })
  expect(broker.respond("/project", owner, second, true)).toMatchObject({ ok: false, code: "invalid_command" })
  broker.respond("/project", owner, first, true)
  expect(await one).toMatchObject({ ok: true, result: { processed: true } })
  expect(deliveries.map((entry) => entry.requestID)).toEqual([first, second])
  broker.respond("/project", owner, second, false)
  expect(await two).toMatchObject({ ok: true, result: { processed: false } })
  const pending = Array.from({ length: 32 }, () => broker.send("/project", ids("command"), append))
  expect(await broker.send("/project", ids("command"), append)).toMatchObject({ ok: false, code: "busy" })
  broker.forget(owner)
  expect((await Promise.all(pending)).every((reply) => !reply.ok)).toBe(true)
  expect(await broker.send("/project", ids("command"), append)).toMatchObject({ ok: false, code: "busy" })
})

test("B84 poll leases, request cancellation, deadlines, revocation and shutdown release owners", async () => {
  const broker = createTuiRequests({ deadlineMs: 15, leaseMs: 25 })
  cleanup.push(() => broker.stop())
  let active = true
  const poll = broker.next("/project", "owner", 10, undefined, () => active)
  const pending = broker.send("/project", ids("command"), append)
  expect(await poll).toMatchObject({ ok: true, result: { request: { request: append } } })
  expect(await pending).toMatchObject({ ok: false, code: "busy" })
  active = false
  broker.sweep()
  expect(await broker.send("/project", ids("command"), append)).toMatchObject({ ok: false, code: "busy" })
  const abort = new AbortController()
  const waiting = broker.next("/project", "replacement", 100, abort.signal)
  abort.abort()
  expect(await waiting).toMatchObject({ ok: true, result: { request: null } })
  expect(broker.register("/project", {}, true, () => {})).toMatchObject({ ok: true })
  const cancel = new AbortController()
  const sent = broker.send("/project", ids("command"), append, cancel.signal)
  cancel.abort()
  expect(await sent).toMatchObject({ ok: false, code: "busy" })
  broker.stop()
  expect(broker.register("/project", {}, true, () => {})).toMatchObject({ ok: false })
  const lease = createTuiRequests({ leaseMs: 10 })
  expect(await lease.next("/project", "owner", 1)).toMatchObject({ ok: true, result: { request: null } })
  await Bun.sleep(15)
  expect(lease.register("/project", {}, true, () => {})).toMatchObject({ ok: true })
  lease.stop()
})

test("B84 HTTP has all 13 donor contracts, validates payloads, and refuses observers or browser clients", async () => {
  const h = await boot()
  const api = httpOpenApi().paths as Record<string, any>
  expect(Object.keys(api).filter((route) => route.startsWith("/tui/"))).toHaveLength(13)
  expect(api["/tui/publish"].post.requestBody.content["application/json"].schema).toBeDefined()
  expect(api["/tui/control/next"].get.operationId).toBe("tui.control.next")
  for (const type of ["tui.control.register", "tui.control.send", "tui.control.next", "tui.control.response"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  expect(TuiRequestInput.safeParse({ path: "/tui/publish", body: { type: "settings.changed", properties: {} } }).success).toBe(false)
  for (const route of Object.keys(api).filter((route) => route.startsWith("/tui/"))) {
    expect((await h.request(route, { method: route.endsWith("next") ? "GET" : "POST", token: h.observer, ...(route.endsWith("next") ? {} : { value: {} }) }))!.status).toBe(403)
  }
  expect((await h.request("/tui/open-help", { method: "POST", headers: { Origin: "http://127.0.0.1:4096" } }))!.status).toBe(403)
  expect((await h.request("/tui/append-prompt", { value: { text: "hello", extra: true } }))!.status).toBe(400)
  expect((await h.request("/tui/show-toast", { value: { message: "hello", variant: "info", duration: -1 } }))!.status).toBe(400)
  expect((await h.request("/tui/control/response", { value: { response: true, type: "server.dispose" } }))!.status).toBe(400)
  expect((await h.request("/tui/select-session", { value: { sessionID: ids("session") } }))!.status).toBe(404)
  expect((await h.request("/tui/open-help", { method: "POST" }))!.status).toBe(409)
})

test("B84 all UI routes deliver validated path/body and finish only on their owner's response", async () => {
  const h = await boot()
  const created = await (await h.command({ type: "session.create", directory: h.directory }))!.json()
  const requests = [
    append, ...["/tui/open-help", "/tui/open-sessions", "/tui/open-themes", "/tui/open-models", "/tui/submit-prompt", "/tui/clear-prompt"].map((path) => ({ path, body: {} })),
    { path: "/tui/execute-command", body: { command: "messages_first" } },
    { path: "/tui/show-toast", body: { title: "Review", message: "Ready", variant: "info" } },
    { path: "/tui/publish", body: { type: "tui.command.execute", properties: { command: "prompt.clear" } } },
    { path: "/tui/select-session", body: { sessionID: created.sessionId } },
  ]
  for (const [index, action] of requests.entries()) {
    const next = h.request("/tui/control/next")
    await Bun.sleep(1)
    const send = h.request(action.path, { value: action.body })
    const response = await next
    expect(response!.status).toBe(200)
    const pending = await response!.json()
    expect(pending.path).toBe(action.path)
    expect(pending.body).toEqual(TuiRequestInput.parse(action).body)
    expect((await h.request("/tui/control/response", { value: { requestID: pending.requestID, response: true }, token: h.other }))!.status).toBe(403)
    expect((await h.request("/tui/control/response", { value: { requestID: ids("command"), response: true } }))!.status).toBe(400)
    const reply = index === 0 ? true : { requestID: pending.requestID, response: index !== 1 }
    expect(await (await h.request("/tui/control/response", { value: reply }))!.json()).toBe(true)
    expect(await (await send)!.json()).toBe(index !== 1)
  }
  const abort = new AbortController()
  const next = h.request("/tui/control/next", { signal: abort.signal })
  await Bun.sleep(1)
  h.tokens.revoke("full")
  h.daemon.httpAdapter!.sweep()
  abort.abort()
  await next
})

test("B84 native client ownership is targeted, disconnect releases it and command retries do not redeliver", async () => {
  const h = await boot()
  const ownerEvents: GlobalEvent[] = [], observerEvents: GlobalEvent[] = []
  const owner = createClient({ socketPath: path.join(h.dir, "mendd.sock"), name: "owner", reconnect: false, onGlobal: (event) => ownerEvents.push(event) })
  const observer = createClient({ socketPath: path.join(h.dir, "mendd.sock"), name: "observer", reconnect: false, onGlobal: (event) => observerEvents.push(event) })
  cleanup.push(() => owner.close(), () => observer.close())
  await owner.connect(); await observer.connect()
  expect(await owner.registerTuiControl(h.directory)).toMatchObject({ ok: true })
  expect(await observer.registerTuiControl(h.directory)).toMatchObject({ ok: false, error: { code: "busy" } })
  const id = ids("command")
  const sent = h.command({ type: "tui.control.send", directory: h.directory, request: append, id })
  for (let i = 0; i < 100 && !ownerEvents.some((event) => event.type === "tui.control.request"); i++) await Bun.sleep(1)
  const event = ownerEvents.find((entry) => entry.type === "tui.control.request")!
  expect(event).toMatchObject({ requestID: id, request: append })
  expect(observerEvents.some((entry) => entry.type === "tui.control.request")).toBe(false)
  expect(await observer.respondTuiControl(h.directory, id, true)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await owner.respondTuiControl(h.directory, id, true)).toMatchObject({ ok: true })
  expect(await (await sent)!.json()).toEqual({ processed: true })
  expect(await (await h.command({ type: "tui.control.send", directory: h.directory, request: append, id }))!.json()).toEqual({ processed: true })
  expect(ownerEvents.filter((entry) => entry.type === "tui.control.request")).toHaveLength(1)
  expect(Command.safeParse({ type: "tui.control.response", id: ids("command"), clientId: ids("client"), directory: h.directory, requestID: id, response: "yes" }).success).toBe(false)
  owner.close()
  await Bun.sleep(5)
  expect(await observer.registerTuiControl(h.directory)).toMatchObject({ ok: true })
  expect(await observer.registerTuiControl(h.directory, false)).toMatchObject({ ok: true })
})

test("B84 HTTP nested session selection stays within its selected workspace", async () => {
  const h = await boot(), otherDirectory = realpathSync(tempDir())
  const created = await (await h.command({ type: "session.create", directory: h.directory }))!.json()
  const registered = await (await h.request("/experimental/workspace", { value: { name: "other", directory: otherDirectory, adapter: "local" } }))!.json()
  const headers = { "X-Mendcode-Workspace": registered.workspace.id }
  expect((await h.request("/tui/select-session", { headers, value: { sessionID: created.sessionId } }))!.status).toBe(403)
  expect((await h.request("/tui/publish", { headers, value: { type: "tui.session.select", properties: { sessionID: created.sessionId } } }))!.status).toBe(403)
})

test("B84 HTTP requests reach the native app editor, page factories and normal submission path", async () => {
  const h = await boot()
  const created = await (await h.command({ type: "session.create", directory: h.directory }))!.json()
  let ui: ReturnType<typeof appHarness> | undefined
  const client = createClient({ socketPath: path.join(h.dir, "mendd.sock"), name: "terminal", reconnect: false, onGlobal: (event) => { void ui?.app.onGlobal(event) }, onEvent: (event) => ui?.app.onEvent(event) })
  cleanup.push(() => client.close())
  await client.connect()
  ui = appHarness({ directory: h.directory, sessionId: created.sessionId, tuiControl: true, reply: (command) => client.send(command) })
  await ui.app.start()
  expect(await (await h.request("/tui/append-prompt", { value: { text: "Review control ownership" } }))!.json()).toBe(true)
  expect(ui.app.editor.text).toBe("Review control ownership")
  expect(await (await h.request("/tui/open-help", { method: "POST" }))!.json()).toBe(true)
  expect(ui.app.page).toBe("help")
  expect(ui.app.editor.text).toBe("Review control ownership")
  await ui.type("\x1b")
  expect(await (await h.request("/tui/submit-prompt", { method: "POST" }))!.json()).toBe(true)
  expect(ui.sentOf("user.submit")).toMatchObject([{ text: "Review control ownership" }])
  ui.app.editor.clear()
  await ui.type("\x03")
})
