import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createAppServerClient, AppServerError } from "@mendcode/client/app-server"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionEvent } from "@mendcode/protocol"
import { createAppServer, inputText, type AppServerDeps } from "../src/app-server"
import { parseStartup } from "../src/startup"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 5))
  }
}

type Handlers = NonNullable<Parameters<typeof createAppServerClient>[0]["handlers"]>

/** A real daemon (faux engine), an app-server on top and a typed client wired to it in process; `out` is every line the server wrote. */
async function boot(handlers: Handlers = {}, daemonDir?: string) {
  const dir = daemonDir ?? realpathSync(mkdtempSync(path.join(tmpdir(), "mend-appserver-")))
  if (!daemonDir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  return attachServer(daemon.socketPath, dir, handlers)
}

async function attachServer(socketPath: string, dir: string, handlers: Handlers = {}, startWaitMs = 300) {
  let onEvent: ((event: SessionEvent) => void) | undefined
  const client = createClient({ socketPath, name: "app-server", reconnect: false, onEvent: (event) => onEvent?.(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const out: Array<Record<string, any>> = []
  let host: ReturnType<typeof createAppServerClient> | undefined
  const server = createAppServer({
    client,
    listen: (handler) => void (onEvent = handler),
    write: (line) => {
      out.push(JSON.parse(line))
      host?.receive(line)
    },
    version: "0.0.1-test",
    cwd: dir,
    startWaitMs,
  })
  host = createAppServerClient({ clientInfo: { name: "test-host" }, write: (line) => void server.handleLine(line), handlers })
  const notifications: Array<{ method: string; params: any }> = []
  host.listen((method, params) => void notifications.push({ method, params }))
  return { server, host, out, notifications, dir, socketPath }
}

describe("app-server handshake and errors", () => {
  test("methods before initialize are refused, initialize answers the protocol, a second one is refused", async () => {
    const { server, host, out } = await boot()
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/list", params: {} }))
    expect(out.at(-1)).toMatchObject({ id: 1, error: { code: -32002 } })
    const info = await host.initialize()
    expect(info).toMatchObject({ protocol: "mendcode-app-server@1", serverInfo: { name: "MendCode", version: "0.0.1-test" } })
    expect(info.methods).toContain("turn/start")
    await expect(host.request("initialize", { clientInfo: { name: "again" } })).rejects.toMatchObject({ code: -32003 })
  })

  test("unknown methods, bad JSON, bad params and unknown threads get JSON-RPC errors", async () => {
    const { server, host, out } = await boot()
    await host.initialize()
    await expect(host.request("thread/fly" as never, {} as never)).rejects.toMatchObject({ code: -32601 })
    await server.handleLine("{not json")
    expect(out.at(-1)).toMatchObject({ id: null, error: { code: -32700 } })
    await server.handleLine("[1]")
    expect(out.at(-1)).toMatchObject({ error: { code: -32600 } })
    await expect(host.request("turn/start", { threadId: "", input: [] })).rejects.toMatchObject({ code: -32602 })
    await expect(host.request("thread/start", { approvalPolicy: "wild" as never })).rejects.toMatchObject({ code: -32602 })
    const error = await host.request("thread/read", { threadId: "ses_00000000000000000000000000" }).catch((e) => e)
    expect(error).toBeInstanceOf(AppServerError)
    expect(error.code).toBe(-32004)
    const { thread } = await host.request("thread/start", {})
    await expect(host.request("turn/start", { threadId: thread.id, input: [] })).rejects.toMatchObject({ code: -32602 })
    await expect(host.request("turn/start", { threadId: thread.id, input: [{ type: "localImage", path: "/nope/missing.png" }] })).rejects.toMatchObject({ code: -32010 })
    await expect(host.request("turn/interrupt", { threadId: thread.id })).rejects.toMatchObject({ code: -32602 })
  })

  test("startup parsing: app-server takes no positional arguments, takes --cwd, and the input text joins text and mentions", () => {
    expect(parseStartup(["app-server", "--cwd", "../p"])).toMatchObject({ kind: "app-server", project: "../p" })
    expect(() => parseStartup(["app-server", "extra"])).toThrow("app-server takes no positional arguments")
    expect(inputText([{ type: "text", text: "fix it" }, { type: "mention", path: "src/a.ts" }, { type: "localImage", path: "/x.png" }])).toBe("fix it\n\n@src/a.ts")
  })
})

describe("app-server threads and turns over a real daemon", () => {
  test("a turn streams deltas; the reply to turn/start comes before turn/started; runTurn returns the answer", async () => {
    const { host, out, notifications } = await boot()
    await host.initialize()
    const { thread } = await host.request("thread/start", { approvalPolicy: "ask", title: "demo" })
    expect(thread).toMatchObject({ title: "demo", approvalPolicy: "ask", state: "idle" })
    expect(notifications.find((n) => n.method === "thread/started")?.params.thread.id).toBe(thread.id)

    const result = await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "hola" }] })
    expect(result.turn.status).toBe("completed")
    expect(result.text).toBe("echo: hola")
    const deltas = notifications.filter((n) => n.method === "item/agentMessage/delta").map((n) => n.params.delta).join("")
    expect(deltas).toBe("echo: hola")

    const replyAt = out.findIndex((m) => m.result?.queueId !== undefined)
    const startedAt = out.findIndex((m) => m.method === "turn/started")
    expect(replyAt).toBeGreaterThanOrEqual(0)
    expect(replyAt).toBeLessThan(startedAt)
    expect(out.at(-1)).toMatchObject({ method: "turn/completed" })
  })

  test("list, read with turns, rename, archive, fork and model/list", async () => {
    const { host } = await boot()
    await host.initialize()
    const { thread } = await host.request("thread/start", { title: "one" })
    await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "first" }] })
    await host.request("thread/name/set", { threadId: thread.id, name: "renamed" })

    const listed = await host.request("thread/list", {})
    expect(listed.data.map((t) => [t.id, t.title])).toContainEqual([thread.id, "renamed"])

    const read = await host.request("thread/read", { threadId: thread.id, includeTurns: true })
    expect(read.turns?.length).toBe(1)
    expect(read.turns![0]!.status).toBe("completed")
    expect(read.turns![0]!.items!.map((item) => item.type)).toEqual(["userMessage", "agentMessage"])
    expect(read.turns![0]!.items!.find((item) => item.type === "agentMessage")).toMatchObject({ text: "echo: first" })
    expect((await host.request("thread/read", { threadId: thread.id })).turns).toBeUndefined()

    const forked = await host.request("thread/fork", { threadId: thread.id, title: "branch" })
    expect(forked.thread.id).not.toBe(thread.id)
    expect(forked.thread.title).toBe("branch")

    await host.request("thread/archive", { threadId: thread.id })
    expect((await host.request("thread/list", {})).data.some((t) => t.id === thread.id)).toBe(false)
    expect((await host.request("thread/list", { archived: true })).data.some((t) => t.id === thread.id)).toBe(true)
    await host.request("thread/archive", { threadId: thread.id, restore: true })

    const models = await host.request("model/list", {})
    expect(Array.isArray(models.data)).toBe(true)
  })

  test("a second server resumes the thread from another connection and continues it", async () => {
    const first = await boot()
    await first.host.initialize()
    const { thread } = await first.host.request("thread/start", { title: "persist" })
    await first.host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "one" }] })

    // A fresh app-server process on the same daemon (a host restart): resume by id.
    const second = await attachServer(first.socketPath, first.dir)
    await second.host.initialize()
    const resumed = await second.host.request("thread/resume", { threadId: thread.id })
    expect(resumed.thread).toMatchObject({ id: thread.id, title: "persist" })
    const result = await second.host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "two" }] })
    expect(result.text).toBe("echo: two")
    const history = await second.host.request("thread/read", { threadId: thread.id, includeTurns: true })
    expect(history.turns?.map((turn) => turn.items!.find((item) => item.type === "userMessage"))).toMatchObject([{ text: "one" }, { text: "two" }])
  })

  test("turn/start on a busy thread queues (queued: true) and its turn/started carries the same queueId", async () => {
    const { host, notifications } = await boot()
    await host.initialize()
    const { thread } = await host.request("thread/start", {})
    const running = host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "/tool 150" }] })
    await until(() => notifications.some((n) => n.method === "turn/started"))
    const queued = await host.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "second" }] })
    expect(queued).toMatchObject({ queued: true, turn: null })
    await running
    await until(() => notifications.filter((n) => n.method === "turn/started").length === 2)
    expect(notifications.filter((n) => n.method === "turn/started")[1]!.params.queueId).toBe(queued.queueId)
    await until(() => notifications.filter((n) => n.method === "turn/completed").length === 2)
  })

  test("turn/interrupt ends a running turn as interrupted", async () => {
    const { host, notifications } = await boot()
    await host.initialize()
    const { thread } = await host.request("thread/start", {})
    const running = host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "/hang" }] })
    await until(() => notifications.some((n) => n.method === "item/started" && n.params.item.type === "toolCall"))
    expect(notifications.find((n) => n.params?.item?.type === "toolCall")!.params.item).toMatchObject({ type: "toolCall", status: "inProgress" })
    await host.request("turn/interrupt", { threadId: thread.id })
    expect((await running).turn).toMatchObject({ status: "interrupted", reason: "user" })
  })

  test("usage is reported as thread/tokenUsage/updated and a failure as a failed turn", async () => {
    const { host, notifications } = await boot()
    await host.initialize()
    const { thread } = await host.request("thread/start", {})
    await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "/usage" }] })
    expect(notifications.find((n) => n.method === "thread/tokenUsage/updated")!.params).toMatchObject({ threadId: thread.id, model: "echo", last: { inputTokens: 6, outputTokens: 12 } })
    const failed = await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "/fail" }] })
    expect(failed.turn).toMatchObject({ status: "failed", error: { code: "faux_failure", message: "requested failure" } })
  })

  test("an approval request goes to the host: accept lets the tool run, decline does not, an erroring host declines", async () => {
    const decisions: Array<"accept" | "decline" | "error"> = ["accept", "decline", "error"]
    const asked: Array<Record<string, any>> = []
    const { host, notifications } = await boot({
      "item/tool/requestApproval": (params) => {
        asked.push(params)
        const next = decisions.shift()!
        if (next === "error") throw new Error("host cannot answer")
        return { decision: next }
      },
    })
    await host.initialize()
    const { thread } = await host.request("thread/start", {})
    const accepted = await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "/ask" }] })
    expect(accepted.text).toBe("echo: /ask")
    expect(asked[0]).toMatchObject({ threadId: thread.id, title: "faux tool", detail: "run faux tool?" })
    const declined = await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "/ask" }] })
    expect(declined.text).toBe("")
    const errored = await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "/ask" }] })
    expect(errored.text).toBe("")
    expect(notifications.filter((n) => n.method === "serverRequest/resolved").map((n) => n.params.resolution)).toEqual(["approved", "denied", "denied"])
  })
})

