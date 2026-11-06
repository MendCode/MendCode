import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeBuildId } from "@mendcode/build-id"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { DaemonStatusReport, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { openToolCalls, recordLost, takeLost } from "../src/restart-drain"

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
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, buildId: computeBuildId(), engine: (input) => {
      background = (sessionId, tasks) => input.engineBackground(sessionId, tasks, async () => {})
      return createFauxEngine({ clock: input.clock, deltaMs: 1 })
    } })
    const terminal = createClient({ socketPath: daemon.socketPath, name: "owner" })
    await terminal.connect()
    let closed = false
    const stop = async () => { if (closed) return; closed = true; terminal.close(); await daemon.stop() }
    cleanups.push(() => stop().catch(() => undefined))
    return { daemon, terminal, stop }
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
  test("open tool calls are the started ones that did not complete", () => {
    expect(openToolCalls([
      { type: "item.started", itemId: "a", kind: "tool_call", meta: { tool: "shell: bun run test" } },
      { type: "item.started", itemId: "b", kind: "tool_call", meta: { tool: "edit: a.ts" } },
      { type: "item.completed", itemId: "b", status: "ok" },
      { type: "item.started", itemId: "c", kind: "agent_message" },
    ] as never)).toEqual(["shell: bun run test"])
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
  test("with nothing running the wait is over at once", async () => {
    const h = await boot()
    const started = Date.now()
    expect(await h.drain(h.first.terminal, 60_000)).toEqual([])
    expect((await h.status(h.first.terminal)).drain).toMatchObject({ waiting: [], done: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  }, 60_000)

  test("a command in flight is waited for and finishes; the turn ends or is interrupted to resume, and nothing is reported killed", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 1500")).ok).toBe(true)
    const tool = await h.toolStarted(h.first.terminal)
    const waiting = await h.drain(h.first.terminal, 60_000)
    expect(waiting).toEqual([{ sessionId: h.sessionId, title: "worker", items: ["faux"] }])
    const drain = await h.until(async () => { const now = (await h.status(h.first.terminal)).drain; return now?.done ? now : undefined })
    expect(drain.waiting).toEqual([])
    const events = await h.log(h.first.terminal)
    expect(events.find((event) => event.type === "item.completed" && event.itemId === tool.itemId)).toMatchObject({ status: "ok", text: "tool done" })
    // The turn's answer may beat the next look; otherwise the look interrupts it for the next start to carry on.
    await h.until(async () => (await h.log(h.first.terminal)).some((event) => event.type === "turn.completed" || (event.type === "turn.interrupted" && event.cause === "daemon_shutdown")) || undefined)

    await h.first.stop()
    const second = await h.open()
    await Bun.sleep(300)
    // Nothing was killed, so nothing says so.
    expect(JSON.stringify(await h.log(second.terminal))).not.toContain("did not finish")
  }, 60_000)

  test("a background task holds the restart until it ends", async () => {
    const h = await boot()
    h.background(h.sessionId, [{ id: "b1", description: "Watch the build", kind: "local_bash", command: "while sleep 5; do date; done" }])
    const waiting = await h.drain(h.first.terminal, 60_000)
    expect(waiting[0]?.items).toEqual(["background task: while sleep 5; do date; done"])
    await Bun.sleep(400)
    expect((await h.status(h.first.terminal)).drain).toMatchObject({ done: false })
    h.background(h.sessionId, [])
    await h.until(async () => (await h.status(h.first.terminal)).drain?.done || undefined)
  }, 60_000)

  test("when the grace runs out the stop kills what still runs, and the session is told which commands died", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 60000")).ok).toBe(true)
    await h.toolStarted(h.first.terminal)
    h.background(h.sessionId, [{ id: "m1", description: "Monitor", kind: "monitor", command: "Monitor: tail -f build.log" }])
    expect((await h.drain(h.first.terminal, 300))[0]?.items).toEqual(["faux", "background task: Monitor: tail -f build.log"])
    const drain = await h.until(async () => { const now = (await h.status(h.first.terminal)).drain; return now?.done ? now : undefined })
    expect(drain.waiting[0]?.items).toHaveLength(2)

    await h.first.stop()
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
})
