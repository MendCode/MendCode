import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { EXIT, foldSession, helpText, loopRows, memoryRows, parseAutomation, parseEvery, runAutomation, SCHEMA, sessionRows, usageText, type Automation, type AutomationDeps } from "../src/automation"

const ids = createIdFactory()
const NOW = Date.UTC(2026, 8, 26, 12)

function parsed(...argv: string[]): Automation {
  const result = parseAutomation(argv)
  if (result.ok !== true) throw new Error(`not parsed: ${JSON.stringify(result)}`)
  return result.command
}
const failure = (...argv: string[]) => {
  const result = parseAutomation(argv)
  if (result.ok !== false) throw new Error("expected a parse error")
  return result.message
}

describe("argument parsing", () => {
  test("run and the UI are not automation commands", () => {
    expect(parseAutomation(["run", "hello"])).toEqual({ ok: "none" })
    expect(parseAutomation([])).toEqual({ ok: "none" })
    expect(parseAutomation(["--dir", "/x"])).toEqual({ ok: "none" })
  })

  test("session list defaults and flags, including --format json as an alias of --json", () => {
    expect(parsed("session", "list")).toEqual({ kind: "session.list", all: false, limit: 50, json: false })
    expect(parsed("session", "list", "--all", "--limit", "5", "--json")).toEqual({ kind: "session.list", all: true, limit: 5, json: true })
    expect(parsed("session", "list", "--format", "json")).toMatchObject({ json: true })
    expect(parsed("session", "list", "--format=table")).toMatchObject({ json: false })
    expect(parsed("--dir", "/d", "session", "list")).toMatchObject({ dir: "/d" })
  })

  test("session create, send, wait, events and cancel", () => {
    expect(parsed("session", "create", "--title", "Fix it")).toMatchObject({ kind: "session.create", title: "Fix it" })
    expect(parsed("session", "create")).toMatchObject({ title: "" })
    expect(parsed("session", "send", "ses_1", "do", "the", "thing", "--wait", "--approve")).toMatchObject({ kind: "session.send", id: "ses_1", text: "do the thing", wait: true, approve: true })
    expect(parsed("session", "send", "ses_1", "x", "--wait", "--timeout", "2.5")).toMatchObject({ timeoutMs: 2500 })
    expect(parsed("session", "wait", "ses_1", "--timeout", "30")).toMatchObject({ kind: "session.wait", id: "ses_1", timeoutMs: 30_000 })
    expect(parsed("session", "wait", "ses_1")).not.toHaveProperty("timeoutMs")
    expect(parsed("session", "events", "ses_1", "--after", "7", "--follow")).toMatchObject({ kind: "session.events", after: 7, follow: true })
    expect(parsed("session", "events", "ses_1")).toMatchObject({ after: 0, follow: false })
    expect(parsed("session", "cancel", "ses_1")).toMatchObject({ kind: "session.cancel", id: "ses_1" })
  })

  test("memory commands", () => {
    expect(parsed("memory", "list", "--status", "pending")).toMatchObject({ kind: "memory.list", status: "pending" })
    expect(parsed("memory", "add", "--user", "--category", "style", "terse", "answers")).toMatchObject({ kind: "memory.add", user: true, category: "style", text: "terse answers" })
    expect(parsed("memory", "add", "project fact")).toMatchObject({ user: false })
    expect(parsed("memory", "search", "pnpm", "--limit", "3")).toMatchObject({ kind: "memory.search", query: "pnpm", limit: 3 })
  })

  test("loop create maps triggers and budgets", () => {
    expect(parsed("loop", "create", "--every", "1h", "--goal", "--runs", "5", "watch", "CI")).toMatchObject({ trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "goal", maxRuns: 5 }, objective: "watch CI", name: "watch CI", runNow: false })
    expect(parsed("loop", "create", "--daily", "09:00", "check")).toMatchObject({ trigger: { kind: "daily", at: "09:00" }, budget: { mode: "monitor" } })
    expect(parsed("loop", "create", "--now", "--runs", "2", "--name", "once", "do it")).toMatchObject({ trigger: { kind: "manual" }, budget: { mode: "fixed", maxRuns: 2 }, runNow: true, name: "once" })
    expect(parsed("loop", "create", "--every", "30m", "--criteria", "tests pass", "--goal", "fix")).toMatchObject({ criteria: "tests pass", budget: { mode: "goal" } })
    expect(parseEvery("2d")).toBe(172_800_000)
    expect(parseEvery("90s")).toBeUndefined()
  })

  test("loop list and control actions", () => {
    expect(parsed("loop", "list", "--all")).toMatchObject({ kind: "loop.list", all: true })
    for (const action of ["pause", "resume", "stop", "run", "delete"] as const) expect(parsed("loop", action, "loop_1")).toMatchObject({ kind: "loop.control", id: "loop_1", action })
  })

  test("loop fire takes an id and an optional note", () => {
    expect(parsed("loop", "fire", "loop_1")).toEqual({ kind: "loop.fire", id: "loop_1", json: false })
    expect(parsed("loop", "fire", "loop_1", "--note", "CI run 7 failed")).toMatchObject({ kind: "loop.fire", id: "loop_1", note: "CI run 7 failed" })
    expect(failure("loop", "fire")).toBe("loop fire needs <id>")
    expect(failure("loop", "fire", "loop_1", "--note", "x".repeat(501))).toBe("--note needs 1 to 500 characters")
    expect(helpText("loop")).toContain("fire <id>")
  })

  test("usage defaults to 30 days", () => {
    expect(parsed("usage")).toMatchObject({ kind: "usage", days: 30 })
    expect(parsed("usage", "--days", "7", "--json")).toMatchObject({ days: 7, json: true })
  })

  test("storage report, clean, dry run and vacuum", () => {
    expect(parsed("storage")).toMatchObject({ kind: "storage", clean: false, dryRun: false, vacuum: false, olderThanDays: 0 })
    expect(parsed("storage", "--clean")).toMatchObject({ clean: true })
    expect(parsed("storage", "--clean")).not.toHaveProperty("olderThanDays")
    expect(parsed("storage", "--clean", "--older-than", "90d", "--dry-run")).toMatchObject({ clean: true, olderThanDays: 90, dryRun: true })
    expect(parsed("storage", "--clean", "--older-than=30")).toMatchObject({ olderThanDays: 30 })
    expect(parsed("storage", "--vacuum")).toMatchObject({ clean: true, vacuum: true, olderThanDays: 0 })
    expect(parsed("storage", "--clean", "--vacuum", "--json")).toMatchObject({ vacuum: true, json: true })
    expect(failure("storage", "--older-than", "90d")).toContain("need --clean")
    expect(failure("storage", "--dry-run")).toContain("need --clean")
    expect(failure("storage", "--clean", "--older-than", "soon")).toContain("--older-than")
    expect(failure("storage", "--clean", "--dry-run", "--vacuum")).toContain("cannot vacuum")
    expect(helpText("storage")).toContain("--dry-run")
    expect(helpText()).toContain("mendcode storage")
  })

  test("help at the top level and per command", () => {
    expect(parsed("help")).toMatchObject({ kind: "help" })
    expect(parsed("--help")).toMatchObject({ kind: "help" })
    expect(parsed("session", "--help")).toMatchObject({ kind: "help", topic: "session" })
    expect(parsed("help", "loop")).toMatchObject({ topic: "loop" })
    expect(helpText()).toContain("exit codes: 0 ok")
    for (const topic of ["session", "memory", "loop", "usage"]) expect(helpText(topic)).toStartWith(`usage: mendcode ${topic}`)
    for (const word of ["session list", "session create", "session send", "session wait", "session events", "session cancel", "memory", "loop", "usage"]) expect(helpText()).toContain(word.split(" ")[0]!)
  })

  test("invalid input is a parse error naming the problem", () => {
    expect(failure("session")).toContain("needs a command")
    expect(failure("session", "bogus")).toContain('unknown session command "bogus"')
    expect(failure("session", "send", "ses_1")).toContain("needs <id>")
    expect(failure("session", "wait")).toContain("needs <id>")
    expect(failure("session", "list", "--limit", "abc")).toContain("--limit")
    expect(failure("session", "list", "--limit", "0")).toContain("--limit")
    expect(failure("session", "list", "--wat")).toContain("unknown flag --wat")
    expect(failure("session", "list", "--dir")).toContain("--dir needs a value")
    expect(failure("session", "list", "--format", "xml")).toContain("--format")
    expect(failure("session", "wait", "ses_1", "--timeout", "-1")).toContain("--timeout")
    expect(failure("memory", "add")).toContain('"text"')
    expect(failure("memory", "nope")).toContain("unknown memory command")
    expect(failure("loop", "create", "objective")).toContain("--every, --daily or --now")
    expect(failure("loop", "create", "--every", "10s", "x")).toContain("at least 1m")
    expect(failure("loop", "create", "--every", "1h", "--daily", "09:00", "x")).toContain("not both")
    expect(failure("loop", "create", "--daily", "25:00", "x")).toContain("HH:MM")
    expect(failure("loop", "pause")).toContain("needs <id>")
    expect(failure("usage", "--days", "1.5")).toContain("--days")
  })
})

