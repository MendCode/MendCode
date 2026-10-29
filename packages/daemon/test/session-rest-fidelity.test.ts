import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { RestAgentViewDto, RestMessageDto, RestSessionDto, createIdFactory, type ClientId, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { remoteTokens } from "../src/remote"
import { httpOpenApi } from "../src/http"

const ids = createIdFactory()
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-r6-"))), project = path.join(dir, "project")
  mkdirSync(path.join(project, ".git"), { recursive: true })
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const token = remoteTokens(dir).create({ name: "full" }).token
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), extensionsEnabled: false, http: { enabled: true }, httpListen: false,
    models: { selectable: true, list: () => [{ id: "echo", name: "Echo", efforts: [], provider: "faux" }], defaults: { model: "echo" } },
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
  })
  cleanup.push(() => daemon.stop())
  const request = async (route: string, options: { method?: string; value?: unknown; headers?: Record<string, string> | undefined } = {}) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }) }))
    if (!response) throw new Error("unexpected upgrade")
    return response
  }
  const create = async (title: string, headers?: Record<string, string>) => {
    const response = await request("/session", { value: { title }, headers })
    expect(response.status).toBe(200)
    return await response.json() as { id: SessionId; path?: string }
  }
  const workspace = async (name: string, directory: string) => {
    mkdirSync(directory, { recursive: true })
    const registered = await (await request("/command", { value: { id: ids("command"), clientId: ids("client"), type: "workspace.create", name, directory, adapter: "local" } })).json()
    return { "X-Mendcode-Workspace": registered.workspace.id as string }
  }
  const titles = async (route: string, headers?: Record<string, string>) => {
    const body = await (await request(route, { headers })).json()
    return ((Array.isArray(body) ? body : body.items) as Array<{ title: string }>).map((row) => row.title).sort()
  }
  return { daemon, request, create, workspace, titles, dir, project }
}

test("R6 session lists keep to the project with scope=project and to a project-relative subtree with path", async () => {
  const h = await boot()
  const outside = path.join(h.dir, "elsewhere")
  const a = await h.workspace("A", path.join(h.project, "packages", "a")), deep = await h.workspace("Deep", path.join(h.project, "packages", "a", "deep"))
  const b = await h.workspace("B", path.join(h.project, "packages", "b")), other = await h.workspace("Other", outside)
  const root = await h.create("root")
  const first = await h.create("pkg-a", a)
  await h.create("pkg-a-deep", deep)
  await h.create("pkg-b", b)
  await h.create("outside", other)
  expect(root.path).toBeUndefined()
  expect(first.path).toBe("packages/a")
  expect(await h.titles("/session")).toEqual(["root"])
  expect(await h.titles("/session?scope=project")).toEqual(["pkg-a", "pkg-a-deep", "pkg-b", "root"])
  expect(await h.titles("/session?path=packages/a")).toEqual(["pkg-a", "pkg-a-deep"])
  expect(await h.titles("/session?path=./packages/a/")).toEqual(["pkg-a", "pkg-a-deep"])
  expect(await h.titles("/session?path=packages")).toEqual(["pkg-a", "pkg-a-deep", "pkg-b"])
  expect(await h.titles("/session?path=packages/ab")).toEqual([])
  expect(await h.titles("/session?path=")).toEqual(["pkg-a", "pkg-a-deep", "pkg-b", "root"])
  expect(await h.titles("/session?scope=project", other)).toEqual(["outside"])
  expect(await h.titles("/session?scope=project&roots=true&search=pkg-a")).toEqual(["pkg-a", "pkg-a-deep"])
  expect(await h.titles("/experimental/session?path=packages/b")).toEqual(["pkg-b"])
  expect(await h.titles("/api/session?path=packages/a")).toEqual(["pkg-a", "pkg-a-deep"])
  expect((await (await h.request("/session/agent-view?path=packages/b")).json()).map((row: { session: { title: string } }) => row.session.title)).toEqual(["pkg-b"])
  for (const bad of ["/session?path=../elsewhere", "/session?path=/etc", "/session?scope=global", "/api/session?cursor=abc&path=packages", "/session/status?scope=project", "/experimental/usage-insights?start=0&path=x"]) expect((await h.request(bad)).status).toBe(400)
  const page = await h.request("/session?scope=project&limit=2")
  const cursor = page.headers.get("x-next-cursor")!
  expect((await page.json()).length).toBe(2)
  expect(page.headers.get("link")).not.toContain("scope=")
  const rest = await (await h.request(`/session?limit=2&cursor=${encodeURIComponent(cursor)}`)).json()
  expect(rest).toHaveLength(2)
  expect(rest.map((row: { title: string }) => row.title)).not.toContain("outside")
  const spec = httpOpenApi() as { paths: Record<string, any> }
  for (const route of ["/session", "/session/agent-view", "/experimental/session", "/api/session"]) expect(spec.paths[route].get.parameters.map((entry: { name: string }) => entry.name)).toEqual(expect.arrayContaining(["scope", "path"]))
})

