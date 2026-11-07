import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeBuildId } from "@mendcode/build-id"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { DaemonStatusReport, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createRestartDrain, openToolCalls, recordHeld, recordLost, takeHeld, takeLost, turnWork } from "../src/restart-drain"
import { boot as bootNative, callTool, openSession, stop, until } from "./native-harness"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
type Seen = { type: string; itemId?: string; kind?: string; status?: string; cause?: string; text?: string; meta?: Record<string, unknown> }
type Background = (sessionId: SessionId, tasks: Array<{ id: string; description: string; kind: string; command?: string }>) => void

async function boot() {
  const dir = temp("mcev-p-drain-")
  const project = temp("mcev-p-drain-project-")
  let background: Background = () => {}
  const open = async () => {
    // The faux engine runs the turns; the background tasks a Claude Code process reports are played by the test.
    let shutdowns = 0
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, buildId: computeBuildId(), onShutdown: () => { shutdowns++ }, engine: (input) => {
      background = (sessionId, tasks) => input.engineBackground(sessionId, tasks, async () => {})
      return createFauxEngine({ clock: input.clock, deltaMs: 1 })
    } })
    const terminal = createClient({ socketPath: daemon.socketPath, name: "owner" })
    await terminal.connect()
    let closed = false
    const stop = async () => { if (closed) return; closed = true; terminal.close(); await daemon.stop() }
    cleanups.push(() => stop().catch(() => undefined))
    /** A client like `daemon restart`'s: no reconnect, so closing it is the command going away. */
    const control = async () => {
      const client = createClient({ socketPath: daemon.socketPath, name: "daemon-control", reconnect: false, timeoutMs: 2000 })
      await client.connect()
      cleanups.push(() => client.close())
      return client
    }
    return { daemon, terminal, stop, control, shutdowns: () => shutdowns }
  }
  const first = await open()
  const created = await first.terminal.send({ type: "session.create", directory: project, title: "worker" })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  const log = async (client: typeof first.terminal) => {
    const reply = await client.send({ type: "session.events", sessionId, after: 0 })
    return reply.ok ? (reply.result!.events as Seen[]) : []
  }
  const until = async <T>(find: () => T | undefined | Promise<T | undefined>, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      const found = await find()
      if (found) return found
      await Bun.sleep(25)
    }
    throw new Error("timed out waiting in the test")
  }
  const status = async (client: typeof first.terminal) => {
    const reply = await client.send({ type: "daemon.status" })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result as unknown as DaemonStatusReport
  }
  const drain = async (client: typeof first.terminal, drainMs: number) => {
    const reply = await client.send({ type: "daemon.shutdown", force: true, drainMs })
    if (!reply.ok) throw new Error(reply.error.message)
    return (reply.result as { waiting: NonNullable<DaemonStatusReport["drain"]>["waiting"] }).waiting
  }
  const submit = (client: typeof first.terminal, text: string) => client.send({ type: "user.submit", sessionId, text, attachments: [] })
  const toolStarted = (client: typeof first.terminal) => until(async () => (await log(client)).find((event) => event.type === "item.started" && event.kind === "tool_call"))
  return { first, open, sessionId, log, until, status, drain, submit, toolStarted, background: (...args: Parameters<Background>) => background(...args) }
}