// ---------------------------------------------------------------------------------------------

type Send = (command: Record<string, unknown>) => { ok: true; result?: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

function harness(options: { send?: Send; history?: SessionEvent[]; lastSeq?: number; subscribe?: "ok" | "unknown" } = {}) {
  const out: string[] = []
  const err: string[] = []
  const sent: Array<Record<string, unknown>> = []
  let handler: ((event: SessionEvent) => void) | undefined
  let interrupt: (() => void) | undefined
  const timers: Array<{ ms: number; callback: () => void; cancelled: boolean }> = []
  const deps: AutomationDeps = {
    client: {
      send: async (command: Record<string, unknown>) => (sent.push(command), options.send?.(command) ?? { ok: true }),
      subscribe: async () => {
        if (options.subscribe === "unknown") return { ok: false, error: { code: "unknown_session", message: "unknown session" } }
        for (const event of options.history ?? []) handler?.(event)
        return { ok: true, result: { lastSeq: options.lastSeq ?? options.history?.at(-1)?.seq ?? 0 } }
      },
    } as never,
    listen: (next) => void (handler = next),
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    cwd: "/work/app",
    now: () => NOW,
    onInterrupt: (callback) => void (interrupt = callback),
    setTimer: (ms, callback) => {
      const timer = { ms, callback, cancelled: false }
      timers.push(timer)
      return { cancel: () => void (timer.cancelled = true) }
    },
  }
  return { deps, out, err, sent, push: (event: SessionEvent) => handler?.(event), interrupt: () => interrupt?.(), timers }
}

const sessionId = ids("session")
let seq = 0
const ev = (patch: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...patch }) as SessionEvent
const lines = (out: string[]) => out.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))

function summary(patch: Record<string, unknown> = {}) {
  return { sessionId, title: "fix flaky test", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 3_600_000, lastSeq: 4, state: "generating", queued: 0, ...patch }
}