describe("app-server process", () => {
  test("the real command speaks JSON-RPC on stdio: a typed client starts a thread and runs a turn, and stdout holds only protocol lines", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-appserver-e2e-")))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const entry = path.join(import.meta.dir, "../src/entry.ts")
    const child = Bun.spawn([process.execPath, entry, "app-server", "--dir", dir, "--engine", "faux", "--cwd", dir], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: dir, CODEX_HOME: dir, MENDCODE_V2_DIR: dir },
    })
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill("SIGTERM")
      await child.exited
      const closing = createClient({ socketPath: path.join(dir, "mendd.sock"), name: "cleanup", reconnect: false })
      if (await closing.connect().then(() => true, () => false)) await closing.send({ type: "daemon.shutdown", force: true }).catch(() => undefined)
      closing.close()
    })
    const lines: string[] = []
    const host = createAppServerClient({ clientInfo: { name: "e2e" }, write: (line) => void child.stdin.write(line) })
    void (async () => {
      const decoder = new TextDecoder()
      let pending = ""
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true })
        for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
          lines.push(pending.slice(0, newline))
          host.receive(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
        }
      }
    })()
    const info = await host.initialize()
    expect(info.cwd).toBe(dir)
    const { thread } = await host.request("thread/start", { title: "e2e" })
    const result = await host.runTurn({ threadId: thread.id, input: [{ type: "text", text: "ping" }] })
    expect(result).toMatchObject({ text: "echo: ping", turn: { status: "completed" } })
    expect(lines.every((line) => (JSON.parse(line) as { jsonrpc?: string }).jsonrpc === "2.0")).toBe(true)
    child.stdin.end()
    expect(await child.exited).toBe(0)
  }, 30_000)
})

