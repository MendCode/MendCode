import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeBuildId } from "@mendcode/build-id"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { AGENT_SHELL_ENV, type SessionId } from "@mendcode/protocol"
import { agentProcesses, shell } from "@mendcode/tools"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  agentProcesses.clear()
})
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
type Seen = { type: string; seq?: number; sessionId?: string; turnId?: string; reason?: string; cause?: string; kind?: string; meta?: Record<string, unknown>; text?: string; questions?: Array<{ options?: Array<{ label: string }> }> }

describe.skipIf(process.platform === "win32")("a daemon stop with a run --bg child mid-turn, end to end with the real CLI", () => {
  const main = path.resolve(import.meta.dir, "../../../apps/cli/src/main.ts")

  async function boot() {
    const dir = temp("mcev-p-rr-")
    const project = temp("mcev-p-rr-project-")
    const open = async () => {
      const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, buildId: computeBuildId(), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
      const events: Seen[] = []
      const terminal = createClient({ socketPath: daemon.socketPath, name: "owner", capabilities: ["extension-dialogs"], onEvent: (event) => void events.push(event as never) })
      await terminal.connect()
      const stop = async () => { terminal.close(); await daemon.stop() }
      cleanups.push(() => stop().catch(() => undefined))
      return { daemon, terminal, events, stop }
    }
    const first = await open()
    const created = await first.terminal.send({ type: "session.create", directory: project, title: "seda" })
    if (!created.ok) throw new Error(created.error.message)
    const launcher = created.result!.sessionId as SessionId
    await first.terminal.subscribe(launcher, 0)
    const evade = path.join(project, "evade")
    writeFileSync(evade, `#!/bin/sh\nexec env -u ${AGENT_SHELL_ENV} -u MENDCODE_SESSION_ID ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`)
    chmodSync(evade, 0o755)
    const environment = { ...process.env, MENDCODE_V2_DIR: dir, MENDCODE_SESSION_ID: launcher }
    const run = (command: string) => shell.execute({ command, timeoutMs: 60_000 }, { cwd: project, signal: new AbortController().signal, environment })
    const until = async <T>(find: () => T | undefined | Promise<T | undefined>) => {
      for (let i = 0; i < 400; i++) {
        const found = await find()
        if (found) return found
        await Bun.sleep(25)
      }
      throw new Error("timed out waiting in the test")
    }
    const start = async (title: string, prompt: string) => {
      const result = await run(`./evade run --bg --title ${title} '${prompt}'`)
      expect(result.isError).toBe(false)
      return result.output.trim().split("\n").find((line) => line.startsWith("ses_"))!.trim() as SessionId
    }
    const log = async (client: typeof first.terminal, sessionId: string) => {
      const reply = await client.send({ type: "session.events", sessionId: sessionId as SessionId, after: 0 })
      return reply.ok ? (reply.result!.events as Seen[]) : []
    }
    return { first, open, launcher, run, until, start, log }
  }

  test("a forced stop interrupts the child with the shutdown cause and the next start resumes it to the end; the launcher link survives", async () => {
    const h = await boot()
    const child = await h.start("owner-a", "/tool 5000")
    await h.until(async () => (await h.log(h.first.terminal, child)).find((event) => event.type === "item.started" && event.kind === "tool_call"))
    const store = h.first.daemon.store
    expect(store.launchers.get(child)).toBe(h.launcher)
    expect(store.sessionInfo(child)?.parentId).toBeFalsy()

    await h.first.stop()
    const second = await h.open()
    const finished = await h.until(async () => {
      const events = await h.log(second.terminal, child)
      return events.some((event) => event.type === "turn.completed") ? events : undefined
    })
    const interrupted = finished.find((event) => event.type === "turn.interrupted")
    expect(interrupted).toMatchObject({ reason: "restart", cause: "daemon_shutdown" })
    const turns = finished.filter((event) => event.type === "turn.started")
    expect(turns).toHaveLength(2)
    expect(finished.find((event) => event.type === "item.started" && event.kind === "user_message" && event.meta?.restart === "resume")).toBeDefined()
    expect(finished.filter((event) => event.type === "turn.completed")).toHaveLength(1)
    // Resumed once: nothing is left waiting.
    expect(second.daemon.store.resumes.count()).toBe(0)

    // The link is still there: a child that now waits for approval is announced to its launcher, and its status names the launcher's wait.
    expect(second.daemon.store.launchers.get(child)).toBe(h.launcher)
    await second.terminal.subscribe(h.launcher, 0)
    await second.terminal.send({ type: "user.submit", sessionId: child, text: "/ask", attachments: [] })
    await h.until(() => JSON.stringify(second.events).includes("blocked waiting for the user's approval") || undefined)
  }, 120_000)

  test("with resumeAfterRestart off, the child stays interrupted and its launcher is told", async () => {
    const h = await boot()
    expect((await h.first.terminal.send({ type: "settings.set", patch: { resumeAfterRestart: false } })).ok).toBe(true)
    const child = await h.start("owner-b", "/tool 5000")
    await h.until(async () => (await h.log(h.first.terminal, child)).find((event) => event.type === "item.started" && event.kind === "tool_call"))

    await h.first.stop()
    const second = await h.open()
    await second.terminal.subscribe(h.launcher, 0)
    await h.until(async () => (await h.log(second.terminal, h.launcher)).some((event) => JSON.stringify(event).includes("was interrupted when the daemon stopped and was not resumed")) || undefined)
    const events = await h.log(second.terminal, child)
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1)
    expect(events.some((event) => event.type === "turn.completed")).toBe(false)
    expect(events.find((event) => event.type === "turn.interrupted")).toMatchObject({ cause: "daemon_shutdown" })
    expect(second.daemon.store.resumes.count()).toBe(0)
  }, 120_000)
})

