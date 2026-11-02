import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { parseRecovery, recoverUsage } from "../src/usage-recovery"
import { createUsageQuery } from "../src/usage"
import { parseAutomation, runAutomation } from "../../../apps/cli/src/automation"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const at = "2026-10-20T12:00:00Z"
const claude = (read = 1_100_000_000) => ({ type: "assistant", sessionId: "external", timestamp: at, message: { id: "msg", model: "claude", content: "PRIVATE CONTENT", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: read, cache_creation_input_tokens: 30 } } })
const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n")

test("Claude deduplicates message IDs, retains cache, and returns no content", () => {
  const report = parseRecovery(jsonl(claude(), claude()) + "\n{broken", "claude")
  expect(report.days).toHaveLength(1)
  expect(report.days[0]).toMatchObject({ input: 10, output: 20, cacheRead: 1_100_000_000 })
  expect(report.skipped).toBe(1)
  expect(JSON.stringify(report)).not.toContain("PRIVATE CONTENT")
})

test("Codex uses cumulative deltas and does not add reasoning twice", () => {
  const row = (n: number) => ({ type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: { input_tokens: n, cached_input_tokens: n / 2, output_tokens: 20, reasoning_output_tokens: 10 } } } })
  const report = parseRecovery(jsonl({ type: "session_meta", payload: { id: "external" } }, row(100), row(100), row(200)), "codex")
  expect(report.days[0]).toMatchObject({ input: 100, cacheRead: 100, output: 20 })
  expect(report.ids).toEqual(["external"])
})

test("Pi message entries use disjoint cache counters and deduplicate IDs", () => {
  const row = { type: "message", id: "p1", timestamp: at, message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } }
  expect(parseRecovery(jsonl({ type: "session", id: "pi-session" }, row, row), "pi").days[0]).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
})

test("preview, apply, repeat, stale preview, scope and undo preserve original usage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-recovery-")); dirs.push(dir)
  const store = openStore({ dir, now: () => Date.parse(at) })
  try {
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/recovery-project", title: "Recovery" })
    store.engineBindings.set(sessionId, "claude", "external")
    const file = path.join(dir, "session.jsonl")
    writeFileSync(file, jsonl(claude()))
    const command = { sessionId, engine: "claude" as const, file }
    const query = createUsageQuery(store)
    const range = { from: "2026-10-20", to: "2026-10-20" }
    const preview = await recoverUsage(store, { ...command, action: "preview" })
    expect(query(range, range.to).days).toEqual([])
    if (!("fingerprint" in preview)) throw new Error("Expected preview")
    await expect(recoverUsage(store, { ...command, action: "apply" })).rejects.toThrow("Preview")
    await recoverUsage(store, { ...command, action: "apply", fingerprint: preview.fingerprint })
    expect(query(range, range.to).days[0]?.cacheRead).toBe(1_100_000_000)
    const again = await recoverUsage(store, { ...command, action: "preview" })
    if (!("fingerprint" in again)) throw new Error("Expected preview")
    await recoverUsage(store, { ...command, action: "apply", fingerprint: again.fingerprint })
    expect(query(range, range.to).days[0]?.cacheRead).toBe(1_100_000_000)
    expect(query({ ...range, scope: "directory", directory: "/elsewhere" }, range.to).days).toEqual([])
    store.sessionSink.append({ type: "usage.recorded", sessionId, turnId: ids("turn"), provider: "claude", model: "claude", input: 10, output: 20, cacheRead: 100, cacheWrite: 30, reasoning: 0 })
    expect(query(range, range.to).days[0]?.cacheRead).toBe(1_100_000_000)
    writeFileSync(file, jsonl(claude(1_200_000_000)))
    await expect(recoverUsage(store, { ...command, action: "apply", fingerprint: again.fingerprint })).rejects.toThrow("Preview")
    await recoverUsage(store, { ...command, action: "undo" })
    expect(query(range, range.to).days[0]?.cacheRead).toBe(100)
    store.engineBindings.set(sessionId, "claude", "other")
    await expect(recoverUsage(store, { ...command, action: "preview" })).rejects.toThrow("match")
    const link = path.join(dir, "link.jsonl"); symlinkSync(file, link)
    await expect(recoverUsage(store, { ...command, file: link, action: "preview" })).rejects.toThrow()
  } finally { store.close() }
})