describe("output formatting", () => {
  test("session list: human rows, JSON envelope, directory scoping and --all", async () => {
    const send: Send = () => ({ ok: true, result: { sessions: [summary(), summary({ sessionId: ids("session"), title: "", state: "idle" })] } })
    const human = harness({ send })
    expect(await runAutomation(parsed("session", "list"), human.deps)).toBe(0)
    expect(human.out.join("")).toContain("generating")
    expect(human.out.join("")).toContain("  1h  fix flaky test\n")
    expect(human.out.join("")).toContain("untitled")
    expect(human.out.join("")).not.toContain("(/work/app)")
    expect(human.sent[0]).toEqual({ type: "session.list", limit: 50, directory: "/work/app", roots: true })
    const all = harness({ send })
    await runAutomation(parsed("session", "list", "--all"), all.deps)
    expect(all.out.join("")).not.toContain("(/work/app)")
    expect(all.sent[0]).toEqual({ type: "session.list", limit: 50, directory: "/work/app", roots: false })
    const global = harness({ send })
    await runAutomation(parsed("session", "list", "--all-projects"), global.deps)
    expect(global.out.join("")).toContain("(/work/app)")
    expect(global.sent[0]).toEqual({ type: "session.list", limit: 50, roots: true })
    const json = harness({ send })
    await runAutomation(parsed("session", "list", "--json"), json.deps)
    expect(lines(json.out)).toEqual([{ schema: SCHEMA, kind: "result", command: "session.list", data: { sessions: expect.any(Array) } }])
    expect(sessionRows([], NOW, false)).toBe("no sessions\n")
  })

  test("session create prints only the id and JSON carries it", async () => {
    const send: Send = () => ({ ok: true, result: { sessionId } })
    const human = harness({ send })
    expect(await runAutomation(parsed("session", "create", "--title", "T"), human.deps)).toBe(0)
    expect(human.out).toEqual([`${sessionId}\n`])
    expect(human.sent[0]).toEqual({ type: "session.create", directory: "/work/app", title: "T" })
    const json = harness({ send })
    await runAutomation(parsed("session", "create", "--json"), json.deps)
    expect(lines(json.out)[0]).toEqual({ schema: SCHEMA, kind: "result", command: "session.create", data: { sessionId } })
  })

  test("session send --async reports the queued id", async () => {
    const queueId = ids("queue")
    const send: Send = () => ({ ok: true, result: { queueId } })
    const human = harness({ send })
    expect(await runAutomation(parsed("session", "send", sessionId, "hello", "world", "--async"), human.deps)).toBe(0)
    expect(human.out).toEqual([`queued ${queueId}\n`])
    expect(human.sent[0]).toEqual({ type: "user.submit", sessionId, text: "hello world", attachments: [] })
    const json = harness({ send })
    await runAutomation(parsed("session", "send", sessionId, "hi", "--json", "--async"), json.deps)
    expect(lines(json.out)[0]).toMatchObject({ kind: "result", data: { sessionId, queueId } })
  })

  test("memory, loop and usage formatting", async () => {
    const memory = { memoryId: ids("memory"), scope: "project", directory: "/work/app", text: "use pnpm\nnever npm", category: "tooling", status: "saved", source: "user", createdAt: 1, updatedAt: 1 }
    const loop = { loopId: ids("loop"), name: "watch CI", directory: "/work/app", objective: "o", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "monitor" }, state: "active", sessionId, runs: 2, history: [], createdAt: 1, updatedAt: 1 }
    expect(memoryRows([memory as never])).toBe(`${memory.memoryId}  project  saved     [tooling] use pnpm never npm\n`)
    expect(loopRows([loop as never])).toContain("active       every 1h     runs 2  watch CI")
    expect(memoryRows([])).toBe("no memories\n")
    expect(loopRows([])).toBe("no loops\n")
    const report = { from: "a", to: "b", days: [{ day: "d", input: 1_000_000, output: 200_000, reasoning: 0, cacheRead: 300_000, cacheWrite: 0, costMicros: 3_210_000, costUnknownCalls: 2, calls: 40, sessions: 3 }], models: [{ provider: "codex", model: "gpt-5.6", input: 1_000_000, output: 200_000, calls: 40, costMicros: 0 }], quotas: [], sessions: 3 }
    // The headline is the sum of the model rows; cached tokens are named apart instead of inflating it.
    expect(usageText(report as never, 30).split("\n")[0]).toBe("last 30 days: 1.2M tokens (+300K cached) · 40 calls · 3 sessions · cost $3.21 (+2 unpriced)")
    expect(usageText(report as never, 30).split("\n")[1]).toContain("1.2M tokens")
    expect(usageText({ ...report, days: [{ ...report.days[0]!, cacheRead: 0, reasoning: 50_000 }] } as never, 30).split("\n")[0]).toContain("1.2M tokens (+50K reasoning) · 40 calls")
    expect(usageText(report as never, 30)).toContain("codex/gpt-5.6")
  })

  test("usage sends a local-day range and JSON returns the whole report", async () => {
    const report = { from: "x", to: "y", days: [], models: [], quotas: [] }
    const h = harness({ send: () => ({ ok: true, result: report }) })
    expect(await runAutomation(parsed("usage", "--days", "7", "--json"), h.deps)).toBe(0)
    const sent = h.sent[0] as { from: string; to: string }
    expect(sent.to >= sent.from).toBe(true)
    expect(lines(h.out)[0]).toEqual({ schema: SCHEMA, kind: "result", command: "usage", data: report })
  })

  test("memory add scopes to the project directory or the user", async () => {
    const send: Send = () => ({ ok: true, result: { memoryId: "mem_1" } })
    const project = harness({ send })
    await runAutomation(parsed("memory", "add", "fact"), project.deps)
    expect(project.sent[0]).toEqual({ type: "memory.add", scope: "project", directory: "/work/app", text: "fact" })
    const user = harness({ send })
    await runAutomation(parsed("memory", "add", "--user", "--category", "style", "terse"), user.deps)
    // The directory only picks the profile a user memory belongs to.
    expect(user.sent[0]).toEqual({ type: "memory.add", scope: "user", directory: "/work/app", text: "terse", category: "style" })
    expect(user.out).toEqual(["saved mem_1\n"])
  })

  test("loop create and control send the mapped commands", async () => {
    const loop = { loopId: "loop_1", state: "active" }
    const create = harness({ send: () => ({ ok: true, result: { loop } }) })
    await runAutomation(parsed("loop", "create", "--every", "1h", "--goal", "--now", "keep CI green"), create.deps)
    expect(create.sent[0]).toEqual({ type: "loop.create", name: "keep CI green", directory: "/work/app", objective: "keep CI green", trigger: { kind: "interval", everyMs: 3_600_000 }, budget: { mode: "goal" }, runNow: true })
    expect(create.out).toEqual(["loop_1  active\n"])
    const control = harness({ send: () => ({ ok: true, result: { loop: { ...loop, state: "paused" } } }) })
    await runAutomation(parsed("loop", "pause", "loop_1"), control.deps)
    expect(control.sent[0]).toEqual({ type: "loop.control", loopId: "loop_1", action: "pause" })
    expect(control.out).toEqual(["pause loop_1  paused\n"])
  })

  test("loop fire sends loop.fire with the note and says whether the run started or waits", async () => {
    const started = harness({ send: () => ({ ok: true, result: { loop: { loopId: "loop_1", state: "running" }, queued: false } }) })
    await runAutomation(parsed("loop", "fire", "loop_1", "--note", "CI failed"), started.deps)
    expect(started.sent[0]).toEqual({ type: "loop.fire", loopId: "loop_1", note: "CI failed" })
    expect(started.out).toEqual(["fire loop_1  started  running\n"])
    const queued = harness({ send: () => ({ ok: true, result: { loop: { loopId: "loop_1", state: "running" }, queued: true } }) })
    await runAutomation(parsed("loop", "fire", "loop_1"), queued.deps)
    expect(queued.sent[0]).toEqual({ type: "loop.fire", loopId: "loop_1" })
    expect(queued.out).toEqual(["fire loop_1  queued (a run is in progress)  running\n"])
  })

  test("loop fire reports a refusal with its message and a failing exit code", async () => {
    const refused = harness({ send: () => ({ ok: false, error: { code: "invalid_command", message: "[DAEMON]: loop_1 is not an external loop" } }) })
    const code = await runAutomation(parsed("loop", "fire", "loop_1"), refused.deps)
    expect(code).not.toBe(0)
    expect(refused.err.join("")).toContain("loop_1 is not an external loop")
  })
})

