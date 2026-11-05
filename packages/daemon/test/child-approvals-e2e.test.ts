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
type Seen = { type: string; sessionId?: string; requestId?: string; title?: string; resolution?: string; questions?: Array<{ context?: string; options?: Array<{ label: string }> }> }

describe.skipIf(process.platform === "win32")("sessions a session started with run --bg, blocked on approval, end to end with the real CLI", () => {
  const main = path.resolve(import.meta.dir, "../../../apps/cli/src/main.ts")

  async function boot() {
    const dir = temp("mcev-p-cha-")
    const project = temp("mcev-p-cha-project-")
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, buildId: computeBuildId(), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const events: Seen[] = []
    const terminal = createClient({ socketPath: daemon.socketPath, name: "owner", capabilities: ["extension-dialogs"], onEvent: (event) => void events.push(event as never) })
    await terminal.connect()
    cleanups.push(() => daemon.stop(), () => terminal.close())
    const created = await terminal.send({ type: "session.create", directory: project, title: "seda" })
    if (!created.ok) throw new Error(created.error.message)
    const launcher = created.result!.sessionId as SessionId
    await terminal.subscribe(launcher, 0)
    const evade = path.join(project, "evade")
    writeFileSync(evade, `#!/bin/sh\nexec env -u ${AGENT_SHELL_ENV} -u MENDCODE_SESSION_ID ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`)
    chmodSync(evade, 0o755)
    const environment = { ...process.env, MENDCODE_V2_DIR: dir, MENDCODE_SESSION_ID: launcher }
    const run = (command: string) => shell.execute({ command, timeoutMs: 60_000 }, { cwd: project, signal: new AbortController().signal, environment })
    const until = async <T>(find: () => T | undefined) => {
      for (let i = 0; i < 400; i++) {
        const found = find()
        if (found) return found
        await Bun.sleep(25)
      }
      throw new Error("timed out waiting in the test")
    }
    const start = async (title: string) => {
      const result = await run(`./evade run --bg --title ${title} '/ask'`)
      expect(result.isError).toBe(false)
      return result.output.trim().split("\n").find((line) => line.startsWith("ses_"))!.trim() as SessionId
    }
    return { terminal, launcher, run, until, start, events }
  }

  test("two blocked children reach the user as one card and the launcher as one notice; Approve all lets both finish", async () => {
    const h = await boot()
    const a = await h.start("owner-a")
    const b = await h.start("owner-b")

    const card = await h.until(() => h.events.find((event) => event.type === "server.request" && event.sessionId === h.launcher && event.questions?.[0]?.options?.[0]?.label === "Approve all (2)"))
    expect(card.questions![0]!.context).toContain("owner-a")
    expect(card.questions![0]!.context).toContain("owner-b")

    // The launcher's model is told, once, that these wait for the user and that it cannot approve.
    await h.until(() => JSON.stringify(h.events).includes("blocked waiting for the user's approval") || undefined)

    // What the launcher reads from its own shell names the wait.
    const status = await h.run(`./evade session status ${a}`)
    expect(status.output).toContain("waiting_for_approval")
    expect(status.output).toContain("Waiting: approval")
    const logs = await h.run(`./evade logs ${a}`)
    expect(logs.output).toContain("waiting for approval")

    // The launcher's own shell cannot answer the card.
    const refused = await h.run(`./evade session send ${a} x --async --approve`)
    expect(refused.isError).toBe(true)

    expect((await h.terminal.send({ type: "request.resolve", sessionId: h.launcher, requestId: card.requestId as never, decision: { kind: "answer", text: "Approve all (2)", answers: [["Approve all (2)"]] } })).ok).toBe(true)
    for (const child of [a, b]) {
      for (let i = 0; i < 400; i++) {
        const reply = await h.terminal.send({ type: "session.events", sessionId: child, after: 0 })
        const types = reply.ok ? (reply.result!.events as Array<{ type: string; resolution?: string }>) : []
        if (types.some((event) => event.type === "turn.completed")) {
          expect(types.find((event) => event.type === "server.request.resolved")).toMatchObject({ resolution: "approved" })
          break
        }
        if (i === 399) throw new Error(`${child} never finished`)
        await Bun.sleep(25)
      }
    }
  }, 120_000)
})