test("R6 agent view rows carry background state, writer lease, process and metadata overrides", async () => {
  const h = await boot(), plain = await h.create("plain"), tracked = await h.create("tracked"), store = h.daemon.store
  const writer = ids("client") as ClientId
  store.sessionBackground.register(tracked.id, { state: "queued", summary: "indexing the repo", pinned: true, process: { pid: 4242, startedAt: 5 } })
  expect(store.sessionBackground.acquire(tracked.id, writer, 60_000).acquired).toBe(true)
  store.agentCommands.patchMetadata(tracked.id, { title: "Review lane", tags: ["ops", "ops", "db"], priority: "high", pinned: true })
  const rows = await (await h.request("/session/agent-view")).json() as Array<Record<string, any>>
  for (const row of rows) RestAgentViewDto.parse(row)
  const first = rows.find((row) => row.sessionID === tracked.id)!, second = rows.find((row) => row.sessionID === plain.id)!
  expect(first).toMatchObject({ state: "queued", summary: "indexing the repo", pinned: true, process: { pid: 4242, started: 5 }, writer: { clientID: writer }, status: { type: "idle" }, metadata: { sessionID: tracked.id, title: "Review lane", tags: ["ops", "db"], priority: "high", pinned: true, archived: false }, session: { id: tracked.id, title: "tracked" } })
  expect(first.writer.expires).toBeGreaterThan(first.writer.acquired)
  expect(first.time.updated).toBeGreaterThanOrEqual(first.time.created)
  expect(second).toMatchObject({ state: "completed", pinned: false, status: { type: "idle" } })
  expect(second.writer).toBeUndefined()
  expect(second.metadata).toBeUndefined()
  expect(second.summary).toBe(h.project)
  store.sessionBackground.register(tracked.id, { state: "failed", error: "boom" })
  const failed = (await (await h.request("/session/agent-view")).json() as Array<Record<string, any>>).find((row) => row.sessionID === tracked.id)!
  expect(failed).toMatchObject({ state: "failed", error: "boom" })
})

test("R6 message DTO is complete: assistant counters, part timing, tool states, single-message views", async () => {
  const h = await boot(), session = await h.create("dto"), store = h.daemon.store
  await h.request(`/session/${session.id}/message`, { value: { parts: [{ type: "text", text: "hello" }] } })
  const turnId = ids("turn"), user = ids("item"), reasoning = ids("item"), tool = ids("item"), failing = ids("item"), answer = ids("item")
  store.sessionSink.append({ type: "turn.started", sessionId: session.id, turnId, queueId: ids("queue") })
  store.sessionSink.append({ type: "item.started", sessionId: session.id, turnId, itemId: user, kind: "user_message" })
  store.sessionSink.append({ type: "item.completed", sessionId: session.id, itemId: user, status: "ok", text: "run it" })
  store.sessionSink.append({ type: "item.started", sessionId: session.id, turnId, itemId: reasoning, kind: "reasoning" })
  store.sessionSink.append({ type: "item.completed", sessionId: session.id, itemId: reasoning, status: "ok", text: "thinking" })
  store.sessionSink.append({ type: "item.started", sessionId: session.id, turnId, itemId: tool, kind: "tool_call", meta: { tool: "read" } })
  store.sessionSink.append({ type: "item.completed", sessionId: session.id, itemId: tool, status: "ok", text: "file body", toolInput: JSON.stringify({ path: "a.ts" }) })
  store.sessionSink.append({ type: "item.started", sessionId: session.id, turnId, itemId: failing, kind: "tool_call", meta: { tool: "bash" } })
  store.sessionSink.append({ type: "item.completed", sessionId: session.id, itemId: failing, status: "error", text: "exit 2", toolInput: "not json" })
  store.sessionSink.append({ type: "item.started", sessionId: session.id, turnId, itemId: answer, kind: "agent_message" })
  store.sessionSink.append({ type: "item.completed", sessionId: session.id, itemId: answer, status: "ok", text: "done" })
  store.sessionSink.append({ type: "turn.failed", sessionId: session.id, turnId, error: { code: "provider", message: "rate limited" } })
  const rows = await (await h.request(`/session/${session.id}/message`)).json() as Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }>
  for (const row of rows) RestMessageDto.parse(row)
  const first = rows.find((row) => row.info.role === "assistant")!
  expect(first.info).toMatchObject({ mode: "build", agent: "build", cost: 0, tokens: { input: expect.any(Number), cache: { read: expect.any(Number), write: expect.any(Number) } } })
  expect(first.parts.find((part) => part.type === "text")!.time).toMatchObject({ start: expect.any(Number), end: expect.any(Number) })
  const long = rows.at(-1)!
  expect(long.info).toMatchObject({ role: "assistant", finish: "failed", error: { name: "UnknownError", data: { message: "rate limited" } }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  // Without usage reports a round ends where its tool calls give way to the next answer.
  expect(long.parts.map((part) => part.type)).toEqual(["step-start", "reasoning", "tool", "tool", "step-finish", "step-start", "text", "step-finish"])
  expect(long.parts.filter((part) => part.type === "step-finish").map((part) => part.reason)).toEqual(["tool-calls", "failed"])
  const content = long.parts.filter((part) => !part.type.startsWith("step-"))
  expect(content[0]!.time.end).toBeGreaterThanOrEqual(content[0]!.time.start)
  expect(content[1]!.state).toMatchObject({ status: "completed", input: { path: "a.ts" }, output: "file body", title: "read", metadata: {} })
  expect(content[2]!.state).toMatchObject({ status: "error", error: "exit 2", input: {} })
  expect(content[2]!.state.output).toBeUndefined()
  const messageId = long.info.id
  const single = await (await h.request(`/session/${session.id}/message/${messageId}`)).json()
  expect(single).toEqual(long)
  const tui = await (await h.request(`/session/${session.id}/message/${messageId}?view=tui`)).json()
  RestMessageDto.parse(tui)
  expect(tui.parts.map((part: { type: string }) => part.type)).toEqual(["tool", "tool", "text"])
  const window = await (await h.request(`/session/${session.id}/message/${messageId}?view=tui&partsLimit=1`)).json()
  expect(window).toMatchObject({ partsMore: true, partsCursor: tool, parts: [{ id: tool }] })
  const next = await (await h.request(`/session/${session.id}/message/${messageId}?view=tui&partsLimit=2&partsAfter=${tool}`)).json()
  expect(next.parts.map((part: { id: string }) => part.id)).toEqual([failing, answer])
  const v2 = await (await h.request(`/api/session/${session.id}/message?order=asc&limit=50`)).json()
  const assistant = v2.items.find((item: { id: string }) => item.id === messageId)
  expect(assistant).toMatchObject({ type: "assistant", error: { type: "unknown", message: "rate limited" }, content: [
    { type: "reasoning", id: reasoning, text: "thinking" },
    { type: "tool", name: "read", state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "file body" }], structured: {} }, time: { created: expect.any(Number), completed: expect.any(Number) } },
    { type: "tool", name: "bash", state: { status: "error", content: [], error: { type: "unknown", message: "exit 2" } } },
    { type: "text", text: "done" },
  ] })
  expect(v2.items.find((item: { type: string }) => item.type === "user")).toMatchObject({ agents: [] })
})