describe("storage output", () => {
  const report = {
    dbBytes: 1.2 * 1024 ** 3, walBytes: 12 * 1024 ** 2, blobBytes: 5.6 * 1024 ** 3, blobs: 312, orphanBlobs: 4, orphanBytes: 120 * 1024 ** 2, sessions: 87, events: 84_120,
    eventBytes: 0.9 * 1024 ** 3, engineBytes: 0.2 * 1024 ** 3, otherBytes: 0.1 * 1024 ** 3, freeBytes: 20 * 1024 ** 2, autoVacuum: "incremental",
    topSessions: [{ sessionId, title: "big one", directory: "/work/app", updatedAt: NOW - 3 * 86_400_000, bytes: 4.1 * 1024 ** 3 }],
  }

  test("the report prints where the disk goes, and JSON carries it unchanged", async () => {
    const send: Send = () => ({ ok: true, result: report })
    const human = harness({ send })
    expect(await runAutomation(parsed("storage"), human.deps)).toBe(0)
    expect(human.sent[0]).toEqual({ type: "storage.report" })
    const text = human.out.join("")
    expect(text).toContain("disk: 6.8 GB (database 1.2 GB · wal 12.0 MB · blobs 5.6 GB in 312 files)")
    expect(text).toContain("orphaned blobs: 4 (120.0 MB)")
    expect(text).toContain("87 sessions · 84.1K events")
    expect(text).toContain("     4.1 GB    3d  big one  (/work/app)")
    const json = harness({ send })
    await runAutomation(parsed("storage", "--json"), json.deps)
    expect(lines(json.out)[0]).toEqual({ schema: SCHEMA, kind: "result", command: "storage", data: report })
  })

  test("--clean sends the mapped command and prints removed or would-remove text", async () => {
    const result = { dryRun: false, olderThanDays: 90, sessionsRemoved: 12, eventsRemoved: 3_400, blobsRemoved: 4, bytesReclaimed: 3.5 * 1024 ** 3, protectedSessions: 2, vacuumed: false }
    const real = harness({ send: () => ({ ok: true, result }) })
    await runAutomation(parsed("storage", "--clean", "--older-than", "90d"), real.deps)
    expect(real.sent[0]).toEqual({ type: "storage.clean", olderThanDays: 90 })
    expect(real.out).toEqual(["removed 12 sessions older than 90 days (3,400 events), 4 blobs · freed 3.5 GB · kept 2 protected\n"])
    const dry = harness({ send: () => ({ ok: true, result: { ...result, dryRun: true } }) })
    await runAutomation(parsed("storage", "--clean", "--dry-run"), dry.deps)
    expect(dry.sent[0]).toEqual({ type: "storage.clean", dryRun: true })
    expect(dry.out[0]).toStartWith("would remove 12 sessions")
    expect(dry.out[0]).toContain("≈3.5 GB")
    const vacuum = harness({ send: () => ({ ok: true, result: { ...result, olderThanDays: 0, sessionsRemoved: 0, vacuumed: true, protectedSessions: 0 } }) })
    await runAutomation(parsed("storage", "--vacuum"), vacuum.deps)
    expect(vacuum.sent[0]).toEqual({ type: "storage.clean", olderThanDays: 0, vacuum: true })
    expect(vacuum.out[0]).toContain("no sessions")
    expect(vacuum.out[0]).toContain("vacuumed")
  })

  test("a daemon error exits 1", async () => {
    const h = harness({ send: () => ({ ok: false, error: { code: "invalid_command", message: "old daemon" } }) })
    expect(await runAutomation(parsed("storage"), h.deps)).toBe(1)
  })

  test("the report adds the per-turn, snapshot and compression lines when the daemon sends them", async () => {
    const full = { ...report, turns: 400, snapshotBytes: 3 * 1024 ** 2, snapshotObjects: 80, snapshotRefs: 220, compressedRows: 5_000, savedBytes: 250 * 1024 ** 2, trashBytes: 2 * 1024 ** 2, eventTypes: [{ type: "item.completed", count: 9_000, bytes: 500 * 1024 ** 2 }] }
    const h = harness({ send: () => ({ ok: true, result: full }) })
    await runAutomation(parsed("storage"), h.deps)
    const text = h.out.join("")
    expect(text).toContain("per turn: 2.3 MB of events · 400 turns")
    expect(text).toContain("events by size: item.completed 500.0 MB (9,000)")
    expect(text).toContain("undo snapshots: 3.0 MB · 80 shared objects for 220 references")
    expect(text).toContain("compression: 5,000 compact rows · saves 250.0 MB")
    expect(text).toContain("worktree trash: 2.0 MB")
  })

  test("--compact and --worktrees map to the daemon command and print what moved", async () => {
    const result = { dryRun: true, olderThanDays: 0, sessionsRemoved: 0, eventsRemoved: 0, blobsRemoved: 0, bytesReclaimed: 0, protectedSessions: 0, vacuumed: false, compactedRows: 1_200, compactComplete: false, deltaEventsRemoved: 30_000, worktreesRemoved: 3, worktreeBytes: 900 * 1024 ** 2 }
    const h = harness({ send: () => ({ ok: true, result }) })
    await runAutomation(parsed("storage", "--compact", "--delta-idle", "7d", "--worktrees", "--worktree-idle", "30d", "--dry-run"), h.deps)
    expect(h.sent[0]).toEqual({ type: "storage.clean", olderThanDays: 0, dryRun: true, compact: true, deltaIdleDays: 7, worktrees: true, worktreeIdleDays: 30 })
    const text = h.out.join("")
    expect(text).toContain("would move 1,200 rows to compact form (more remain: run again)")
    expect(text).toContain("would drop 30K streaming deltas")
    expect(text).toContain("would remove 3 worktrees/trash entries · 900.0 MB")
  })

  test("--worktrees alone lists them, with the reason each one is kept", async () => {
    const worktrees = { worktrees: [{ directory: "/w/a", branch: "mend/a", bytes: 4 * 1024 ** 2, state: "merged", clean: true, idleDays: 20, occupied: false, removable: true }, { directory: "/w/b", branch: "mend/b", bytes: 9 * 1024 ** 2, state: "unmerged", clean: true, idleDays: 1, occupied: false, removable: false, keep: "branch has commits that are not merged" }], totalBytes: 13 * 1024 ** 2, removableBytes: 4 * 1024 ** 2, trashBytes: 0, loopBytes: 0 }
    const h = harness({ send: () => ({ ok: true, result: worktrees }) })
    expect(await runAutomation(parsed("storage", "--worktrees", "--worktree-idle", "14d"), h.deps)).toBe(0)
    expect(h.sent[0]).toEqual({ type: "storage.worktrees", idleDays: 14 })
    const text = h.out.join("")
    expect(text).toContain("worktrees: 13.0 MB in 2 · removable 4.0 MB")
    expect(text).toContain("removable  merged   mend/a  /w/a")
    expect(text).toContain("kept       unmerged mend/b  /w/b  (branch has commits that are not merged)")
  })

  test("flag combinations that make no sense are refused", () => {
    expect(failure("storage", "--delta-idle", "3d")).toContain("--delta-idle needs --compact")
    expect(failure("storage", "--worktree-idle", "3d")).toContain("--worktree-idle needs --worktrees")
    expect(failure("storage", "--compact", "--delta-idle", "soon")).toContain("--delta-idle needs a number of days")
    expect(failure("storage", "--dry-run")).toContain("need --clean or --compact")
    expect(parsed("storage", "--compact", "--dry-run")).toMatchObject({ clean: true, compact: true, dryRun: true, olderThanDays: 0 })
    expect(parsed("storage", "--worktrees")).toMatchObject({ clean: false, worktrees: true })
  })
})

