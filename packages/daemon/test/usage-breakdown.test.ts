import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "@mendcode/store"
import { createUsageQuery } from "../src/usage"
import { usageBreakdown } from "../src/usage-breakdown"

const ids = createIdFactory()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const at = Date.parse("2026-10-20T12:00:00Z")
const day = new Date(at)
const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
const range = { from: today, to: today }

function withStore(run: (store: Store) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-breakdown-")); dirs.push(dir)
  const store = openStore({ dir, now: () => at })
  try { run(store) } finally { store.close() }
}

function session(store: Store, input: { binding?: string; parentId?: SessionId; directory?: string } = {}) {
  const id = ids("session")
  store.createSession({ id, directory: input.directory ?? "/project", title: "s", ...(input.parentId ? { parentId: input.parentId } : {}) })
  if (input.binding) store.engineBindings.set(id, input.binding, `external-${id}`)
  return id
}

function call(store: Store, sessionId: SessionId, input: { provider: string; model?: string; input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number; costMicros?: number }) {
  store.sessionSink.append({ type: "usage.recorded", sessionId, turnId: ids("turn"), model: input.model ?? "m", reasoning: 0, ...input })
}

const tokens = (row: { input: number; output: number; cacheRead: number; cacheWrite: number }) => row.input + row.output + row.cacheRead + row.cacheWrite

test("every harness is counted once, with its cache, and the rows add up to the days", () => withStore((store) => {
  const native = session(store)
  const claude = session(store, { binding: "claude" })
  const codex = session(store, { binding: "codex" })
  const pi = session(store, { binding: "pi" })
  const acp = session(store, { binding: "acp:gemini" })
  call(store, native, { provider: "anthropic", input: 100, output: 50, reasoning: 20, cacheRead: 1_000, cacheWrite: 200, costMicros: 900 })
  call(store, claude, { provider: "claude", input: 10, output: 40, cacheRead: 5_000, cacheWrite: 300 })
  call(store, codex, { provider: "codex", input: 30, output: 60, reasoning: 30, cacheRead: 700, cacheWrite: 0 })
  call(store, pi, { provider: "anthropic", input: 5, output: 5, cacheRead: 50, cacheWrite: 5, costMicros: 40 })
  call(store, acp, { provider: "acp", model: "gemini", input: 8, output: 2, cacheRead: 0, cacheWrite: 0 })
  const report = createUsageQuery(store, "/project", usageBreakdown)(range, today)
  const byName = new Map(report.harnesses!.map((row) => [row.harness, row]))
  expect([...byName.keys()].sort()).toEqual(["acp:gemini", "claude-code", "codex", "native", "pi"])
  expect(byName.get("claude-code")).toMatchObject({ calls: 1, sessions: 1, input: 10, output: 40, cacheRead: 5_000, cacheWrite: 300, costMicros: 0, costUnknownCalls: 1 })
  expect(byName.get("native")).toMatchObject({ calls: 1, cacheRead: 1_000, cacheWrite: 200, reasoning: 20, costMicros: 900, costUnknownCalls: 0 })
  // pi reports its model's provider: the session's binding names the harness.
  expect(byName.get("pi")).toMatchObject({ input: 5, cacheRead: 50, cacheWrite: 5 })
  const day = report.days[0]!
  const sum = report.harnesses!.reduce((total, row) => total + tokens(row), 0)
  expect(sum).toBe(tokens(day))
  expect(report.harnesses!.reduce((total, row) => total + row.calls, 0)).toBe(day.calls)
  // Models carry their cache too.
  expect(report.models.find((model) => model.provider === "claude")).toMatchObject({ cacheRead: 5_000, cacheWrite: 300 })
}))

test("a child session counts once, in its harness, and is reported as that harness's sub-agent part", () => withStore((store) => {
  const parent = session(store)
  const child = session(store, { parentId: parent })
  call(store, parent, { provider: "anthropic", input: 100, output: 10, cacheRead: 900, cacheWrite: 0 })
  call(store, child, { provider: "anthropic", input: 40, output: 5, cacheRead: 300, cacheWrite: 60 })
  const report = createUsageQuery(store, "/project", usageBreakdown)(range, today)
  expect(report.harnesses).toHaveLength(1)
  const native = report.harnesses![0]!
  expect(native).toMatchObject({ harness: "native", calls: 2, sessions: 2, input: 140, cacheRead: 1_200, cacheWrite: 60 })
  expect(native.subagents).toEqual({ calls: 1, sessions: 1, tokens: 405 })
  expect(tokens(native)).toBe(tokens(report.days[0]!))
}))

test("deleted sessions, imported usage and calls outside turns keep the totals whole without double counting", () => withStore((store) => {
  const kept = session(store)
  const gone = session(store)
  const imported = session(store, { binding: "claude" })
  call(store, kept, { provider: "anthropic", input: 10, output: 10, cacheRead: 100, cacheWrite: 0, costMicros: 5 })
  call(store, gone, { provider: "anthropic", input: 20, output: 20, cacheRead: 200, cacheWrite: 10, costMicros: 7 })
  store.deleteSession(gone)
  store.usageRecovery.save([{ sessionId: imported, engine: "claude", day: today, input: 1, output: 2, cacheRead: 3_000, cacheWrite: 4 }])
  store.usageAuxiliary.record({ at, role: "title", provider: "chatgpt", model: "luna", directory: "/project", input: 50, output: 5, cacheRead: 25 })
  // The reviewer's row attributes turns already in the days: never added to the calls outside turns.
  store.usageAuxiliary.record({ at, role: "prReview", provider: "anthropic", model: "opus", directory: "/project", input: 999, output: 999 })
  const report = createUsageQuery(store, "/project", usageBreakdown)(range, today)
  const byName = new Map(report.harnesses!.map((row) => [row.harness, row]))
  expect(byName.get("unattributed")).toMatchObject({ calls: 1, input: 20, cacheRead: 200, cacheWrite: 10, costMicros: 7 })
  expect(byName.get("imported:claude")).toMatchObject({ calls: 0, cacheRead: 3_000, cacheWrite: 4 })
  expect(report.harnesses!.reduce((total, row) => total + tokens(row), 0)).toBe(tokens(report.days[0]!))
  expect(report.auxiliaryDays).toEqual([{ day: today, input: 50, output: 5, reasoning: 0, cacheRead: 25, cacheWrite: 0, calls: 1, costMicros: 0, costUnknownCalls: 1 }])
  // A directory scope sees only its own sessions; nothing is attributed to sessions of other directories.
  const elsewhere = createUsageQuery(store, "/project", usageBreakdown)({ ...range, scope: "directory", directory: "/elsewhere" }, today)
  expect(elsewhere.harnesses).toBeUndefined()
  expect(elsewhere.auxiliaryDays).toBeUndefined()
}))

test("without the breakdown loaded the report keeps its older shape", () => withStore((store) => {
  call(store, session(store), { provider: "anthropic", input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })
  const report = createUsageQuery(store, "/project")(range, today)
  expect(report.harnesses).toBeUndefined()
  expect(report.auxiliaryDays).toBeUndefined()
}))