describe("the work a restart would kill", () => {
  test("an explicit pause during the drain takes ownership, including when the requester leaves", async () => {
    const sessionId = "ses_mine" as SessionId
    const holds: boolean[] = []
    const gone = new AbortController()
    const drain = createRestartDrain({
      sessions: () => [sessionId], running: () => ["shell"], title: () => "mine", paused: () => false,
      hold: async (_id, on) => { holds.push(on) }, stop: () => { throw new Error("unexpected stop") },
      now: () => 0, log: () => {},
    })
    try {
      await drain.begin(60_000, { gone: gone.signal })
      expect(drain.held()).toEqual([sessionId])
      drain.userPaused(sessionId)
      expect(drain.held()).toEqual([])
      gone.abort()
      expect(holds).toEqual([true])
      expect(drain.status()).toBeUndefined()
    } finally { drain.dispose() }
  })

  test("open tool calls are the started ones that did not complete", () => {
    expect(openToolCalls([
      { type: "item.started", itemId: "a", kind: "tool_call", meta: { tool: "shell: bun run test" } },
      { type: "item.started", itemId: "b", kind: "tool_call", meta: { tool: "edit: a.ts" } },
      { type: "item.completed", itemId: "b", status: "ok" },
      { type: "item.started", itemId: "c", kind: "agent_message" },
    ] as never)).toEqual(["shell: bun run test"])
  })

  test("a tool call whose approval card waits for the user is asking, not running; a resolved one runs again", () => {
    const events = [
      { type: "item.started", itemId: "a", kind: "tool_call", meta: { tool: "workflow_script: mend-quality" } },
      { type: "server.request", requestId: "r1", itemId: "a", kind: "approval", title: "Run workflow" },
      { type: "item.started", itemId: "b", kind: "tool_call", meta: { tool: "shell: bun run test" } },
      // Claude Code names no item: its request is matched by the call's title.
      { type: "item.started", itemId: "c", kind: "tool_call", meta: { tool: "Bash: rm -rf dist" } },
      { type: "server.request", requestId: "r2", kind: "approval", title: "Bash: rm -rf dist" },
      // A child session's mirrored approval is that session's wait, not this one's.
      { type: "server.request", requestId: "r3", kind: "approval", title: "child edit", async: true },
    ]
    expect(turnWork(events as never)).toEqual({ running: ["shell: bun run test"], asking: ["workflow_script: mend-quality", "Bash: rm -rf dist"] })
    expect(openToolCalls([...events, { type: "server.request.resolved", requestId: "r1", resolution: "approved" }] as never)).toEqual(["workflow_script: mend-quality", "shell: bun run test"])
  })

  test("the sessions a restart's wait held are kept across meta's 500-character values and read back once", () => {
    const values = new Map<string, string>()
    const meta = { get: (key: string) => values.get(key), set: (key: string, value: string) => void values.set(key, value.slice(0, 500)) }
    const ids = Array.from({ length: 60 }, (_, i) => `ses_01M6S2GPTAZCY${String(i).padStart(3, "0")}`)
    recordHeld(meta, ids)
    expect(takeHeld(meta)).toEqual(ids)
    expect(takeHeld(meta)).toEqual([])
  })

  test("what a stop killed is kept within meta's 500 characters and read back once", () => {
    const values = new Map<string, string>()
    const meta = { get: (key: string) => values.get(key), set: (key: string, value: string) => void values.set(key, value.slice(0, 500)) }
    recordLost(meta, [{ sessionId: "ses_a", title: "a", items: ["shell: bun run test", ...Array.from({ length: 7 }, (_, i) => `background task: ${"x".repeat(200)} ${i}`)] }, { sessionId: "ses_b", title: "b", items: ["background task: tail -f log"] }])
    const lost = takeLost(meta)
    expect(lost.get("ses_a")?.[0]).toBe("shell: bun run test")
    expect(lost.get("ses_b")).toEqual(["background task: tail -f log"])
    expect(takeLost(meta).size).toBe(0)
  })
})