describe("exit codes and errors", () => {
  test("daemon errors exit 1 with terse stderr, or a JSON error envelope on stdout", async () => {
    const send: Send = () => ({ ok: false, error: { code: "internal", message: "boom" } })
    const human = harness({ send })
    expect(await runAutomation(parsed("session", "list"), human.deps)).toBe(EXIT.failed)
    expect(human.err).toEqual(["error: boom\n"])
    expect(human.out).toEqual([])
    const json = harness({ send })
    expect(await runAutomation(parsed("session", "list", "--json"), json.deps)).toBe(EXIT.failed)
    expect(lines(json.out)).toEqual([{ schema: SCHEMA, kind: "error", command: "session.list", error: { code: "failed", message: "boom" } }])
  })

  test("sending to an unknown session says so", async () => {
    const h = harness({ send: () => ({ ok: false, error: { code: "unknown_session", message: "x" } }) })
    expect(await runAutomation(parsed("session", "send", sessionId, "hi", "--async"), h.deps)).toBe(1)
    expect(h.err).toEqual([`error: unknown session ${sessionId}\n`])
  })

  test("the exit code table is the documented one", () => {
    expect(EXIT).toEqual({ ok: 0, failed: 1, stopped: 2, timeout: 3, needsInput: 4, denied: 5, usage: 64 })
  })
})