test("R6 usage insights list every local day from start to today and count streaks over them", async () => {
  const h = await boot(), session = await h.create("usage")
  await h.request(`/session/${session.id}/message`, { value: { parts: [{ type: "text", text: "/usage" }] } })
  const day = 86_400_000
  const usage = await (await h.request(`/experimental/usage-insights?start=${Date.now() - 5 * day}`)).json()
  expect(usage.days).toHaveLength(6)
  expect(usage.days.slice(0, 5).every((entry: { tokens: number; messages: number; time: number; sessions: number }) => entry.tokens === 0 && entry.messages === 0 && entry.sessions === 0 && entry.time > 0)).toBe(true)
  expect(usage.days.at(-1)).toMatchObject({ messages: 2, userMessages: 1, sessions: 1 })
  expect(usage.days.at(-1).tokens).toBeGreaterThan(0)
  expect(usage.totals).toMatchObject({ activeDays: 1, currentStreak: 1, longestStreak: 1, sessions: 1 })
  const all = await (await h.request("/experimental/usage-insights?start=0")).json()
  expect(all.days).toHaveLength(366)
  expect(all.days.map((entry: { day: string }) => entry.day)).toEqual([...all.days.map((entry: { day: string }) => entry.day)].sort())
  expect(all.totals.tokens).toBe(usage.totals.tokens)
  expect(JSON.stringify(all).length).toBeLessThan(200_000)
})

test("R6 session.init keeps the requested message id, and a reused id is refused", async () => {
  const h = await boot(), session = await h.create("init")
  const messageID = ids("item")
  expect((await h.request(`/session/${session.id}/init`, { value: { providerID: "faux", modelID: "echo", messageID } })).status).toBe(200)
  const stored = await (await h.request(`/session/${session.id}/message/${messageID}`)).json()
  RestMessageDto.parse(stored)
  expect(stored.info).toMatchObject({ id: messageID, role: "user" })
  expect(stored.parts[0].text).toContain("AGENTS.md")
  expect(h.daemon.store.messages.has(session.id, messageID)).toBe(true)
  const again = await h.request(`/session/${session.id}/init`, { value: { providerID: "faux", modelID: "echo", messageID } })
  expect(again.status).toBeGreaterThanOrEqual(400)
  const rows = await (await h.request(`/session/${session.id}/message`)).json() as Array<{ info: { id: string; role: string } }>
  expect(rows.filter((row) => row.info.role === "user")).toHaveLength(1)
  const created = RestSessionDto.parse(await (await h.request(`/session/${session.id}`)).json())
  expect(created.id).toBe(session.id)
})
