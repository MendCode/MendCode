import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createResourceRegistry, createScope, createSessionActor, realClock, type GlobalEventDraft, type TurnInput } from "@mendcode/kernel"
import { checkSessionLog } from "@mendcode/testkit"
import { CODEX_EFFORT, CODEX_MODEL, codexQuota, commandTitle, createCodexEngine } from "../src"
import type { Transport } from "../src/rpc"

/** In-memory stand-in for `codex app-server`, scripted per test. */
function fakeCodex(script: (request: { method: string; params: any }, api: { notify(method: string, params: any): void; serverRequest(method: string, params: any): Promise<any>; exit(): void }) => any) {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>((r) => (exitResolve = r))
  let done = false
  const requests: Array<{ method: string; params: any }> = []
  const serverPending = new Map<number, (v: any) => void>()
  let serverId = 1000
  const push = (msg: unknown) => {
    queue.push(JSON.stringify(msg))
    wake?.()
  }
  const api = {
    notify: (method: string, params: any) => push({ jsonrpc: "2.0", method, params }),
    serverRequest: (method: string, params: any) => new Promise<any>((resolve) => { const id = serverId++; serverPending.set(id, resolve); push({ jsonrpc: "2.0", id, method, params }) }),
    exit: () => { done = true; wake?.(); exitResolve(1) },
  }
  const transport: Transport = {
    write(line) {
      const msg = JSON.parse(line)
      if (msg.method === undefined && serverPending.has(msg.id)) { serverPending.get(msg.id)!(msg.result); serverPending.delete(msg.id); return }
      if (msg.method && msg.id === undefined) return
      requests.push({ method: msg.method, params: msg.params })
      Promise.resolve()
        .then(() => script({ method: msg.method, params: msg.params }, api))
        .then(
          (result) => push({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }),
          (error: Error) => push({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: error.message } }),
        )
    },
    lines: (async function* () {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>((r) => (wake = r))
      }
    })(),
    close: () => api.exit(),
    exited,
  }
  return { transport, requests, api }
}

function harness(fake: ReturnType<typeof fakeCodex>, extra: Partial<Parameters<typeof createCodexEngine>[0]> = {}) {
  const ids = createIdFactory()
  const registry = createResourceRegistry()
  const root = createScope({ name: "t", clock: realClock, registry })
  const events: SessionEvent[] = []
  const quotas: GlobalEventDraft[] = []
  let seq = 0
  const engine = createCodexEngine({ cwd: "/repo", transportFactory: () => fake.transport, onQuota: (q) => quotas.push(q), ...extra })
  const sessionId = ids("session")
  const actor = createSessionActor({
    sessionId, clock: realClock, scope: root, engine, ids, cancelGraceMs: 500,
    sink: { append: (d) => { const e = { ...d, seq: ++seq, at: 0 } as SessionEvent; events.push(e); return e } },
  })
  const clientId = ids("client")
  const submit = (text: string) => actor.handle({ id: ids("command"), clientId, type: "user.submit", sessionId, text, attachments: [] })
  return { actor, events, quotas, submit, sessionId, clientId, ids }
}

async function until(check: () => boolean, ms = 3_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout")
    await Bun.sleep(2)
  }
}

const RATE = { limitId: "codex", primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1791049828 }, secondary: null, planType: "pro", rateLimitReachedType: null }

function standardScript(onTurn: (params: any, api: any) => void) {
  return (req: { method: string; params: any }, api: any) => {
    if (req.method === "initialize") return { userAgent: "fake" }
    if (req.method === "account/rateLimits/read") return { rateLimits: RATE, rateLimitsByLimitId: { codex: RATE } }
    if (req.method === "thread/start") return { thread: { id: "thr1" }, model: CODEX_MODEL }
    if (req.method === "turn/start") {
      setTimeout(() => onTurn(req.params, api), 1)
      return { turn: { id: "turn1", status: "inProgress" } }
    }
    if (req.method === "turn/interrupt") {
      setTimeout(() => api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "interrupted" } }), 1)
      return {}
    }
    return {}
  }
}