/** Unit level: a recording client and events injected by hand, for requests the faux engine cannot raise. */
function harness() {
  const commands: Array<Record<string, any>> = []
  const gate: { hold: Promise<void> } = { hold: Promise.resolve() }
  let handler: ((event: SessionEvent) => void) | undefined
  const deps: AppServerDeps = {
    client: {
      send: async (command: Record<string, any>) => {
        commands.push(command)
        if (command.type === "session.get") return { ok: true, result: { session: { sessionId: "ses_1", directory: "/repo", title: "t", createdAt: 1, updatedAt: 2, lastSeq: 7, state: "idle", queued: 0, permission: "ask", status: "idle" } } }
        if (command.type === "user.submit") {
          await gate.hold
          return { ok: true, result: { queueId: "que_1" } }
        }
        if (command.type === "models.list") return { ok: true, result: { engine: "x", selectable: true, models: [{ id: "gpt-x", name: "X", efforts: ["low", "high"] }], defaults: { model: "gpt-x" }, roles: {} } }
        return { ok: true, result: {} }
      },
      subscribe: async () => ({ ok: true, result: { lastSeq: 7 } }),
    } as unknown as AppServerDeps["client"],
    listen: (next) => void (handler = next),
    write: () => undefined,
    version: "t",
    cwd: "/repo",
    startWaitMs: 20,
  }
  const out: Array<Record<string, any>> = []
  deps.write = (line) => void out.push(JSON.parse(line))
  const server = createAppServer(deps)
  const call = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    await server.handleLine(JSON.stringify({ id, method, params }))
    await until(() => out.some((m) => m.id === id))
    return out.find((m) => m.id === id)
  }
  const event = (body: Record<string, unknown>) => handler!({ sessionId: "ses_1", seq: 8, at: 1, ...body } as unknown as SessionEvent)
  return { server, out, commands, call, event, gate }
}

