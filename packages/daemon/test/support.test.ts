import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { assembleSchema, createIdFactory, Frame, RecentContextReport, SystemReport, type SchemaIndex, type SchemaPage } from "@mendcode/protocol"
import { boot, answer, until, put, openSession } from "./native-harness"
import { systemReport } from "../src/system-report"
import { daemonLogger } from "../src/logging"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function native() { const h = await boot({ steps: [answer("First", { input: 100, output: 10 }), answer("Second", { input: 200, output: 20 })] }); cleanups.push(h.cleanup); return h }

test("recent context persists measured request profiles, limits calls and excludes undone turns", async () => {
  const h = await native()
  const sessionId = await openSession(h)
  for (const [index, text] of ["one", "two"].entries()) {
    expect((await h.client.send({ type: "user.submit", sessionId, text, attachments: [] })).ok).toBe(true)
    await until(() => h.store.turns.list(sessionId).filter((turn) => turn.status === "completed").length === index + 1)
  }
  const recent = await h.client.recentContext(sessionId, 1)
  expect(recent.ok).toBe(true)
  if (!recent.ok) return
  expect(RecentContextReport.safeParse(recent.report).success).toBe(true)
  expect(recent.report.requests).toHaveLength(1)
  expect(recent.report.requests[0]).toMatchObject({ inputTokens: 200, profile: { imageCount: 0 } })
  expect(recent.report.requests[0]!.profile!.durationMs).toBeGreaterThanOrEqual(0)
  expect(recent.report.requests[0]!.profile!.estimatedTokens.total).toBeGreaterThan(0)
  expect(recent.report.truncated).toBe(true)
  const seq = recent.report.requests[0]!.seq
  expect(h.store.readAfter(sessionId, seq - 1, 1)[0]!.type).toBe("usage.recorded")
  expect((await h.client.send({ type: "session.undo", sessionId })).ok).toBe(true)
  const undone = await h.client.recentContext(sessionId)
  expect(undone.ok && undone.report.requests.map((request) => request.inputTokens)).toEqual([100])
  expect(await h.client.recentContext(createIdFactory()("session"))).toMatchObject({ ok: false, error: { code: "unknown_session" } })
})

test("all system operations return real v2 paths and transport, with a usable generated schema", async () => {
  const h = await native()
  for (const operation of ["status", "doctor", "check", "toolchain", "config-paths", "adapter-status", "ai-env", "ai-status", "generate"] as const) {
    const reply = await h.client.systemReport(h.project, operation)
    expect(reply.ok).toBe(true)
    if (!reply.ok) continue
    expect(SystemReport.safeParse(reply.report).success).toBe(true)
    if (operation === "check") expect(reply.report.ok).toBe(true)
    if (operation === "config-paths") expect(reply.report.facts.paths).toMatchObject({ database: path.join(h.dir, "mendd.db"), project: path.join(h.project, ".mendcode") })
    if (operation === "adapter-status") expect(reply.report.facts.adapter).toMatchObject({ architecture: "daemon + protocol + client", donorRuntime: false })
    if (operation === "generate") expect(JSON.stringify(reply.report.facts.contract)).toContain("command:system.query")
  }
})

test("generate serves the protocol schema as an index, per-command entries and bounded pages that reassemble over the wire", async () => {
  const h = await native()
  const generate = async (schema: { entry?: string; page?: number; index?: number }) => {
    const reply = await h.client.systemReport(h.project, "generate", schema)
    expect(reply.ok).toBe(true)
    return reply.ok ? reply.report : (undefined as never)
  }
  const head = (await generate({})).facts.contract as { index: SchemaIndex }
  expect(head.index.pages).toBeGreaterThan(0)
  const indexes = [head.index]
  for (let next = 1; next < head.index.indexPages; next++) indexes.push(((await generate({ index: next })).facts.contract as { index: SchemaIndex }).index)
  expect(indexes.flatMap((index) => index.entries).map((entry) => entry.name)).toContain("command:tui.query")
  const entry = (await generate({ entry: "command:tui.query" })).facts.contract as { entry: string; schema: Record<string, unknown> }
  expect(JSON.stringify(entry.schema)).toContain("tui.query")
  const pages: SchemaPage[] = []
  for (let page = 0; page < head.index.pages; page++) pages.push(((await generate({ page })).facts.contract as { page: SchemaPage }).page)
  const whole = assembleSchema({ indexes, pages })
  const source = z.toJSONSchema(Frame, { io: "input", reused: "ref" })
  expect(whole).toEqual(source)
  const missing = await generate({ entry: "command:nope" })
  expect(missing.ok).toBe(false)
  expect(missing.failures.join()).toContain("unknown entry")
  expect((await generate({ page: 999 })).ok).toBe(false)
})

test("missing adapter toolchain fails and AI environment reports presence without values", () => {
  const input = { dir: "/tmp/test-data", directory: "/tmp/project", socketPath: "/tmp/test-data/mendd.sock", engine: "codex", settings: {}, catalog: { selectable: false, list: () => [], defaults: { model: "default" } }, which: () => null, environment: { OPENAI_API_KEY: "secret-for-presence-only" } }
  const missing = systemReport("toolchain", input)
  expect(missing.ok).toBe(false)
  expect(missing.failures).toContain("codex: not found on PATH")
  const env = systemReport("ai-env", input)
  expect(JSON.stringify(env)).not.toContain("secret-for-presence-only")
  expect(env.facts.environment).toContainEqual({ name: "OPENAI_API_KEY", present: true })
})

test("debug file/tree/search obey limits/globs and redact credential-looking results", async () => {
  const h = await native()
  put(path.join(h.project, "src", "one.ts"), "needle one\nAPI_KEY=secretvalue123456\nneedle two\n")
  put(path.join(h.project, "other", "one.ts"), "needle three\n")
  put(path.join(h.project, "notes.md"), "needle notes\n")
  const query = (operation: "files" | "tree" | "search", options = {}) => h.client.send({ type: "files.query", directory: h.project, operation, ...options })
  const files = await query("files", { query: "one", glob: ["*.ts"], limit: 1 })
  expect(files.ok && files.result!.lines).toHaveLength(1)
  expect(files.ok && files.result!.truncated).toBe(true)
  const tree = await query("tree", { glob: ["*.ts"] })
  expect(tree.ok && (tree.result!.lines as string[]).filter((line) => line.trim() === "one.ts")).toHaveLength(2)
  const found = await query("search", { query: "needle", glob: ["*.ts"], limit: 2 })
  expect(found.ok && found.result!.lines).toHaveLength(2)
  expect(found.ok && (found.result!.lines as string[]).some((line) => line.includes("notes.md"))).toBe(false)
  const secret = await query("search", { query: "API_KEY" })
  expect(JSON.stringify(secret)).not.toContain("secretvalue123456")
  expect(await query("search", { query: "[" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
})

test("logLevel persists and filtering follows configuration changes", async () => {
  const h = await native()
  expect(await h.client.send({ type: "settings.set", patch: { logLevel: "ERROR" } })).toMatchObject({ ok: true, result: { settings: { logLevel: "ERROR" } } })
  expect(h.store.settings.get().logLevel).toBe("ERROR")
  let level: "INFO" | "ERROR" = "ERROR"
  const logs: string[] = []
  const log = daemonLogger(() => level, (_, message) => logs.push(message))
  log("warn", "hidden")
  log("error", "API_KEY=secretvalue123456")
  level = "INFO"
  log("info", "visible")
  expect(logs).toHaveLength(2)
  expect(logs.join("\n")).not.toContain("secretvalue123456")
  expect(logs.at(-1)).toBe("visible")
})