describe.skipIf(process.platform === "win32")("restarts in a row and a message queued behind the interrupted turn", () => {
  async function boot() {
    const dir = temp("mcev-p-rrq-")
    const project = temp("mcev-p-rrq-project-")
    const open = async () => {
      const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, buildId: computeBuildId(), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
      const terminal = createClient({ socketPath: daemon.socketPath, name: "owner" })
      await terminal.connect()
      let closed = false
      const stop = async () => { if (closed) return; closed = true; terminal.close(); await daemon.stop() }
      cleanups.push(() => stop().catch(() => undefined))
      return { daemon, terminal, stop }
    }
    const first = await open()
    const created = await first.terminal.send({ type: "session.create", directory: project, title: "seda" })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result!.sessionId as SessionId
    const log = async (client: typeof first.terminal) => {
      const reply = await client.send({ type: "session.events", sessionId, after: 0 })
      return reply.ok ? (reply.result!.events as Seen[]) : []
    }
    const until = async <T>(find: () => T | undefined | Promise<T | undefined>) => {
      for (let i = 0; i < 400; i++) {
        const found = await find()
        if (found) return found
        await Bun.sleep(25)
      }
      throw new Error("timed out waiting in the test")
    }
    const submit = (client: typeof first.terminal, text: string) => client.send({ type: "user.submit", sessionId, text, attachments: [] })
    return { first, open, sessionId, log, until, submit }
  }

  test("a message queued while the turn ran does not stop the resume; it follows the resumed turn and the queue is not held", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 5000")).ok).toBe(true)
    await h.until(async () => (await h.log(h.first.terminal)).find((event) => event.type === "item.started" && event.kind === "tool_call"))
    expect((await h.submit(h.first.terminal, "after the turn")).ok).toBe(true)
    await h.until(async () => (await h.log(h.first.terminal)).find((event) => event.type === "queue.added"))

    await h.first.stop()
    const second = await h.open()
    const events = await h.until(async () => {
      const seen = await h.log(second.terminal)
      return seen.filter((event) => event.type === "turn.completed").length >= 2 ? seen : undefined
    })
    const started = events.filter((event) => event.type === "turn.started")
    expect(started).toHaveLength(3)
    const users = events.filter((event) => event.type === "item.started" && event.kind === "user_message")
    expect(users[1]!.meta?.restart).toBe("resume")
    expect(events.find((event) => event.type === "item.completed" && event.text === "after the turn")).toBeDefined()
    const queue = await second.terminal.send({ type: "queue.list", sessionId: h.sessionId })
    expect(queue.ok && (queue.result as { held: boolean; entries: unknown[] })).toMatchObject({ held: false, entries: [] })
    expect(second.daemon.store.resumes.count()).toBe(0)
  }, 120_000)

  test("a second restart right after the first still resumes the turn on the third start", async () => {
    const h = await boot()
    expect((await h.submit(h.first.terminal, "/tool 5000")).ok).toBe(true)
    await h.until(async () => (await h.log(h.first.terminal)).find((event) => event.type === "item.started" && event.kind === "tool_call"))

    await h.first.stop()
    // The second daemon is stopped as soon as it is up, as `daemon restart --force` run twice in a row does.
    const second = await h.open()
    await second.stop()
    const third = await h.open()
    const events = await h.until(async () => {
      const seen = await h.log(third.terminal)
      return seen.some((event) => event.type === "turn.completed") ? seen : undefined
    })
    expect(events.filter((event) => event.type === "turn.interrupted").every((event) => event.cause === "daemon_shutdown")).toBe(true)
    expect(events.filter((event) => event.type === "item.started" && event.kind === "user_message" && event.meta?.restart === "resume").length).toBeGreaterThanOrEqual(1)
    expect(third.daemon.store.resumes.count()).toBe(0)
  }, 120_000)
})