describe("app-server request mapping", () => {
  test("a question becomes item/tool/requestUserInput and the answers return as one answer", async () => {
    const { server, out, commands, call, event } = harness()
    await call(1, "initialize", { clientInfo: { name: "h" } })
    await call(2, "thread/resume", { threadId: "ses_1" })
    event({ type: "server.request", requestId: "req_1", turnId: "trn_1", kind: "question", title: "Which?", detail: "", questions: [{ header: "Pick", question: "Which?", options: [{ label: "a" }, { label: "b" }] }, { header: "Why", question: "Why?", options: [] }] })
    const asked = out.find((m) => m.method === "item/tool/requestUserInput")!
    expect(asked.params.questions).toMatchObject([{ id: "q0", header: "Pick", options: [{ label: "a" }, { label: "b" }] }, { id: "q1", header: "Why" }])
    await server.handleLine(JSON.stringify({ id: asked.id, result: { answers: { q0: { answers: ["b"] }, q1: { answers: ["because", "reasons"] } } } }))
    await until(() => commands.some((c) => c.type === "request.resolve"))
    expect(commands.find((c) => c.type === "request.resolve")).toMatchObject({ requestId: "req_1", decision: { kind: "answer", text: "Pick: b\nWhy: because, reasons", answers: [["b"], ["because", "reasons"]] } })
  })

  test("cancel declines and interrupts the turn; a request resolved elsewhere is not answered twice", async () => {
    const { server, out, commands, call, event } = harness()
    await call(1, "initialize", { clientInfo: { name: "h" } })
    await call(2, "thread/resume", { threadId: "ses_1" })
    event({ type: "server.request", requestId: "req_1", turnId: "trn_1", kind: "approval", title: "shell: rm x", detail: "rm x", tool: "shell", permission: "execute" })
    const first = out.find((m) => m.method === "item/commandExecution/requestApproval")!
    await server.handleLine(JSON.stringify({ id: first.id, result: { decision: "cancel" } }))
    await until(() => commands.some((c) => c.type === "turn.cancel"))
    expect(commands.find((c) => c.type === "request.resolve")).toMatchObject({ decision: { kind: "deny" } })
    expect(commands.find((c) => c.type === "turn.cancel")).toMatchObject({ turnId: "trn_1" })

    commands.length = 0
    event({ type: "server.request", requestId: "req_2", turnId: "trn_1", kind: "approval", title: "edit: a.ts", detail: "", tool: "edit", permission: "write" })
    const second = out.find((m) => m.method === "item/fileChange/requestApproval")!
    event({ type: "server.request.resolved", requestId: "req_2", resolution: "approved" })
    await server.handleLine(JSON.stringify({ id: second.id, result: { decision: "accept" } }))
    await Bun.sleep(20)
    expect(commands.some((c) => c.type === "request.resolve")).toBe(false)
    expect(out.find((m) => m.method === "serverRequest/resolved" && m.params.requestId === "req_2")).toBeTruthy()
  })

  test("a plan review is left for another client and announced as thread/attention", async () => {
    const { out, commands, call, event } = harness()
    await call(1, "initialize", { clientInfo: { name: "h" } })
    await call(2, "thread/resume", { threadId: "ses_1" })
    event({ type: "server.request", requestId: "req_9", turnId: "trn_1", kind: "approval", title: "Review plan", detail: "", planReview: { plan: "x" } })
    expect(out.find((m) => m.method === "thread/attention")).toMatchObject({ params: { reason: "planReview", requestId: "req_9" } })
    expect(out.some((m) => m.method?.includes("requestApproval"))).toBe(false)
    expect(commands.some((c) => c.type === "request.resolve")).toBe(false)
  })

  test("turn/start options: model, effort and approvalPolicy reach the daemon", async () => {
    const { commands, call } = harness()
    await call(1, "initialize", { clientInfo: { name: "h" } })
    await call(2, "turn/start", { threadId: "ses_1", input: [{ type: "text", text: "go" }, { type: "mention", path: "src/a.ts" }], model: "gpt-x", effort: "high", approvalPolicy: "edits" })
    expect(commands.find((c) => c.type === "session.permission.set")).toMatchObject({ mode: "edits" })
    expect(commands.find((c) => c.type === "user.submit")).toMatchObject({ text: "go\n\n@src/a.ts", selection: { model: { model: "gpt-x", effort: "high" } } })
    expect((await call(3, "turn/start", { threadId: "ses_1", input: [{ type: "text", text: "go" }], model: "nope/none" }))?.error).toMatchObject({ code: -32602 })
    expect((await call(4, "turn/start", { threadId: "ses_1", input: [{ type: "text", text: "go" }], effort: "turbo" }))?.error).toMatchObject({ code: -32602 })
  })

  test("with nothing starting, turn/start answers queued after the wait", async () => {
    const { call } = harness()
    await call(1, "initialize", { clientInfo: { name: "h" } })
    expect((await call(2, "turn/start", { threadId: "ses_1", input: [{ type: "text", text: "go" }] }))?.result).toEqual({ queueId: "que_1", queued: true, turn: null })
  })

  test("an idle thread answers turn/start with the turn once it begins; events during the submit are held after the reply", async () => {
    const { server, out, call, event, gate } = harness()
    await call(1, "initialize", { clientInfo: { name: "h" } })
    let release!: () => void
    gate.hold = new Promise<void>((resolve) => (release = resolve))
    const pending = server.handleLine(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "ses_1", input: [{ type: "text", text: "go" }] } }))
    await Bun.sleep(5)
    // The turn begins, and streams, before the daemon's reply to user.submit has been processed.
    event({ type: "turn.started", turnId: "trn_1", queueId: "que_1" })
    event({ type: "item.started", turnId: "trn_1", itemId: "itm_1", kind: "agent_message" })
    expect(out.some((m) => m.method === "turn/started")).toBe(false)
    release()
    await pending
    const replyAt = out.findIndex((m) => m.id === 2)
    const startedAt = out.findIndex((m) => m.method === "turn/started")
    const itemAt = out.findIndex((m) => m.method === "item/started")
    expect(out[replyAt]).toMatchObject({ result: { queued: false, turn: { id: "trn_1", status: "inProgress" }, queueId: "que_1" } })
    expect(replyAt).toBeLessThan(startedAt)
    expect(startedAt).toBeLessThan(itemAt)
  })
})
