import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import type { Loop, SessionEvent, SessionId } from "@mendcode/protocol"
import { read, write } from "@mendcode/tools"
import { startDaemon } from "../src"

/** Bytes of every column of every row of the session, per table: the metric of real-session-disk.test.ts. */
function sessionBytes(db: Database, sessionId: string) {
  const out: Record<string, { rows: number; bytes: number }> = {}
  let total = 0
  for (const { name } of db.query<{ name: string }, []>("select name from sqlite_master where type='table'").all()) {
    const cols = db.query<{ name: string }, []>(`pragma table_info("${name}")`).all().map((c) => c.name)
    if (!cols.includes("session_id")) continue
    const expr = cols.map((c) => `coalesce(length(cast("${c}" as blob)),0)`).join("+")
    const r = db.query<{ n: number; b: number }, [string]>(`select count(*) n, coalesce(sum(${expr}),0) b from "${name}" where session_id=?`).get(sessionId)!
    if (r.n) { out[name] = { rows: r.n, bytes: r.b }; total += r.b }
  }
  return { tables: out, total }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, name, args } }, { type: "finish", reason: "tool_calls" }]
const checkpoint = (summary = "read the other repo") => stop(`Report.\n\n\`\`\`LOOP_CHECKPOINT\nstatus: continue\nsummary: ${summary}\n\`\`\``)

/** A daemon over the native engine with a scripted model; whatever the script runs out of (a creator answering a notice) is answered "noted". */
async function boot(plan: (paths: { project: string; outside: string }) => ModelEvent[][]) {
  const dir = tempDir("mendd-lsmart-")
  const project = tempDir("mendd-lsmart-proj-")
  const outside = tempDir("mendd-lsmart-out-")
  writeFileSync(path.join(outside, "notes.txt"), "outside notes\n")
  const script = [...plan({ project, outside })]
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      yield* script.shift() ?? stop("noted")
    },
  }
  const events: SessionEvent[] = []
  const loopChanges: Loop[] = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    engine: ({ store, loops, loopRun, grants, runLimits }) =>
      createNativeEngine({
        provider,
        tools: [read, write],
        grants,
        loops,
        loopRun,
        runLimits: (sessionId) => runLimits.get(sessionId),
        history: {
          load: async (sessionId) => {
            const messages = store.engineMessages.load(sessionId, "native") as ModelMessage[]
            return messages.length ? messages : undefined
          },
          save: async (sessionId, messages) => store.engineMessages.save(sessionId, "native", messages),
          replace: async (sessionId, messages) => store.engineMessages.replace(sessionId, "native", messages),
        },
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || project,
        system: () => "BASE",
        compactionPrompt: "SUMMARIZE",
      }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "lsmart", onEvent: (event) => void events.push(event), onGlobal: (event) => void (event.type === "loop.changed" && loopChanges.push(event.loop)) })
  await client.connect()
  cleanups.push(() => client.close())
  const mode = async (mode: "ask" | "edits" | "full" | "plan") => {
    const created = await client.send({ type: "session.create", directory: project })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    if (mode !== "ask") await client.send({ type: "session.permission.set", sessionId, mode })
    return sessionId
  }
  const create = async (creator: SessionId | undefined, extra: Record<string, unknown> = {}) => {
    const reply = await client.send({ type: "loop.create", name: "watch", directory: project, objective: "read the other repo and report", trigger: { kind: "manual" }, budget: { mode: "monitor" }, ...(creator ? { creatorSessionId: creator } : {}), ...extra } as never)
    if (!reply.ok) throw new Error(JSON.stringify(reply))
    return (reply.result?.loop) as Loop
  }
  const state = (loopId: string) => loopChanges.filter((loop) => loop.loopId === loopId).at(-1)
  const notices = (sessionId: SessionId) => daemon.store.readAfter(sessionId, 0, 500).flatMap((event) => (event.type === "session.orchestration" && event.groupId.startsWith("loop:") ? [event.text] : []))
  return { dir, project, outside, daemon, client, events, requests, mode, create, state, notices, script }
}
type Harness = Awaited<ReturnType<typeof boot>>

const loopEvents = (h: Harness, loop: Loop) => h.daemon.store.readAfter(loop.sessionId, 0, 500)
const asked = (h: Harness, loop: Loop) => loopEvents(h, loop).filter((event) => event.type === "server.request")
const readDone = (h: Harness, loop: Loop) => loopEvents(h, loop).find((event) => event.type === "item.completed" && event.text?.includes("outside notes"))
const ended = (h: Harness, loop: Loop) => h.state(loop.loopId)?.history[0]?.outcome !== undefined
const run = async (h: Harness, loop: Loop) => {
  const reply = await h.client.send({ type: "loop.control", loopId: loop.loopId, action: "run" })
  if (!reply.ok) throw new Error(JSON.stringify(reply))
}