describe("session wait, events and cancel", () => {
  test("wait returns immediately when the persisted events say idle with nothing queued", async () => {
    seq = 0
    const h = harness({ history: [ev({ type: "foreground.state", state: "generating" }), ev({ type: "foreground.state", state: "idle" })] })
    expect(await runAutomation(parsed("session", "wait", sessionId, "--idle"), h.deps)).toBe(0)
    expect(h.out).toEqual(["idle\n"])
  })

  test("wait blocks while a turn runs and settles on the live idle event", async () => {
    seq = 0
    const h = harness({ history: [ev({ type: "queue.changed", queue: [] }), ev({ type: "foreground.state", state: "generating" })] })
    let finished: number | undefined
    const waiting = runAutomation(parsed("session", "wait", sessionId, "--json", "--idle"), h.deps).then((code) => (finished = code))
    await Bun.sleep(5)
    expect(finished).toBeUndefined()
    h.push(ev({ type: "foreground.state", state: "tool" }))
    await Bun.sleep(1)
    expect(finished).toBeUndefined()
    h.push(ev({ type: "foreground.state", state: "idle" }))
    expect(await waiting).toBe(0)
    expect(lines(h.out)).toEqual([{ schema: SCHEMA, kind: "result", command: "session.wait", data: { sessionId, status: "idle" } }])
  })

  test("idle with queued prompts is not done until the queue drains", async () => {
    seq = 0
    const h = harness({ history: [ev({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "next", attachments: 0 }] }), ev({ type: "foreground.state", state: "idle" })] })
    let finished: number | undefined
    const waiting = runAutomation(parsed("session", "wait", sessionId, "--idle"), h.deps).then((code) => (finished = code))
    await Bun.sleep(5)
    expect(finished).toBeUndefined()
    h.push(ev({ type: "queue.changed", queue: [] }))
    h.push(ev({ type: "foreground.state", state: "idle" }))
    expect(await waiting).toBe(0)
  })

  test("wait times out with exit 3 and a timeout status", async () => {
    seq = 0
    const h = harness({ history: [ev({ type: "foreground.state", state: "generating" })] })
    const waiting = runAutomation(parsed("session", "wait", sessionId, "--timeout", "5", "--json"), h.deps)
    await Bun.sleep(5)
    expect(h.timers[0]!.ms).toBe(5_000)
    h.timers[0]!.callback()
    expect(await waiting).toBe(EXIT.timeout)
    expect(lines(h.out)[0]).toMatchObject({ kind: "result", data: { status: "timeout" } })
    const human = harness({ history: [ev({ type: "foreground.state", state: "generating" })] })
    const second = runAutomation(parsed("session", "wait", sessionId, "--timeout", "1"), human.deps)
    await Bun.sleep(5)
    human.timers[0]!.callback()
    expect(await second).toBe(3)
    expect(human.err).toEqual(["error: timed out waiting for a terminal result\n"])
  })

  test("wait on an unknown session fails with exit 1", async () => {
    const h = harness({ subscribe: "unknown" })
    expect(await runAutomation(parsed("session", "wait", sessionId), h.deps)).toBe(1)
    expect(h.err).toEqual([`error: unknown session ${sessionId}\n`])
  })

  test("wait on a session in error state fails", async () => {
    seq = 0
    const h = harness({ history: [ev({ type: "foreground.state", state: "error" })] })
    expect(await runAutomation(parsed("session", "wait", sessionId), h.deps)).toBe(EXIT.failed)
  })

  test("events prints the history as NDJSON with the schema, or one terse line each", async () => {
    seq = 0
    const history = [ev({ type: "session.created", directory: "/x", title: "" }), ev({ type: "queue.added", queueId: ids("queue"), text: "hello there", attachments: [] })]
    const json = harness({ history })
    expect(await runAutomation(parsed("session", "events", sessionId, "--json"), json.deps)).toBe(0)
    expect(lines(json.out).map((l) => [l.schema, l.kind, l.event.seq])).toEqual([[SCHEMA, "event", 1], [SCHEMA, "event", 2]])
    const human = harness({ history })
    await runAutomation(parsed("session", "events", sessionId), human.deps)
    expect(human.out).toEqual(["#1 session.created\n", "#2 queue.added hello there\n"])
  })

  test("events --follow streams live events after the history until interrupted", async () => {
    seq = 0
    const h = harness({ history: [ev({ type: "session.created", directory: "/x", title: "" })] })
    const following = runAutomation(parsed("session", "events", sessionId, "--follow", "--json"), h.deps)
    await Bun.sleep(5)
    h.push(ev({ type: "foreground.state", state: "generating" }))
    h.push(ev({ type: "foreground.state", state: "idle" }))
    expect(lines(h.out).map((l) => l.event.seq)).toEqual([1, 2, 3])
    h.interrupt()
    expect(await following).toBe(0)
  })

  test("events without --follow ignores live events beyond the last seq", async () => {
    seq = 0
    const h = harness({ history: [ev({ type: "session.created", directory: "/x", title: "" })] })
    await runAutomation(parsed("session", "events", sessionId, "--json"), h.deps)
    h.push(ev({ type: "foreground.state", state: "idle" }))
    expect(lines(h.out).length).toBe(1)
  })

  test("cancel targets the active turn found in the history and is a no-op when idle", async () => {
    seq = 0
    const turnId = ids("turn")
    const busy = harness({ history: [ev({ type: "turn.started", turnId, queueId: ids("queue") })], send: () => ({ ok: true }) })
    expect(await runAutomation(parsed("session", "cancel", sessionId), busy.deps)).toBe(0)
    expect(busy.sent[0]).toEqual({ type: "turn.cancel", sessionId, turnId })
    expect(busy.out).toEqual([`cancelled ${turnId}\n`])
    seq = 0
    const idle = harness({ history: [ev({ type: "turn.started", turnId, queueId: ids("queue") }), ev({ type: "turn.completed", turnId })] })
    expect(await runAutomation(parsed("session", "cancel", sessionId, "--json"), idle.deps)).toBe(0)
    expect(idle.sent).toEqual([])
    expect(lines(idle.out)[0]).toMatchObject({ data: { cancelled: false } })
  })

  test("foldSession derives foreground, queue and active turn", () => {
    seq = 0
    const turnId = ids("turn")
    expect(foldSession([ev({ type: "turn.started", turnId, queueId: ids("queue") }), ev({ type: "foreground.state", state: "tool" }), ev({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "a", attachments: 0 }] })])).toEqual({ foreground: "tool", queued: 1, activeTurn: turnId })
    expect(foldSession([])).toEqual({ foreground: "idle", queued: 0, activeTurn: undefined })
  })
})