test("CLI recovery requires engine, binding session, file and apply fingerprint", () => {
  expect(parseAutomation(["usage", "recover", "preview", "--session", "s", "--engine", "claude", "--from-file", "/tmp/a.jsonl"])).toMatchObject({ ok: true, command: { kind: "usage.recover", action: "preview" } })
  expect(parseAutomation(["usage", "recover", "apply", "--session", "s", "--engine", "pi", "--from-file", "/tmp/a.jsonl"])).toMatchObject({ ok: false })
})

test("CLI dispatch through a real local daemon recovers all three harnesses without duplicates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-rpc-")); dirs.push(dir)
  const sessions = { claude: ids("session"), codex: ids("session"), pi: ids("session") }
  const files = { claude: path.join(dir, "claude.jsonl"), codex: path.join(dir, "codex.jsonl"), pi: path.join(dir, "pi.jsonl") }
  writeFileSync(files.claude, jsonl(claude()))
  writeFileSync(files.codex, jsonl({ type: "session_meta", payload: { id: "codex-external" } },
    { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } } } }))
  writeFileSync(files.pi, jsonl({ type: "session", id: "pi-external" },
    { type: "message", id: "pi-message", timestamp: at, message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } }))
  const daemon = await startDaemon({ dir: path.join(dir, "data"), socketPath: path.join(dir, "rpc.sock"), defaultDirectory: dir,
    engine: ({ store, clock }) => {
      for (const engine of ["claude", "codex", "pi"] as const) {
        store.createSession({ id: sessions[engine], directory: dir, title: "Synthetic recovery test" })
        store.engineBindings.set(sessions[engine], engine, engine === "pi" ? files.pi : engine === "claude" ? "external" : "codex-external")
      }
      return createFauxEngine({ clock, deltaMs: 1 })
    },
  })
  const client = createClient({ socketPath: daemon.socketPath, name: "usage-recovery-test", reconnect: false })
  try {
    await client.connect()
    const cli = async (engine: keyof typeof sessions, action: string, fingerprint?: string) => {
      const parsed = parseAutomation(["usage", "recover", action, "--session", sessions[engine], "--engine", engine,
        "--from-file", files[engine], "--json", ...(fingerprint ? ["--id", fingerprint] : [])])
      if (parsed.ok !== true) throw new Error("CLI parse failed")
      let output = "", errors = ""
      const code = await runAutomation(parsed.command, { client, cwd: dir, now: () => Date.parse(at), listen() {}, onInterrupt() {},
        out: { write(text) { output += text } }, err: { write(text) { errors += text } } })
      expect(errors).toBe("")
      expect(code).toBe(0)
      expect(output).not.toContain("PRIVATE CONTENT")
      return JSON.parse(output).data
    }
    const usage = async () => {
      const reply = await client.usage({ from: "2026-10-20", to: "2026-10-20", scope: "global" })
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.report
    }
    for (const engine of ["claude", "codex", "pi"] as const) {
      const before = await usage()
      const preview = await cli(engine, "preview")
      expect(await usage()).toEqual(before)
      await cli(engine, "apply", preview.fingerprint)
      const applied = await usage()
      const repeat = await cli(engine, "preview")
      await cli(engine, "apply", repeat.fingerprint)
      expect(await usage()).toEqual(applied)
    }
    expect((await usage()).days[0]).toMatchObject({ input: 80, output: 60, cacheRead: 1_100_000_070, cacheWrite: 70 })
    for (const engine of ["claude", "codex", "pi"] as const) await cli(engine, "undo")
    expect((await usage()).days).toEqual([])
  } finally { client.close(); await daemon.stop() }
}, 30_000)
