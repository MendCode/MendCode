import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { checkSessionLog } from "@mendcode/testkit"

const MAIN = path.join(import.meta.dir, "../src/main.ts")
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function spawnDaemon(dir: string) {
  const proc = Bun.spawn(["bun", MAIN, "--dir", dir, "--engine", "faux"], { stdout: "pipe", stderr: "inherit" })
  cleanups.push(() => proc.kill("SIGKILL"))
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  const ready = JSON.parse(new TextDecoder().decode(value).split("\n")[0]!) as { socketPath: string }
  return { proc, socketPath: ready.socketPath }
}

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("crash recovery", () => {
  test("kill -9 during a tool: the turn becomes interrupted, is never re-run, and the queue survives held (FC-08, FC-37, I15)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-crash-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const first = await spawnDaemon(dir)
    const events: SessionEvent[] = []
    const client = createClient({ socketPath: first.socketPath, name: "A", reconnect: false, onEvent: (e) => events.push(e) })
    await client.connect()
    const created = await client.send({ type: "session.create", directory: "/repo", title: "crash" })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result?.sessionId as SessionId
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "/hang", attachments: [] })
    await client.send({ type: "user.submit", sessionId, text: "segundo mensaje encolado", attachments: [] })
    await until(() => events.some((e) => e.type === "item.started" && e.kind === "tool_call"))
    first.proc.kill("SIGKILL")
    await first.proc.exited
    client.close()

    const second = await spawnDaemon(dir)
    const after: SessionEvent[] = []
    const again = createClient({ socketPath: second.socketPath, name: "A2", reconnect: false, onEvent: (e) => after.push(e) })
    await again.connect()
    await again.subscribe(sessionId, 0)
    await until(() => after.some((e) => e.type === "turn.interrupted"))
    await new Promise((r) => setTimeout(r, 100))
    again.close()
    second.proc.kill("SIGTERM")
    await second.proc.exited

    expect(after.find((e) => e.type === "turn.interrupted")).toMatchObject({ reason: "restart" })
    expect(after.filter((e) => e.type === "turn.started").length).toBe(1)
    expect(after.some((e) => e.type === "item.completed" && e.status === "interrupted")).toBe(true)
    expect(after.at(-1)).toMatchObject({ type: "foreground.state", state: "queued" })
    expect(checkSessionLog(after, { final: true })).toEqual([])
  }, 20_000)

  test("a client whose daemon died starts it again before reconnecting and resumes its subscription", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-respawn-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await spawnDaemon(dir)
    let respawned: Awaited<ReturnType<typeof spawnDaemon>> | undefined
    const states: string[] = []
    const events: SessionEvent[] = []
    const client = createClient({
      socketPath: first.socketPath,
      name: "R",
      onEvent: (e) => events.push(e),
      onConnection: (state) => states.push(state),
      beforeReconnect: async () => (respawned ??= await spawnDaemon(dir)),
    })
    cleanups.push(() => client.close())
    await client.connect()
    const created = await client.send({ type: "session.create", directory: "/repo", title: "respawn" })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result?.sessionId as SessionId
    await client.subscribe(sessionId, 0)

    first.proc.kill("SIGKILL")
    await first.proc.exited
    // Generous waits: under a full parallel test run the respawn can take seconds.
    await until(() => states.at(-1) === "connected" && states.includes("reconnecting"), 10_000)
    await client.send({ type: "user.submit", sessionId, text: "hola", attachments: [] })
    await until(() => events.some((e) => e.type === "turn.completed"), 10_000)

    expect(respawned).toBeDefined()
    // A retry that raced the new daemon may add another "reconnecting"; what matters is it came back.
    expect(states[0]).toBe("connected")
    expect(states.at(-1)).toBe("connected")
    expect(states).not.toContain("closed")
    expect(checkSessionLog(events, { final: true })).toEqual([])
  }, 20_000)
})