// ---------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("integration with a real daemon (faux engine)", () => {
  test("create → send --wait → events → wait", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-auto-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    let handler: ((event: SessionEvent) => void) | undefined
    const client = createClient({ socketPath: daemon.socketPath, name: "auto-test", onEvent: (event) => handler?.(event) })
    await client.connect()
    cleanups.push(() => client.close())
    const run = async (...argv: string[]) => {
      const out: string[] = []
      const err: string[] = []
      const code = await runAutomation(parsed(...argv), { client, listen: (next) => void (handler = next), out: { write: (t) => out.push(t) }, err: { write: (t) => err.push(t) }, cwd: "/work/app", now: Date.now, onInterrupt: () => {} })
      return { code, out: out.join(""), err: err.join("") }
    }

    const created = await run("session", "create", "--title", "auto", "--json")
    expect(created.code).toBe(0)
    const id = lines([created.out])[0].data.sessionId as string
    expect(id).toStartWith("ses")

    const sent = await run("session", "send", id, "say hello", "--wait", "--json", "--timeout", "20")
    expect(sent.code).toBe(0)
    const sentLines = lines([sent.out])
    expect(sentLines.every((l) => l.schema === SCHEMA)).toBe(true)
    expect(sentLines.some((l) => l.kind === "event" && l.event.type === "turn.completed")).toBe(true)
    expect(sentLines.at(-1)).toMatchObject({ kind: "result", command: "session.send", data: { sessionId: id, exitCode: 0, status: "completed" } })

    const events = await run("session", "events", id, "--json")
    expect(events.code).toBe(0)
    const types = lines([events.out]).map((l) => l.event.type as string)
    expect(types[0]).toBe("session.created")
    expect(types).toContain("queue.added")
    expect(types).toContain("turn.completed")
    const seqs = lines([events.out]).map((l) => l.event.seq as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    const after = await run("session", "events", id, "--after", String(seqs.at(-1)! - 1), "--json")
    expect(lines([after.out]).length).toBe(1)

    const waited = await run("session", "wait", id, "--timeout", "10")
    expect(waited).toMatchObject({ code: 0, out: "completed\n" })

    const listed = await run("session", "list", "--all", "--json")
    expect(lines([listed.out])[0].data.sessions.some((s: { sessionId: string }) => s.sessionId === id)).toBe(true)

    const missing = await run("session", "wait", ids("session"), "--timeout", "2")
    expect(missing.code).toBe(1)
    expect(missing.err).toContain("unknown session")
  })
})

describe("package commands", () => {
  const pkg = { name: "acme", source: "user", key: "user:acme", dir: "/d/packages/acme", enabled: true, manifest: { name: "acme", version: "1.2.0", description: "Acme helpers" }, contents: { tools: 1, skills: 0, commands: 2, themes: 0, mcp: true } }

  test("parsing: user scope unless --project; install takes a source and --replace", () => {
    expect(parsed("package", "list")).toMatchObject({ kind: "package.list" })
    expect(parsed("package", "install", "github:acme/tools#v1", "--replace")).toMatchObject({ kind: "package.install", source: "github:acme/tools#v1", scope: "user", replace: true })
    expect(parsed("package", "remove", "acme", "--project")).toMatchObject({ kind: "package.remove", name: "acme", scope: "project" })
    expect(parsed("package", "disable", "acme")).toMatchObject({ kind: "package.enable", name: "acme", scope: "user", enabled: false, switch: false })
    expect(parsed("package", "enable", "project:retro", "--switch")).toMatchObject({ kind: "package.enable", name: "retro", scope: "project", enabled: true, switch: true })
    expect(parsed("package", "remove", "acme")).toMatchObject({ kind: "package.remove", purge: false })
    expect(parsed("package", "remove", "acme", "--purge")).toMatchObject({ kind: "package.remove", name: "acme", purge: true })
    expect(parsed("package", "restore", "acme")).toMatchObject({ kind: "package.restore", name: "acme", scope: "user" })
    expect(failure("package", "install")).toContain("needs <folder")
    expect(failure("package", "zap")).toContain('unknown package command "zap"')
    expect(helpText("package")).toContain("enable|disable <name>")
  })

  test("each command maps to its daemon command and prints the package rows", async () => {
    const h = harness({ send: () => ({ ok: true, result: { directory: "/work/app", packages: [pkg, { ...pkg, name: "old", key: "project:old", source: "project", enabled: false, manifest: undefined, problem: "no mendcode-package.json", contents: { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false } }] } }) })
    expect(await runAutomation(parsed("package", "list"), h.deps)).toBe(0)
    expect(h.sent[0]).toEqual({ type: "packages.list", directory: "/work/app" })
    expect(h.out.join("")).toBe("user:acme@1.2.0  on       1 tool, 2 commands, mcp  Acme helpers\nproject:old  problem  empty  (no mendcode-package.json)\n")
    const install = harness({ send: () => ({ ok: true, result: { packages: [pkg] } }) })
    await runAutomation(parsed("package", "install", "./acme", "--project"), install.deps)
    expect(install.sent[0]).toEqual({ type: "packages.install", directory: "/work/app", source: "./acme", scope: "project" })
    expect(install.out.join("")).toStartWith("installed\nuser:acme@1.2.0")
    const off = harness({ send: () => ({ ok: true, result: { packages: [{ ...pkg, enabled: false }] } }) })
    await runAutomation(parsed("package", "disable", "acme"), off.deps)
    expect(off.sent[0]).toEqual({ type: "packages.enable", directory: "/work/app", key: "user:acme", enabled: false })
    expect(off.out.join("")).toStartWith("disabled user:acme\nuser:acme@1.2.0  off")
    const refused = harness({ send: () => ({ ok: false, error: { code: "invalid_command", message: "[PACKAGES]: refused" } }) })
    expect(await runAutomation(parsed("package", "install", "./x"), refused.deps)).toBe(1)
    expect(refused.err.join("")).toContain("refused")
  })
})

