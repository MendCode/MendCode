import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import type { BackgroundPort } from "@mendcode/tools"
import { startDaemon } from "../src"
import { backgroundNotice, isBackgroundNotice, watchNotice } from "../src/background-notice"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-bg-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let portFor: ((sessionId: SessionId) => BackgroundPort) | undefined
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    engine: ({ clock, background }) => ((portFor = background), createFauxEngine({ clock, deltaMs: 1 })),
  })
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "bg", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const created = await client.send({ type: "session.create", directory: dir })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  return { dir, client, sessionId, events, port: () => portFor!(sessionId) }
}

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("background task notices", () => {
  test("a task that ends on its own wakes its idle session with a notice turn carrying the end of its output", async () => {
    const { dir, events, port } = await boot()
    const started = port().start({ command: "echo built ok; exit 0", cwd: dir })
    expect(started.ok).toBe(true)
    await until(() => events.some((e) => e.type === "turn.completed"))
    const queued = events.find((e) => e.type === "queue.added")
    expect(queued).toMatchObject({ notice: true })
    expect(queued && "text" in queued ? queued.text : "").toContain("built ok")
    expect(events.find((e) => e.type === "item.started" && e.kind === "user_message")).toMatchObject({ meta: { notice: true } })
  })

  test("after a user cancel with no client watching, the task's notice waits and goes with the next message in one turn", async () => {
    const { dir, client, sessionId, port } = await boot()
    const eventsOf = async () => {
      const reply = await client.send({ type: "session.events", sessionId, after: 0, limit: 500 })
      return (reply.ok ? reply.result?.events : []) as SessionEvent[]
    }
    await client.send({ type: "user.submit", sessionId, text: "/hang", attachments: [] })
    let all: SessionEvent[] = []
    const refresh = () => void eventsOf().then((events) => { all = events })
    await until(() => (refresh(), all.some((e) => e.type === "turn.started")))
    const turn = all.find((e) => e.type === "turn.started")
    const started = port().start({ command: "sleep 1; echo built ok", cwd: dir })
    expect(started.ok).toBe(true)
    // Headless: nobody is subscribed when the turn is cancelled, so the idle session is a candidate for eviction.
    expect((await client.send({ type: "client.unsubscribe", sessionId })).ok).toBe(true)
    expect((await client.send({ type: "turn.cancel", sessionId, turnId: (turn && "turnId" in turn ? turn.turnId : undefined) as never })).ok).toBe(true)
    await until(() => (refresh(), all.some((e) => e.type === "queue.added" && "notice" in e && e.notice === true)))
    await new Promise((r) => setTimeout(r, 300))
    expect((await eventsOf()).filter((e) => e.type === "turn.started")).toHaveLength(1)
    await client.send({ type: "user.submit", sessionId, text: "go on", attachments: [] })
    await until(() => (refresh(), all.some((e) => e.type === "turn.completed")))
    expect(all.filter((e) => e.type === "turn.started")).toHaveLength(2)
    const folded = all.filter((e) => e.type === "queue.added").at(-1)
    const text = folded && "text" in folded ? folded.text : ""
    expect(text).toContain("built ok")
    expect(text.endsWith("[the user's message]\ngo on")).toBe(true)
  })

  test("a task the agent stops sends nothing", async () => {
    const { dir, events, port } = await boot()
    const started = port().start({ command: "sleep 30", cwd: dir })
    if (!started.ok) throw new Error(started.error)
    port().kill(started.task.id)
    await new Promise((r) => setTimeout(r, 2_500))
    expect(events.some((e) => e.type === "queue.added")).toBe(false)
  })
})

describe("backgroundNotice", () => {
  test("names the task, how it ended and the last lines of output", () => {
    const text = backgroundNotice({ id: "bg_1", command: "bun run build\n--watch", cwd: "/r", status: "exited", exitCode: 1, startedAt: 0, endedAt: 65_000 }, `${"x\n".repeat(30)}error: boom\n`, 65_000)
    expect(text.split("\n")[0]).toBe("[background task bg_1 exited 1 after 1m 5s: bun run build]")
    expect(text).toContain("error: boom")
    expect(text.split("\n").filter((l) => l === "x").length).toBe(19)
    expect(backgroundNotice({ id: "bg_2", command: "true", cwd: "/r", status: "exited", exitCode: 0, startedAt: 0, endedAt: 0 }, "")).toContain("no output")
    // A restored queue has only the text to go by: both notices are recognised, a peer's message or a user's text is not.
    expect(isBackgroundNotice(text)).toBe(true)
    expect(isBackgroundNotice(watchNotice({ id: "bg_3", command: "bun dev", cwd: "/r", status: "running", startedAt: 0 }, ["ready"], false))).toBe(true)
    expect(isBackgroundNotice("[message from session Other]\nhi")).toBe(false)
    expect(isBackgroundNotice("background task notes")).toBe(false)
  })
})