describe("codex engine (fake app-server)", () => {
  test("thread bridge owns an isolated app-server with process flags, selected model/cwd and scrubbed traces", async () => {
    const token = "test-codex-bearer"
    const fakes = [0, 1].map((index) => fakeCodex((request, api) => {
      if (request.method === "thread/start" || request.method === "thread/resume") return { thread: { id: `thread-${index}` } }
      if (request.method === "turn/start") {
        api.notify("item/started", { threadId: `thread-${index}`, item: { type: "agentMessage", id: "answer" } })
        api.notify("item/completed", { threadId: `thread-${index}`, item: { type: "agentMessage", id: "answer", text: token } })
        api.notify("turn/completed", { threadId: `thread-${index}`, turn: { status: "completed" } })
        return { turn: { id: `turn-${index}` } }
      }
      return {}
    }))
    const ids = createIdFactory()
    const spawns: Array<{ args: string[]; cwd: string }> = []
    const traces: string[] = []
    const saved = new Map<string, string>()
    const engine = createCodexEngine({ cwd: "/unused", model: "configured-model", effort: "high", bindings: { get: (id) => saved.get(id), set: (id, thread) => { saved.set(id, thread) } }, trace: (_direction, line) => traces.push(line), transportFactory: (spawn) => { spawns.push(spawn); return fakes[spawns.length - 1]!.transport } })
    const events: unknown[] = []
    const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "check", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => { events.push(event) }, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {}, externalMcp: { args: ["-c", "mcp_servers.mendcode_threads.url=\"http://127.0.0.1:12345/mcp\""], cwd: "/project", scrub: (text) => text.replaceAll(token, "[redacted]") } }
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(await fakes[0]!.transport.exited).toBe(1)
    expect(await engine.runTurn({ ...input, turnId: ids("turn") })).toEqual({ status: "ok" })
    expect(spawns[0]!.cwd).toBe("/project")
    expect(spawns[0]!.args).toContain("model=\"configured-model\"")
    expect(spawns[0]!.args).toContain(input.externalMcp!.args[1]!)
    expect(fakes[1]!.requests.some((request) => request.method === "thread/resume")).toBe(true)
    expect(JSON.stringify(events)).not.toContain(token)
    expect(traces.some((line) => line.includes(token))).toBe(false)
    engine.stop()
  })
  test("with /fast the app-server starts on Codex's fast service tier; without it, on its default", async () => {
    for (const fast of [true, false]) {
      const fake = fakeCodex(standardScript((_params, api) => api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })))
      const spawns: Array<{ args: string[] }> = []
      const engine = createCodexEngine({ cwd: "/repo", ...(fast ? { fast: true } : {}), transportFactory: (spawn) => { spawns.push(spawn); return fake.transport } })
      const ids = createIdFactory()
      expect(await engine.runTurn({ sessionId: ids("session"), turnId: ids("turn"), text: "check", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {} })).toEqual({ status: "ok" })
      expect(spawns[0]!.args.includes(`service_tier="fast"`)).toBe(fast)
      // Live web search always: the sandbox has no network, so it is how a Codex agent or sub-agent looks anything up.
      expect(spawns[0]!.args.join(" ")).toContain(`-c web_search="live"`)
      engine.stop()
    }
  })

  test("/env credentials reach the app-server's shells, past Codex's own key filter, and its developer instructions name them", async () => {
    const fake = fakeCodex(standardScript((_params, api) => api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })))
    const spawns: Array<{ args: string[]; env?: Record<string, string> }> = []
    const engine = createCodexEngine({ cwd: "/repo", environment: { values: { INSTABOX_KEY: "ib-secret" }, note: "MendCode credentials (set by the user in /env) are in your shell's environment: INSTABOX_KEY." }, transportFactory: (spawn) => { spawns.push(spawn); return fake.transport } })
    const ids = createIdFactory()
    const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "check", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {} }
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(spawns[0]!.env).toEqual({ INSTABOX_KEY: "ib-secret" })
    expect(spawns[0]!.args).toContain("shell_environment_policy.ignore_default_excludes=true")
    expect(spawns[0]!.args.join(" ")).not.toContain("ib-secret")
    const exclude = spawns[0]!.args.find((arg) => arg.startsWith("shell_environment_policy.exclude="))!
    expect(JSON.parse(exclude.slice("shell_environment_policy.exclude=".length))).not.toContain("INSTABOX_KEY")
    expect(fake.requests.find((request) => request.method === "thread/start")?.params.developerInstructions).toContain("INSTABOX_KEY")
    engine.stop()
  })

  test("maps a streamed answer, token usage and quota into MendCode events; always luna + low", async () => {
    const fake = fakeCodex(
      standardScript((params, api) => {
        api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })
        api.notify("item/started", { threadId: "thr1", turnId: "turn1", item: { type: "userMessage", id: "u1" } })
        api.notify("item/started", { threadId: "thr1", turnId: "turn1", item: { type: "agentMessage", id: "m1", text: "" } })
        api.notify("item/agentMessage/delta", { threadId: "thr1", turnId: "turn1", itemId: "m1", delta: "o" })
        api.notify("item/agentMessage/delta", { threadId: "thr1", turnId: "turn1", itemId: "m1", delta: "k" })
        api.notify("item/completed", { threadId: "thr1", turnId: "turn1", item: { type: "agentMessage", id: "m1", text: "ok" } })
        api.notify("thread/tokenUsage/updated", { threadId: "thr1", turnId: "turn1", tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 5, reasoningOutputTokens: 1 } } })
        api.notify("account/rateLimits/updated", { rateLimits: { ...RATE, primary: { ...RATE.primary, usedPercent: 18 } } })
        api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })
      }),
    )
    const h = harness(fake)
    await h.submit("hola")
    await until(() => h.events.some((e) => e.type === "turn.completed"))
    const answer = h.events.find((e) => e.type === "item.completed" && e.text === "ok")
    expect(answer).toBeDefined()
    expect(h.events.filter((e) => e.type === "item.delta").map((e) => (e as { text: string }).text).join("")).toBe("ok")
    expect(h.events.find((e) => e.type === "usage.recorded")).toMatchObject({ provider: "codex", model: CODEX_MODEL, input: 60, cacheRead: 40, output: 5, reasoning: 1 })
    expect(h.quotas.map((q) => (q as any).windows[0].usedPercent)).toEqual([17, 18])
    expect((h.quotas[0] as any).windows[0]).toMatchObject({ label: "7d", windowMinutes: 10080, resetsAt: 1791049828000 })
    const turnStart = fake.requests.find((r) => r.method === "turn/start")!
    expect(turnStart.params).toMatchObject({ model: CODEX_MODEL, effort: CODEX_EFFORT })
    expect(fake.requests.find((r) => r.method === "thread/start")!.params.model).toBe(CODEX_MODEL)
    expect(checkSessionLog(h.events, { final: true })).toEqual([])
  })

  test("a multi-call turn reports each call's own context (the cumulative total never becomes the context) and the window Codex states", async () => {
    const update = (last: Record<string, number>, total: Record<string, number>, modelContextWindow: number) => ["thread/tokenUsage/updated", { threadId: "thr1", turnId: "turn1", tokenUsage: { last, total, modelContextWindow } }] as const
    const fake = fakeCodex(
      standardScript((_params, api) => {
        api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })
        api.notify(...update({ inputTokens: 50_000, cachedInputTokens: 40_000, outputTokens: 500, reasoningOutputTokens: 100 }, { inputTokens: 50_000, cachedInputTokens: 40_000, outputTokens: 500, reasoningOutputTokens: 100 }, 258_000))
        api.notify(...update({ inputTokens: 52_000, cachedInputTokens: 50_000, outputTokens: 700, reasoningOutputTokens: 200 }, { inputTokens: 102_000, cachedInputTokens: 90_000, outputTokens: 1_200, reasoningOutputTokens: 300 }, 258_000))
        api.notify(...update({ inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, { inputTokens: 402_000, cachedInputTokens: 90_000, outputTokens: 1_210, reasoningOutputTokens: 300 }, 258_000))
        api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })
      }),
    )
    const h = harness(fake)
    await h.submit("hola")
    await until(() => h.events.some((e) => e.type === "turn.completed"))
    const usage = h.events.filter((e) => e.type === "usage.recorded") as any[]
    expect(usage.map((e) => e.context)).toEqual([50_500, 52_700, 258_000])
    expect(usage.map((e) => e.contextWindow)).toEqual([258_000, 258_000, 258_000])
    expect(usage.map((e) => e.contextApprox)).toEqual([undefined, undefined, true])
    // Totals stay the sums of the calls.
    expect(usage.reduce((sum, e) => sum + e.input + e.cacheRead, 0)).toBe(402_000)
  })

  test("an image Codex generates shows as the image card with the picture, before the turn ends; a failed one is an error card", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-image-"))
    const png = path.join(dir, "ig_1.png")
    writeFileSync(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
    const stored: Array<{ mime: string; bytes: number }> = []
    const fake = fakeCodex(standardScript(async (_params, api) => {
      api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })
      api.notify("item/started", { threadId: "thr1", turnId: "turn1", item: { type: "imageGeneration", id: "ig1", status: "inProgress" } })
      api.notify("item/completed", { threadId: "thr1", turnId: "turn1", item: { type: "imageGeneration", id: "ig1", status: "completed", revisedPrompt: "a lighthouse at dusk", savedPath: png } })
      api.notify("item/started", { threadId: "thr1", turnId: "turn1", item: { type: "imageGeneration", id: "ig2", status: "inProgress" } })
      api.notify("item/completed", { threadId: "thr1", turnId: "turn1", item: { type: "imageGeneration", id: "ig2", status: "failed", failure: { message: "blocked" } } })
      api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })
    }))
    const h = harness(fake, { storeImage: async (bytes, mime) => { stored.push({ mime, bytes: bytes.length }); return { sha256: "a".repeat(64), mime, bytes: bytes.length } } })
    await h.submit("draw")
    await until(() => h.events.some((e) => e.type === "turn.completed"))
    rmSync(dir, { recursive: true, force: true })
    expect(h.events.filter((e) => e.type === "item.started" && e.kind === "tool_call").map((e: any) => e.meta.tool)).toEqual(["image_generation", "image_generation"])
    const tools = new Set(h.events.filter((e) => e.type === "item.started" && e.kind === "tool_call").map((e: any) => e.itemId))
    const done = h.events.filter((e) => e.type === "item.completed" && tools.has((e as any).itemId)) as any[]
    expect(done.find((e) => e.status === "ok")).toMatchObject({ text: `a lighthouse at dusk\n${png}`, attachments: [{ mime: "image/png", bytes: 12 }] })
    expect(done.find((e) => e.status === "error")).toMatchObject({ text: "blocked" })
    expect(done).toHaveLength(2)
    expect(stored).toEqual([{ mime: "image/png", bytes: 12 }])
  })

  test("a command approval goes through the actor and the user's decision is returned to Codex", async () => {
    let decision: any
    const fake = fakeCodex(
      standardScript(async (_params, api) => {
        api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })
        api.notify("item/started", { threadId: "thr1", turnId: "turn1", item: { type: "commandExecution", id: "c1", command: "ls -la" } })
        decision = await api.serverRequest("item/commandExecution/requestApproval", { threadId: "thr1", turnId: "turn1", itemId: "c1", command: "ls -la" })
        api.notify("item/commandExecution/outputDelta", { threadId: "thr1", turnId: "turn1", itemId: "c1", delta: "README.md\n" })
        api.notify("item/completed", { threadId: "thr1", turnId: "turn1", item: { type: "commandExecution", id: "c1", command: "ls -la", aggregatedOutput: "README.md\n", exitCode: 0, status: "completed" } })
        api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })
      }),
    )
    const h = harness(fake)
    await h.submit("lista archivos")
    await until(() => h.events.some((e) => e.type === "server.request"))
    const request = h.events.find((e) => e.type === "server.request")!
    expect(request).toMatchObject({ kind: "approval", detail: "ls -la" })
    expect(h.actor.snapshot().foreground).toBe("waiting_approval")
    await h.actor.handle({ id: h.ids("command"), clientId: h.clientId, type: "request.resolve", sessionId: h.sessionId, requestId: (request as any).requestId, decision: { kind: "approve", scope: "once" } })
    await until(() => h.events.some((e) => e.type === "turn.completed"))
    expect(decision).toEqual({ decision: "accept" })
    expect(h.events.find((e) => e.type === "item.started" && e.kind === "tool_call")).toMatchObject({ meta: { tool: "ls -la" } })
  })

  test("in full permission mode Codex approvals are accepted without asking the user", async () => {
    let decision: any
    const fake = fakeCodex(
      standardScript(async (_params, api) => {
        api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })
        decision = await api.serverRequest("item/commandExecution/requestApproval", { threadId: "thr1", turnId: "turn1", itemId: "c1", command: "ls" })
        api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })
      }),
    )
    const h = harness(fake)
    await h.actor.handle({ id: h.ids("command"), clientId: h.clientId, type: "session.permission.set", sessionId: h.sessionId, mode: "full" })
    await h.submit("lista")
    await until(() => h.events.some((e) => e.type === "turn.completed"))
    expect(decision).toEqual({ decision: "accept" })
    expect(h.events.some((e) => e.type === "server.request")).toBe(false)
    expect(h.events.find((e) => e.type === "session.permission")).toMatchObject({ mode: "full" })
  })

  test("a delegated plan ceiling is read-only in the sandbox and resets on the next turn", async () => {
    const decisions: unknown[] = []
    const fake = fakeCodex(standardScript(async (_params, api) => {
      api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })
      decisions.push(await api.serverRequest("item/fileChange/requestApproval", { threadId: "thr1", turnId: "turn1", itemId: "edit" }))
      api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })
    }))
    const h = harness(fake)
    await h.actor.handle({ id: h.ids("command"), clientId: h.clientId, type: "session.permission.set", sessionId: h.sessionId, mode: "plan" })
    await h.submit("review only")
    await until(() => h.events.some((event) => event.type === "turn.completed"))
    expect(fake.requests.find((request) => request.method === "thread/start")!.params.sandbox).toBe("read-only")
    expect(fake.requests.find((request) => request.method === "turn/start")!.params.sandboxPolicy).toEqual({ type: "readOnly" })
    expect(decisions).toEqual([{ decision: "decline" }])
    expect(h.events.some((event) => event.type === "server.request")).toBe(false)
    await h.actor.handle({ id: h.ids("command"), clientId: h.clientId, type: "session.permission.set", sessionId: h.sessionId, mode: "edits" })
    await h.submit("edit now")
    await until(() => h.events.filter((event) => event.type === "turn.completed").length === 2)
    expect(fake.requests.filter((request) => request.method === "turn/start")[1]!.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: ["/repo"], networkAccess: false })
    expect(decisions[1]).toEqual({ decision: "accept" })
  })

  test("Esc Esc sends turn/interrupt to Codex and the turn ends as cancelled", async () => {
    const fake = fakeCodex(standardScript((_p, api) => api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })))
    const h = harness(fake)
    await h.submit("tarea larga")
    await until(() => fake.requests.some((r) => r.method === "turn/start"))
    await Bun.sleep(10)
    await h.actor.handle({ id: h.ids("command"), clientId: h.clientId, type: "turn.cancel", sessionId: h.sessionId, turnId: h.actor.snapshot().turnId! })
    await until(() => h.events.some((e) => e.type === "turn.cancelled"))
    expect(fake.requests.some((r) => r.method === "turn/interrupt" && r.params.turnId === "turn1")).toBe(true)
  })

  test("if the app-server dies mid-turn the turn fails instead of hanging (I12 class)", async () => {
    const fake = fakeCodex(standardScript((_p, api) => { api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } }); setTimeout(() => api.exit(), 5) }))
    const h = harness(fake)
    await h.submit("hola")
    await until(() => h.events.some((e) => e.type === "turn.failed"))
    expect(h.events.find((e) => e.type === "turn.failed")).toMatchObject({ error: { code: "codex_exited" } })
  })

  test("a silent turn is interrupted by the idle watchdog instead of generating forever (I12, FC-33)", async () => {
    const fake = fakeCodex(standardScript((_p, api) => api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })))
    const h = harness(fake, { idleMs: 60 })
    await h.submit("hola")
    await until(() => h.events.some((e) => e.type === "turn.failed"))
    expect(h.events.find((e) => e.type === "turn.failed")).toMatchObject({ error: { code: "stream_idle" } })
    expect(fake.requests.some((r) => r.method === "turn/interrupt")).toBe(true)
  })

  test("the watchdog does not fire while the user is deciding an approval", async () => {
    const fake = fakeCodex(
      standardScript(async (_p, api) => {
        api.notify("turn/started", { threadId: "thr1", turn: { id: "turn1" } })
        await api.serverRequest("item/commandExecution/requestApproval", { threadId: "thr1", turnId: "turn1", itemId: "c1", command: "ls" })
        api.notify("turn/completed", { threadId: "thr1", turn: { id: "turn1", status: "completed" } })
      }),
    )
    const h = harness(fake, { idleMs: 40 })
    await h.submit("hola")
    await until(() => h.events.some((e) => e.type === "server.request"))
    await Bun.sleep(150)
    expect(h.events.some((e) => e.type === "turn.failed")).toBe(false)
    const request = h.events.find((e) => e.type === "server.request") as any
    await h.actor.handle({ id: h.ids("command"), clientId: h.clientId, type: "request.resolve", sessionId: h.sessionId, requestId: request.requestId, decision: { kind: "deny" } })
    await until(() => h.events.some((e) => e.type === "turn.completed"))
  })

  test("after a restart the session resumes its bound Codex thread; a missing thread falls back to a new one", async () => {
    for (const resumable of [true, false]) {
      const saved = new Map<string, string>()
      const fake = fakeCodex((req, api) => {
        if (req.method === "thread/resume") {
          if (!resumable) return Promise.reject(new Error("thread not found"))
          return { thread: { id: req.params.threadId } }
        }
        return standardScript((_p, a) => {
          a.notify("turn/started", { threadId: req.method === "turn/start" ? req.params.threadId : "thr1", turn: { id: "turn1" } })
          a.notify("turn/completed", { threadId: req.method === "turn/start" ? req.params.threadId : "thr1", turn: { id: "turn1", status: "completed" } })
        })(req, api)
      })
      const ids = createIdFactory()
      const sessionId = ids("session")
      saved.set(sessionId, "thrOld")
      const engine = createCodexEngine({ cwd: "/repo", transportFactory: () => fake.transport, bindings: { get: (s) => saved.get(s), set: (s, t) => void saved.set(s, t) } })
      let seq = 0
      const events: SessionEvent[] = []
      const root = createScope({ name: "r", clock: realClock, registry: createResourceRegistry() })
      const actor = createSessionActor({ sessionId, clock: realClock, scope: root, engine, ids, sink: { append: (d) => { const e = { ...d, seq: ++seq, at: 0 } as SessionEvent; events.push(e); return e } } })
      await actor.handle({ id: ids("command"), clientId: ids("client"), type: "user.submit", sessionId, text: "¿seguimos?", attachments: [] })
      await until(() => events.some((e) => e.type === "turn.completed" || e.type === "turn.failed"))
      const turnStart = fake.requests.find((r) => r.method === "turn/start")!
      if (resumable) {
        expect(fake.requests.some((r) => r.method === "thread/start")).toBe(false)
        expect(turnStart.params.threadId).toBe("thrOld")
      } else {
        expect(fake.requests.some((r) => r.method === "thread/start")).toBe(true)
        expect(saved.get(sessionId)).toBe("thr1")
      }
      engine.stop()
      root.dispose()
    }
  })

  test("tool titles show the real command without the shell wrapper", () => {
    expect(commandTitle("/bin/zsh -lc ls")).toBe("ls")
    expect(commandTitle("/bin/bash -lc 'git status --short'")).toBe("git status --short")
    expect(commandTitle("sh -c \"echo hola\"")).toBe("echo hola")
    expect(commandTitle("rg -n foo")).toBe("rg -n foo")
  })

  test("quota parsing never assumes primary is 5h and ignores missing windows", () => {
    expect(codexQuota({ primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } }, 0)?.windows.map((w) => w.label)).toEqual(["5h", "7d"])
    expect(codexQuota({ primary: null, secondary: null }, 0)).toBeUndefined()
  })
})

