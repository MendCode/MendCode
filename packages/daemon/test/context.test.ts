import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, ContextReport, type SessionId } from "@mendcode/protocol"
import type { EnginePort } from "@mendcode/kernel"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const REPORT: ContextReport = {
  model: "fake-1",
  sections: [
    { id: "system:base", label: "system · base prompt", chars: 400, tokens: 100 },
    { id: "history:user", label: "history · user", chars: 40, tokens: 10, count: 2 },
  ],
  largest: [{ role: "user", chars: 30, tokens: 8, preview: "hello" }],
  images: 0,
  estimatedTokens: 110,
  compactAtTokens: 160_000,
}

async function boot(engine: (input: Parameters<Parameters<typeof startDaemon>[0]["engine"]>[0]) => EnginePort, models?: Parameters<typeof startDaemon>[0]["models"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine, ...(models ? { models } : {}) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "A", onEvent: () => {} })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: "/repo", title: "" })
  if (!created.ok) throw new Error(created.error.message)
  return { client, sessionId: created.result?.sessionId as SessionId }
}

describe("context.query", () => {
  test("an engine without contextReport is refused with invalid_command", async () => {
    const { client, sessionId } = await boot(({ clock }) => {
      const { contextReport: _contextReport, ...engine } = createFauxEngine({ clock, deltaMs: 1 })
      return engine
    })
    expect(await client.send({ type: "context.query", sessionId })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })

  test("an engine with contextReport retains its report with the session id added", async () => {
    const { client, sessionId } = await boot(({ clock }) => ({ ...createFauxEngine({ clock, deltaMs: 1 }), contextReport: async () => REPORT }))
    const reply = await client.send({ type: "context.query", sessionId })
    expect(reply.ok).toBe(true)
    expect(reply.ok && ContextReport.parse(reply.result)).toEqual({ ...REPORT, sessionId })
  })

  test("an unknown session is refused with unknown_session", async () => {
    const { client } = await boot(({ clock }) => ({ ...createFauxEngine({ clock, deltaMs: 1 }), contextReport: async () => REPORT }))
    expect(await client.send({ type: "context.query", sessionId: createIdFactory()("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })

  test("additive resource estimates survive transport and a known model catalog supplies the window", async () => {
    const extra = { ...REPORT, categories: [{ id: "mcp", label: "MCP", chars: 80, tokens: 20, count: 1 }], mcpTools: [{ id: "mcp__local__search", label: "search", chars: 80, tokens: 20, count: 1 }], repeatedReads: [{ path: "src/main.ts", count: 2, tokens: 300 }] }
    const { client, sessionId } = await boot(({ clock }) => ({ ...createFauxEngine({ clock, deltaMs: 1 }), contextReport: async () => extra }), { selectable: true, defaults: { model: REPORT.model }, list: () => [{ id: REPORT.model, name: REPORT.model, efforts: [], contextWindow: 200000 }] })
    const reply = await client.send({ type: "context.query", sessionId })
    expect(reply.ok && ContextReport.parse(reply.result)).toEqual({ ...extra, sessionId, contextWindow: 200000 })
  })

  test("an engine that throws for the report is an error reply, and the daemon keeps answering", async () => {
    const { client, sessionId } = await boot(({ clock }) => ({ ...createFauxEngine({ clock, deltaMs: 1 }), contextReport: async () => { throw new Error("[CLAUDE]: Claude Code manages this session's context") } }))
    expect(await client.send({ type: "context.query", sessionId })).toMatchObject({ ok: false, error: { code: "internal", message: "[CLAUDE]: Claude Code manages this session's context" } })
    expect(await client.send({ type: "session.list" })).toMatchObject({ ok: true })
  })
})