describe("a loop created from a session in full access", () => {
  test("a report-only loop reads outside the project without asking, and cannot write anywhere", async () => {
    const h = await boot(({ outside, project }) => [callTool("read", { path: path.join(outside, "notes.txt") }), callTool("write", { path: path.join(outside, "hack.txt"), content: "no" }), callTool("write", { path: path.join(project, "hack.txt"), content: "no" }), checkpoint(), stop("noted")])
    const creator = await h.mode("full")
    const loop = await h.create(creator, { reportOnly: true })
    expect(loop).toMatchObject({ creatorSessionId: creator, notify: "creator", reportOnly: true })
    await run(h, loop)
    await until(() => ended(h, loop))
    expect(asked(h, loop)).toHaveLength(0)
    expect(readDone(h, loop)).toBeDefined()
    const refused = loopEvents(h, loop).filter((event) => event.type === "item.completed" && event.status === "error")
    expect(refused).toHaveLength(2)
    expect(refused.every((event) => event.type === "item.completed" && event.text?.includes("plan mode is read-only"))).toBe(true)
    expect(existsSync(path.join(h.outside, "hack.txt"))).toBe(false)
    expect(existsSync(path.join(h.project, "hack.txt"))).toBe(false)
    expect(h.state(loop.loopId)).toMatchObject({ state: "active", history: [{ outcome: "completed", checkpoint: { status: "continue" } }] })
  })

  test("a normal loop starts in full access too, so nothing asks", async () => {
    const h = await boot(({ outside }) => [callTool("write", { path: path.join(outside, "made.txt"), content: "ok" }), checkpoint("wrote it"), stop("noted")])
    const creator = await h.mode("full")
    const loop = await h.create(creator)
    expect(loop.permission).toBe("full")
    expect(h.daemon.store.permissionModeOf(loop.sessionId)).toBe("full")
    await run(h, loop)
    await until(() => ended(h, loop))
    expect(asked(h, loop)).toHaveLength(0)
    expect(existsSync(path.join(h.outside, "made.txt"))).toBe(true)
  })
})

describe("a loop created from a session that asks", () => {
  test("a report-only loop that reads outside waits visibly, and /loops resolves it with the session's request", async () => {
    const h = await boot(({ outside }) => [callTool("read", { path: path.join(outside, "notes.txt") }), checkpoint(), stop("noted")])
    const creator = await h.mode("ask")
    const loop = await h.create(creator, { reportOnly: true })
    await run(h, loop)
    await until(() => h.state(loop.loopId)?.state === "needs_input")
    const waiting = h.state(loop.loopId)!.waiting!
    expect(waiting).toMatchObject({ sessionId: loop.sessionId, kind: "approval", title: "external directory access", tool: "read" })
    expect(waiting.detail).toContain(h.outside)
    const reply = await h.client.send({ type: "request.resolve", sessionId: waiting.sessionId as SessionId, requestId: waiting.requestId as never, decision: { kind: "approve", scope: "once" } })
    expect(reply.ok).toBe(true)
    await until(() => ended(h, loop))
    expect(readDone(h, loop)).toBeDefined()
    expect(h.state(loop.loopId)!.waiting).toBeUndefined()
  })

  test("a refusal from /loops lets the run finish without the read", async () => {
    const h = await boot(({ outside }) => [callTool("read", { path: path.join(outside, "notes.txt") }), checkpoint("could not read it"), stop("noted")])
    const creator = await h.mode("ask")
    const loop = await h.create(creator, { reportOnly: true })
    await run(h, loop)
    await until(() => h.state(loop.loopId)?.state === "needs_input")
    const waiting = h.state(loop.loopId)!.waiting!
    await h.client.send({ type: "request.resolve", sessionId: waiting.sessionId as SessionId, requestId: waiting.requestId as never, decision: { kind: "deny" } })
    await until(() => ended(h, loop))
    expect(readDone(h, loop)).toBeUndefined()
  })

  test("what the creator could already read is inherited without asking: its added directories and the paths declared with the loop", async () => {
    const h = await boot(({ outside }) => [callTool("read", { path: path.join(outside, "notes.txt") }), checkpoint(), stop("noted")])
    const creator = await h.mode("ask")
    expect((await h.client.send({ type: "session.run.configure", sessionId: creator, addDirs: [h.outside] })).ok).toBe(true)
    const loop = await h.create(creator, { reportOnly: true })
    await run(h, loop)
    await until(() => ended(h, loop))
    expect(asked(h, loop)).toHaveLength(0)
    expect(readDone(h, loop)).toBeDefined()

    const declared = await boot(({ outside }) => [callTool("read", { path: path.join(outside, "notes.txt") }), checkpoint(), stop("noted")])
    const other = await declared.mode("ask")
    const second = await declared.create(other, { reportOnly: true, reads: [declared.outside] })
    expect(second.reads).toEqual([declared.outside])
    await run(declared, second)
    await until(() => ended(declared, second))
    expect(asked(declared, second)).toHaveLength(0)
    expect(readDone(declared, second)).toBeDefined()
  })

  test("a write is never inherited: a loop that writes where its creator could read still asks", async () => {
    const h = await boot(({ outside }) => [callTool("write", { path: path.join(outside, "made.txt"), content: "ok" }), checkpoint(), stop("noted")])
    const creator = await h.mode("ask")
    await h.client.send({ type: "session.run.configure", sessionId: creator, addDirs: [h.outside] })
    const loop = await h.create(creator, { reportOnly: false, reads: [h.outside] })
    expect(loop.permission).toBe("ask")
    await run(h, loop)
    await until(() => h.state(loop.loopId)?.state === "needs_input")
    expect(h.state(loop.loopId)!.waiting).toMatchObject({ kind: "approval", tool: "write" })
    expect(existsSync(path.join(h.outside, "made.txt"))).toBe(false)
  })
})