describe("recipe commands", () => {
  const report = {
    recipes: [
      { name: "balanced", file: "/b/recipes/balanced.json", source: "builtin", description: "Everyday work", version: "1", roles: {} },
      { name: "broken", file: "/u/recipes/broken.json", source: "user", description: "", roles: {}, problem: "invalid JSON" },
    ],
    active: "balanced",
  }

  test("parsing and help", () => {
    expect(parsed("recipe", "list")).toMatchObject({ kind: "recipe.list" })
    expect(parsed("recipe", "apply", "deep")).toMatchObject({ kind: "recipe.apply", name: "deep" })
    expect(failure("recipe", "apply")).toContain("needs <name>")
    expect(failure("recipe", "zap")).toContain('unknown recipe command "zap"')
    expect(helpText("recipe")).toContain("apply <name>")
  })

  test("list marks the active recipe and shows problems; apply sends the name for this directory", async () => {
    const h = harness({ send: () => ({ ok: true, result: report }) })
    expect(await runAutomation(parsed("recipe", "list"), h.deps)).toBe(0)
    expect(h.sent[0]).toEqual({ type: "recipes.list", directory: "/work/app" })
    expect(h.out.join("")).toBe("* balanced         builtin  Everyday work  v1\n  broken           user     problem: invalid JSON\n")
    const apply = harness({ send: () => ({ ok: true, result: report }) })
    await runAutomation(parsed("recipe", "apply", "balanced"), apply.deps)
    expect(apply.sent[0]).toEqual({ type: "recipes.apply", directory: "/work/app", name: "balanced" })
    expect(apply.out.join("")).toStartWith("applied balanced\n")
    const refused = harness({ send: () => ({ ok: false, error: { code: "invalid_command", message: "[DAEMON]: this engine chooses its own model" } }) })
    expect(await runAutomation(parsed("recipe", "apply", "deep"), refused.deps)).toBe(1)
  })
})

describe("profile commands", () => {
  test("parsing", () => {
    expect(parsed("profile")).toMatchObject({ kind: "profile.list" })
    expect(parsed("profile", "add", "company", "~/Code/acme", "./vendor", "--permission", "edits")).toMatchObject({ kind: "profile.add", name: "company", folders: ["~/Code/acme", "./vendor"], permission: "edits" })
    expect(failure("profile", "add", "personal", "/x")).toContain("needs a name")
    expect(failure("profile", "add", "company")).toContain("at least one folder")
    expect(failure("profile", "add", "company", "/x", "--permission", "root")).toContain("--permission")
    expect(failure("profile", "remove")).toContain("needs <name>")
    expect(helpText("profile")).toContain("add <name> <folder>")
  })

  test("add writes the profiles setting with folders resolved from here, and marks the profile of this directory", async () => {
    let settings: Record<string, unknown> = {}
    const h = harness({
      send: (command: Record<string, unknown>) => {
        if (command.type === "settings.get") return { ok: true, result: { settings } }
        if (command.type === "settings.set") {
          settings = { ...settings, ...(command.patch as Record<string, unknown>) }
          return { ok: true, result: { settings } }
        }
        return undefined
      },
    })
    expect(await runAutomation(parsed("profile", "add", "company", ".", "~/Code/acme", "--permission", "edits"), h.deps)).toBe(0)
    expect(settings.profiles).toEqual([{ name: "company", directories: ["/work/app", "~/Code/acme"], defaultPermission: "edits" }])
    expect(h.out.join("")).toBe("  personal         everything else\n* company          /work/app, ~/Code/acme  · edits\n")
    const removed = harness({ send: (command: Record<string, unknown>) => (command.type === "settings.get" ? { ok: true, result: { settings } } : { ok: true }) })
    expect(await runAutomation(parsed("profile", "remove", "company"), removed.deps)).toBe(0)
    expect(removed.sent.find((command) => command.type === "settings.set")).toEqual({ type: "settings.set", patch: { profiles: null } })
    expect(await runAutomation(parsed("profile", "remove", "nope"), removed.deps)).toBe(1)
  })
})


test("permissions control-plane commands validate v1 aliases and dispatch daemon operations", async () => {
  expect(parsed("control-plane", "permissions")).toMatchObject({ kind: "permissions", operation: "status" })
  for (const mode of ["approval", "smart", "full_access", "ask", "edits", "full"]) expect(parsed("control-plane", "permissions", "set-default", mode)).toMatchObject({ kind: "permissions", operation: "set-default", mode })
  expect(parsed("control-plane", "permissions", "set-reviewer-role", "small")).toMatchObject({ role: "small" })
  expect(parseAutomation(["control-plane", "permissions", "set-default", "invalid"])).toMatchObject({ ok: false })
  expect(parseAutomation(["control-plane", "permissions", "set-reviewer-role", "unknown"])).toMatchObject({ ok: false })
  const h = harness({ send: () => ({ ok: true, result: { mode: "smart", reviewerRole: "small" } }) })
  expect(await runAutomation(parsed("control-plane", "permissions", "status", "--json"), h.deps)).toBe(0)
  expect(h.sent[0]).toEqual({ type: "permissions.status" })
  expect(lines(h.out)[0]).toMatchObject({ kind: "result", data: { mode: "smart", reviewerRole: "small" } })
  expect(await runAutomation(parsed("control-plane", "permissions", "set-default", "full_access"), h.deps)).toBe(0)
  expect(h.sent.at(-1)).toEqual({ type: "permissions.set-default", mode: "full_access" })
  expect(await runAutomation(parsed("control-plane", "permissions", "set-reviewer-role", "small"), h.deps)).toBe(0)
  expect(h.sent.at(-1)).toEqual({ type: "permissions.set-reviewer-role", role: "small" })
})