describe.skipIf(process.platform === "win32")("a forced restart waits for running work", () => {
  const stoppedItself = (h: Awaited<ReturnType<typeof boot>>) => h.until(() => (h.first.shutdowns() > 0 && !existsSync(h.first.daemon.socketPath)) || undefined)

  test("with nothing running the daemon stops at once, by itself", async () => {
    const h = await boot()
    const control = await h.first.control()
    const started = Date.now()
    expect(await h.drain(control, 60_000)).toEqual([])
    await stoppedItself(h)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 60_000)

  test("a command in flight is waited for and finishes, then the daemon really stops; the turn is cut only by that stop, and nothing is reported killed", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 1500")).ok).toBe(true)
    const tool = await h.toolStarted(h.first.terminal)
    const control = await h.first.control()
    expect(await h.drain(control, 60_000)).toEqual([{ sessionId: h.sessionId, title: "worker", items: ["faux"] }])
    await Bun.sleep(400)
    // Waiting cuts nothing: the turn is still open and the daemon still runs.
    expect(h.first.shutdowns()).toBe(0)
    expect((await h.log(h.first.terminal)).some((event) => event.type === "turn.interrupted")).toBe(false)
    await stoppedItself(h)

    const second = await h.open()
    const events = await h.log(second.terminal)
    expect(events.find((event) => event.type === "item.completed" && event.itemId === tool.itemId)).toMatchObject({ status: "ok", text: "tool done" })
    await Bun.sleep(300)
    expect(JSON.stringify(await h.log(second.terminal))).not.toContain("did not finish")
  }, 60_000)

  test("a background task holds the restart until it ends", async () => {
    const h = await boot()
    h.background(h.sessionId, [{ id: "b1", description: "Watch the build", kind: "local_bash", command: "while sleep 5; do date; done" }])
    const control = await h.first.control()
    expect((await h.drain(control, 60_000))[0]?.items).toEqual(["background task: while sleep 5; do date; done"])
    await Bun.sleep(400)
    expect((await h.status(control)).drain).toMatchObject({ done: false })
    h.background(h.sessionId, [])
    await stoppedItself(h)
  }, 60_000)

  test("a restart command that goes away mid-wait lets it go: the sessions are unpaused, no turn is interrupted and the daemon keeps running", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 1500")).ok).toBe(true)
    await h.toolStarted(h.first.terminal)
    // A second session the user paused stays paused; the drain releases only what it paused.
    const other = await h.first.terminal.send({ type: "session.create", directory: h.first.daemon.store.sessionDirectory(h.sessionId)!, title: "mine" })
    const mine = other.ok ? other.result!.sessionId as SessionId : h.sessionId
    expect((await h.first.terminal.send({ type: "session.control", sessionId: mine, action: "pause" })).ok).toBe(true)
    const control = await h.first.control()
    await h.drain(control, 60_000)
    const paused = async (sessionId: SessionId) => { const reply = await h.first.terminal.send({ type: "queue.list", sessionId }); return reply.ok ? (reply.result as { paused: boolean }).paused : undefined }
    expect(await paused(h.sessionId)).toBe(true)
    control.close()
    await h.until(async () => (await h.status(h.first.terminal)).drain === undefined || undefined)
    expect(await paused(h.sessionId)).toBe(false)
    expect(await paused(mine)).toBe(true)
    await h.until(async () => (await h.log(h.first.terminal)).some((event) => event.type === "turn.completed") || undefined)
    expect((await h.log(h.first.terminal)).some((event) => event.type === "turn.interrupted")).toBe(false)
    expect(h.first.shutdowns()).toBe(0)
    // The session takes new work again.
    expect((await h.submit(h.first.terminal, "hello")).ok).toBe(true)
    await h.until(async () => (await h.log(h.first.terminal)).filter((event) => event.type === "turn.completed").length >= 2 || undefined)
  }, 60_000)

  test("when the grace runs out the daemon stops and kills what still runs, and the session is told which commands died", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 60000")).ok).toBe(true)
    await h.toolStarted(h.first.terminal)
    h.background(h.sessionId, [{ id: "m1", description: "Monitor", kind: "monitor", command: "Monitor: tail -f build.log" }])
    const control = await h.first.control()
    expect((await h.drain(control, 300))[0]?.items).toEqual(["faux", "background task: Monitor: tail -f build.log"])
    await stoppedItself(h)

    const second = await h.open()
    const after = await h.until(async () => { const seen = await h.log(second.terminal); return JSON.stringify(seen).includes("did not finish") ? seen : undefined })
    const told = JSON.stringify(after)
    expect(told).toContain("`faux`")
    expect(told).toContain("`background task: Monitor: tail -f build.log`")
    expect(after.some((event) => event.type === "item.started" && event.meta?.restart === "resume")).toBe(true)
  }, 60_000)

  test("an idle session whose background task a plain forced stop kills is told after the start", async () => {
    const h = await boot()
    h.background(h.sessionId, [{ id: "b2", description: "Dev server", kind: "local_bash", command: "bun run dev" }])
    await h.first.stop()
    const second = await h.open()
    await h.until(async () => JSON.stringify(await h.log(second.terminal)).includes("`background task: bun run dev`") || undefined)
  }, 60_000)

  test("after the restart every queue the wait held goes on in order; a queue the user paused stays held", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 600")).ok).toBe(true)
    await h.toolStarted(h.first.terminal)
    const other = await h.first.terminal.send({ type: "session.create", directory: h.first.daemon.store.sessionDirectory(h.sessionId)!, title: "mine" })
    const mine = other.ok ? other.result!.sessionId as SessionId : h.sessionId
    expect((await h.first.terminal.send({ type: "session.control", sessionId: mine, action: "pause" })).ok).toBe(true)
    expect((await h.first.terminal.send({ type: "user.submit", sessionId: mine, text: "mine waits", attachments: [] })).ok).toBe(true)
    const control = await h.first.control()
    await h.drain(control, 60_000)
    // Sent during the wait: they queue behind the hold, in this order.
    expect((await h.submit(h.first.terminal, "first after")).ok).toBe(true)
    expect((await h.submit(h.first.terminal, "second after")).ok).toBe(true)
    await stoppedItself(h)

    const second = await h.open()
    const answered = await h.until(async () => {
      const replies = (await h.log(second.terminal)).filter((event) => event.type === "item.completed" && event.text?.startsWith("echo:")).map((event) => event.text)
      return replies.some((text) => text?.includes("second after")) ? replies : undefined
    })
    expect(answered.join("\n")).toMatch(/first after[\s\S]*second after/)
    const queue = await second.terminal.send({ type: "queue.list", sessionId: mine })
    expect(queue.ok && queue.result).toMatchObject({ held: true, entries: [{ text: "mine waits" }] })
  }, 60_000)

  test("with automatic resumption off, drain-held messages stay held and drain metadata is consumed", async () => {
    const h = await boot()
    expect((await h.first.terminal.send({ type: "settings.set", patch: { resumeAfterRestart: false } })).ok).toBe(true)
    h.background(h.sessionId, [{ id: "hold", description: "wait", kind: "local_bash", command: "sleep 60" }])
    const control = await h.first.control()
    await h.drain(control, 60_000)
    expect((await h.submit(h.first.terminal, "must wait")).ok).toBe(true)
    h.background(h.sessionId, [])
    await stoppedItself(h)
    const second = await h.open()
    await h.until(() => !second.daemon.store.meta.get("restart.held") || undefined)
    const queue = await second.terminal.send({ type: "queue.list", sessionId: h.sessionId })
    expect(queue.ok && queue.result).toMatchObject({ held: true, entries: [{ text: "must wait" }] })
    expect((await h.log(second.terminal)).some((event) => event.type === "turn.started")).toBe(false)
    expect((await second.terminal.send({ type: "session.control", sessionId: h.sessionId, action: "resume" })).ok).toBe(true)
    await h.until(async () => (await h.log(second.terminal)).some((event) => event.type === "turn.completed") || undefined)
  }, 60_000)

  test("a user pause issued after the drain acquired the session survives restart", async () => {
    const h = await boot()
    h.background(h.sessionId, [{ id: "hold", description: "wait", kind: "local_bash", command: "sleep 60" }])
    const control = await h.first.control()
    await h.drain(control, 60_000)
    expect((await h.first.terminal.send({ type: "session.control", sessionId: h.sessionId, action: "pause" })).ok).toBe(true)
    expect((await h.submit(h.first.terminal, "user paused")).ok).toBe(true)
    h.background(h.sessionId, [])
    await stoppedItself(h)
    const second = await h.open()
    // A later automatic release pass must not claim this queue, even on a subsequent restart.
    await Bun.sleep(100)
    expect(second.daemon.store.meta.get("restart.held")).toBeFalsy()
    const queue = await second.terminal.send({ type: "queue.list", sessionId: h.sessionId })
    expect(queue.ok && queue.result).toMatchObject({ held: true, entries: [{ text: "user paused" }] })
    expect((await h.log(second.terminal)).some((event) => event.type === "turn.started")).toBe(false)
  }, 60_000)

  test("a session waiting on an approval card does not extend the wait; it is named as waiting for you and its turn resumes after the restart", async () => {
    const h = await bootNative({ shell: true, steps: [callTool("shell", { command: "echo approved" }), stop("resumed")] })
    cleanups.push(() => h.cleanup())
    const sessionId = await openSession(h, "ask")
    expect((await h.client.send({ type: "user.submit", sessionId, text: "run it", attachments: [] })).ok).toBe(true)
    await until(() => h.events.some((event) => event.type === "server.request"))
    const started = Date.now()
    const reply = await h.client.send({ type: "daemon.shutdown", force: true, drainMs: 30_000 })
    expect(reply.ok && reply.result).toMatchObject({ waiting: [], asking: [{ sessionId, items: [expect.stringContaining("echo approved")] }] })
    await until(() => !existsSync(h.daemon.socketPath), 15_000)
    expect(Date.now() - started).toBeLessThan(5_000)
    await Bun.sleep(300)

    // The next start resumes the turn; the model calls the tool again and the card comes back. Nothing is told as killed.
    const next = await bootNative({ shell: true, dir: h.dir, project: h.project, steps: [callTool("shell", { command: "echo approved" }), stop("done")] })
    cleanups.push(() => next.cleanup())
    await next.client.subscribe(sessionId, 0)
    await until(() => next.events.filter((event) => event.type === "server.request").length >= 2, 15_000)
    expect(next.events.some((event) => event.type === "turn.interrupted")).toBe(true)
    expect(next.events.some((event) => event.type === "item.started" && event.meta?.restart === "resume")).toBe(true)
    expect(JSON.stringify(next.events)).not.toContain("did not finish")
  }, 60_000)

  test("the native engine's foreground shell command, streaming output, is waited for", async () => {
    const h = await bootNative({ shell: true, steps: [callTool("shell", { command: "for i in 1 2 3 4 5 6; do echo line $i; sleep 0.25; done" }), stop("done")] })
    cleanups.push(() => h.cleanup())
    const sessionId = await openSession(h)
    expect((await h.client.send({ type: "user.submit", sessionId, text: "render", attachments: [] })).ok).toBe(true)
    await until(() => h.events.some((event) => event.type === "item.delta" && event.text.includes("line")))
    const reply = await h.client.send({ type: "daemon.shutdown", force: true, drainMs: 30_000 })
    expect(reply.ok && (reply.result as { waiting: Array<{ items: string[] }> }).waiting[0]?.items[0]).toStartWith("shell: for i in")
    await until(() => !existsSync(h.daemon.socketPath), 15_000)
    const shell = h.events.find((event) => event.type === "item.started" && event.kind === "tool_call")!
    expect(h.events.find((event) => event.type === "item.completed" && event.itemId === (shell as { itemId: string }).itemId)).toMatchObject({ status: "ok" })
  }, 60_000)
})