describe("the permission mode a loop inherits", () => {
  test.each([["full", "full"], ["edits", "edits"], ["ask", "ask"]] as const)("a creator in %s makes a %s loop", async (creatorMode, expected) => {
    const h = await boot(() => [])
    const creator = await h.mode(creatorMode)
    const loop = await h.create(creator)
    expect(loop.permission).toBe(expected)
  })

  test("the user can lower it at creation or in /loops, and a loop never has more than its creator", async () => {
    const h = await boot(() => [])
    const full = await h.mode("full")
    expect((await h.create(full, { permission: "ask" })).permission).toBe("ask")
    const asking = await h.mode("ask")
    expect((await h.create(asking, { permission: "full" })).permission).toBe("ask")
    const loop = await h.create(full)
    expect(loop.permission).toBe("full")
    const lowered = await h.client.send({ type: "loop.update", loopId: loop.loopId, permission: "edits" })
    expect(lowered).toMatchObject({ ok: true, result: { loop: { permission: "edits" } } })
    expect(h.daemon.store.permissionModeOf(loop.sessionId)).toBe("edits")
    const raised = await h.client.send({ type: "loop.update", loopId: loop.loopId, permission: "full" })
    expect(raised).toMatchObject({ ok: true, result: { loop: { permission: "full" } } })
    const capped = await h.create(asking)
    const tried = await h.client.send({ type: "loop.update", loopId: capped.loopId, permission: "full" })
    expect(tried).toMatchObject({ ok: true, result: { loop: { permission: "ask" } } })
  })

  test("a loop made without a creator keeps the user's default", async () => {
    const h = await boot(() => [])
    const loop = await h.create(undefined)
    expect(loop.permission).toBeUndefined()
    expect(loop.creatorSessionId).toBeUndefined()
  })
})

describe("report-only runs have no plan mode (AJ)", () => {
  test("the run is offered no plan tools and no plan mode note; a plan-mode session still is", async () => {
    const h = await boot(() => [checkpoint(), stop("noted"), stop("planned")])
    const creator = await h.mode("full")
    const loop = await h.create(creator, { reportOnly: true })
    await run(h, loop)
    await until(() => ended(h, loop))
    const request = h.requests[0]!
    const names = request.tools.map((tool) => tool.name)
    expect(names).toContain("read")
    for (const plan of ["plan_review", "plan_exit", "plan_submit"]) expect(names).not.toContain(plan)
    expect(request.system).toContain("Report-only: write the report as your answer")
    expect(request.system).not.toContain("Plan mode is on")
    // A session in plan mode keeps its tools and its note.
    const planning = await h.mode("plan")
    await h.client.send({ type: "user.submit", sessionId: planning, text: "plan something", attachments: [] })
    await until(() => h.requests.some((entry) => entry.system.includes("Plan mode is on")))
    const planned = h.requests.find((entry) => entry.system.includes("Plan mode is on"))!
    expect(planned.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["plan_review", "plan_exit"]))
  })

  test("a plain-text report is not turned into a plan review", async () => {
    const report = `# Findings\n\n## Goal\nsummarize\n\n## Steps\n1. read a\n2. read b\n3. compare\n\n## Risks\nnone\n\n## Verify\nrun it\n\n\`\`\`LOOP_CHECKPOINT\nstatus: continue\nsummary: wrote findings\n\`\`\``
    const h = await boot(() => [stop(report), stop("noted")])
    const creator = await h.mode("full")
    const loop = await h.create(creator, { reportOnly: true })
    await run(h, loop)
    await until(() => ended(h, loop))
    expect(h.state(loop.loopId)).toMatchObject({ state: "active", history: [{ outcome: "completed", checkpoint: { summary: "wrote findings" } }] })
    expect(loopEvents(h, loop).some((event) => event.type === "server.request")).toBe(false)
  })
})