describe.skipIf(process.env.MENDCODE_LIVE_CODEX !== "1")("codex engine (live, gpt-6-luna low)", () => {
  test("a real turn with the user's Codex subscription answers and reports quota", async () => {
    const ids = createIdFactory()
    const registry = createResourceRegistry()
    const root = createScope({ name: "live", clock: realClock, registry })
    const events: SessionEvent[] = []
    const quotas: GlobalEventDraft[] = []
    let seq = 0
    const engine = createCodexEngine({ cwd: process.env.MENDCODE_LIVE_CWD ?? process.cwd(), onQuota: (q) => quotas.push(q) })
    const sessionId = ids("session")
    const actor = createSessionActor({ sessionId, clock: realClock, scope: root, engine, ids, sink: { append: (d) => { const e = { ...d, seq: ++seq, at: 0 } as SessionEvent; events.push(e); return e } } })
    await actor.handle({ id: ids("command"), clientId: ids("client"), type: "user.submit", sessionId, text: "Responde exactamente: listo", attachments: [] })
    await until(() => events.some((e) => e.type.startsWith("turn.") && e.type !== "turn.started"), 90_000)
    engine.stop()
    root.dispose()
    const answer = events.filter((e) => e.type === "item.completed" && typeof (e as any).text === "string").map((e: any) => e.text).join(" ")
    console.log(JSON.stringify({ answer, usage: events.find((e) => e.type === "usage.recorded"), quota: quotas.at(-1) }))
    expect(events.some((e) => e.type === "turn.completed")).toBe(true)
    expect(answer.toLowerCase()).toContain("listo")
    expect(quotas.length).toBeGreaterThan(0)
    expect(checkSessionLog(events, { final: true })).toEqual([])
  }, 120_000)
})
