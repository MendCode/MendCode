import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import type { PeerPort } from "@mendcode/tools"
import { startDaemon } from "../src"
import { MAX_WAITING_PER_SESSION, peerMessage, peerReply } from "../src/peers"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-peers-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let portFor: ((sessionId: SessionId) => PeerPort) | undefined
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock, peers }) => ((portFor = peers), createFauxEngine({ clock, deltaMs: 1 })) })
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "peers", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const create = async (directory: string, title: string) => {
    const created = await client.send({ type: "session.create", directory, title })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    return sessionId
  }
  const of = (sessionId: SessionId) => events.filter((event) => event.sessionId === sessionId)
  return { client, create, of, port: (sessionId: SessionId) => portFor!(sessionId) }
}

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const notices = (events: SessionEvent[]) => events.filter((event) => event.type === "queue.added" && event.notice).map((event) => ("text" in event ? event.text : ""))
const completed = (events: SessionEvent[]) => events.filter((event) => event.type === "turn.completed").length

describe("peers", () => {
  test("sessions lists the project's other sessions only", async () => {
    const { create, port } = await boot()
    const a = await create("/work/app", "api")
    const b = await create("/work/app", "ui")
    await create("/work/other", "elsewhere")
    const listed = port(a).list()
    expect(listed.map((session) => session.sessionId)).toEqual([b])
    expect(listed[0]).toMatchObject({ title: "ui", state: "idle" })
  })

  test("sessions stats reports a session of this project (or self) with its turns and time, and refuses one of another project", async () => {
    const { client, create, of, port } = await boot()
    const a = await create("/work/app", "api")
    const b = await create("/work/app", "ui")
    const other = await create("/work/other", "elsewhere")
    await client.send({ type: "user.submit", sessionId: b, text: "hello", attachments: [] })
    await until(() => completed(of(b)) === 1)
    const report = port(a).stats!(b)
    expect(report.ok).toBe(true)
    expect(report.ok && report.output).toContain(`session ${b} "ui"`)
    expect(report.ok && report.output).toContain("turns 1: 1 completed, 0 cancelled, 0 failed, 0 running")
    expect(port(a).stats!("self")).toMatchObject({ ok: true })
    expect(port(a).stats!(other)).toMatchObject({ ok: false })
  })

  test("tell queues the message in the target; its final answer comes back to the sender once, never bounced again", async () => {
    const { create, of, port } = await boot()
    const a = await create("/work/app", "api")
    const b = await create("/work/app", "ui")
    expect(await port(a).tell(b, "which port does the dev server use?")).toEqual({ ok: true, waiting: false })
    await until(() => completed(of(b)) === 1)
    expect(notices(of(b))).toEqual([peerMessage({ from: a, title: "api", text: "which port does the dev server use?" })])
    await until(() => completed(of(a)) === 1)
    const reply = notices(of(a))
    expect(reply).toHaveLength(1)
    expect(reply[0]).toStartWith(`[reply from session ${b} "ui"]\necho: [message from session ${a}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(notices(of(b))).toHaveLength(1)
  })

  test("a busy target reads the message after its turn, and the answer is from that later turn", async () => {
    const { client, create, of, port } = await boot()
    const a = await create("/work/app", "api")
    const b = await create("/work/app", "ui")
    await client.send({ type: "user.submit", sessionId: b, text: "/tool 150", attachments: [] })
    await until(() => of(b).some((event) => event.type === "turn.started"))
    expect(await port(a).tell(b, "ping")).toEqual({ ok: true, waiting: true })
    await until(() => completed(of(a)) === 1)
    expect(completed(of(b))).toBe(2)
    expect(notices(of(a))[0]).toContain("echo: [message from session")
  })

  test("a target turn that is cancelled still answers the sender with how it ended", async () => {
    const { client, create, of, port } = await boot()
    const a = await create("/work/app", "api")
    const b = await create("/work/app", "ui")
    await port(a).tell(b, "status?")
    await until(() => of(b).some((event) => event.type === "turn.started"))
    const running = of(b).find((event) => event.type === "turn.started")!
    await client.send({ type: "turn.cancel", sessionId: b, turnId: (running as any).turnId })
    await until(() => notices(of(a)).length === 1)
    expect(notices(of(a))[0]).toStartWith(`[reply from session ${b} "ui" · its turn cancelled]`)
  })

  test("refusals: itself, another project, unknown ids, empty text, and too many unanswered messages", async () => {
    const { client, create, port } = await boot()
    const a = await create("/work/app", "api")
    const b = await create("/work/app", "ui")
    const other = await create("/work/other", "elsewhere")
    expect(await port(a).tell(a, "hi")).toEqual({ ok: false, message: "that is this session" })
    expect(await port(a).tell(other, "hi")).toEqual({ ok: false, message: "that session belongs to another project" })
    expect(await port(a).tell("ses_nope", "hi")).toMatchObject({ ok: false, message: expect.stringContaining("no session ses_nope") })
    expect(await port(a).tell(b, "  ")).toEqual({ ok: false, message: "the message is empty" })
    await client.send({ type: "user.submit", sessionId: b, text: "/hang", attachments: [] })
    for (let i = 0; i < MAX_WAITING_PER_SESSION; i++) expect(await port(a).tell(b, `q${i}`)).toMatchObject({ ok: true })
    expect(await port(a).tell(b, "one more")).toMatchObject({ ok: false, message: expect.stringContaining("already waiting") })
  })

  test("a retried tell with the same clientRequestId sends once; mode steer on an idle target is an ordinary delivery", async () => {
    const { create, of, port } = await boot()
    const a = await create("/work/app", "api")
    const b = await create("/work/app", "ui")
    const first = await port(a).tell(b, "ping", { mode: "steer", clientRequestId: "r1" })
    expect(first).toEqual({ ok: true, waiting: false })
    expect(await port(a).tell(b, "ping", { mode: "steer", clientRequestId: "r1" })).toEqual(first)
    await until(() => completed(of(b)) === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(notices(of(b))).toEqual([peerMessage({ from: a, title: "api", text: "ping" })])
  })

  test("message and reply texts", () => {
    expect(peerReply({ to: "ses_b" as SessionId, title: "", answer: "  ", ended: "failed" })).toBe(`[reply from session ses_b "untitled" · its turn failed]\n(no answer text)`)
  })
})