describe("a notice in the creator session per run (AK)", () => {
  test("every run leaves one short, durable notice in the creator session with the link to the loop session", async () => {
    const h = await boot(() => [checkpoint("first look"), checkpoint("second look"), stop("the user's next answer")])
    const creator = await h.mode("full")
    const loop = await h.create(creator, { reportOnly: true })
    expect(h.notices(creator)).toHaveLength(0)
    await run(h, loop)
    await until(() => h.notices(creator).length === 1)
    const [first] = h.notices(creator)
    expect(first).toContain('[loop "watch" · run 1 continue]')
    expect(first).toContain("first look")
    expect(first).toContain(`session ${loop.sessionId}`)
    expect(first).toContain(`/loop open ${loop.loopId}`)
    expect(first!.includes("\n")).toBe(false)
    await run(h, loop)
    await until(() => h.notices(creator).length === 1 && h.notices(creator)[0]!.includes("run 2 continue"))
    // Unread, the second run replaced the first: one card, "2 runs", the first run's row is gone from the log.
    expect(h.notices(creator)[0]).toContain("2 runs")
    expect(h.notices(creator)[0]).not.toContain("first look")
    // No model turn in the creator session: the only model calls were the two runs of the loop.
    expect(h.requests).toHaveLength(2)
    expect(h.daemon.store.turns.list(creator).every((turn) => turn.notice === true || turn.status !== "running")).toBe(true)
    // The model reads the notices with the user's next message.
    await h.client.send({ type: "user.submit", sessionId: creator, text: "what did the loop find?", attachments: [] })
    await until(() => h.requests.length === 3)
    const seen = JSON.stringify(h.requests[2]!.messages)
    expect(seen).toContain("[loops since your last message]")
    expect(seen).toContain("run 2 continue")
    expect(seen).toContain("second look")
    expect(seen).toContain("(+1 earlier runs)")
    expect(seen.match(/\[loop /g)).toHaveLength(1)
    // Read once: the message after that carries no loop line.
    await h.client.send({ type: "user.submit", sessionId: creator, text: "thanks", attachments: [] })
    await until(() => h.requests.length === 4)
    expect(JSON.stringify(h.requests[3]!.messages).match(/\[loops since/g)).toHaveLength(1)
    // Once read, the next run leaves a new card.
    await run(h, loop)
    await until(() => h.notices(creator).length === 2)
  })

  test("notify none leaves nothing in the creator session", async () => {
    const h = await boot(() => [checkpoint("quiet")])
    const creator = await h.mode("full")
    const loop = await h.create(creator, { reportOnly: true, notify: "none" })
    expect(loop.notify).toBe("none")
    await run(h, loop)
    await until(() => ended(h, loop))
    await new Promise((r) => setTimeout(r, 100))
    expect(h.notices(creator)).toHaveLength(0)
  })

  test("a notice is one event row under 300 bytes, a replaced one costs nothing more, and a session without loops stores nothing extra", async () => {
    const h = await boot(() => [checkpoint("one run"), checkpoint("two runs")])
    const creator = await h.mode("full")
    const bare = await h.mode("full")
    const loop = await h.create(creator, { reportOnly: true })
    const db = new Database(path.join(h.dir, "mendd.db"), { readonly: true })
    const before = sessionBytes(db, creator).total
    const bareBefore = sessionBytes(db, bare).total
    await run(h, loop)
    await until(() => h.notices(creator).length === 1)
    await new Promise((r) => setTimeout(r, 200))
    const notice = sessionBytes(db, creator)
    if (process.env.MEND_DISK_REPORT) console.log(`creator session: +${notice.total - before} bytes for one run (the notice only); tables`, JSON.stringify(notice.tables))
    expect(h.requests).toHaveLength(1)
    // One event row and nothing else: no turn row, no queue rows, no foreground or usage rows.
    expect(notice.tables.turns?.rows ?? 0).toBe(0)
    expect(notice.total - before).toBeGreaterThan(0)
    expect(notice.total - before).toBeLessThan(300)
    // The next run replaces the unread notice: the row count and the size stay.
    await run(h, loop)
    await until(() => h.notices(creator)[0]?.includes("run 2") === true)
    await new Promise((r) => setTimeout(r, 200))
    const replaced = sessionBytes(db, creator)
    if (process.env.MEND_DISK_REPORT) console.log(`creator session: replaced notice changes the session by ${replaced.total - notice.total} bytes; events`, JSON.stringify(replaced.tables.events))
    expect(replaced.tables.events?.rows).toBe(notice.tables.events?.rows)
    expect(replaced.total - notice.total).toBeLessThan(40)
    expect(h.requests).toHaveLength(2)
    expect(sessionBytes(db, bare).total).toBe(bareBefore)
    db.close()
  })
})

