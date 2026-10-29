import { expect, test } from "bun:test"
import { createIdFactory, type LoopSnapshot } from "@mendcode/protocol"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { textWidth } from "../src/view/wrap"
import { renderLoopMonitor } from "../src/view/loop-monitor"

const ids = createIdFactory()
const NOW = Date.UTC(2026, 9, 1, 12)
export const snapshot: LoopSnapshot = {
  loop: { loopId: ids("loop"), sessionId: ids("session"), name: "CI Watch", directory: "/repo", objective: "Inspect local checks and report failing tests", state: "active", trigger: { kind: "interval", everyMs: 60_000 }, budget: { mode: "monitor" }, runs: 1, history: [{ run: 1, startedAt: NOW - 1000, endedAt: NOW, outcome: "completed", checkpoint: { status: "continue", summary: "checked local files" } }], createdAt: NOW - 2000, updatedAt: NOW, nextWakeAt: NOW + 60_000 },
  children: [], scheduler: { kind: "integrated", nextWakeAt: NOW + 60_000, overdue: false }, events: [{ seq: 1, at: NOW, type: "checkpoint", title: "checked local files", run: 1 }],
}
function parsed(...args: string[]) {
  const result = parseAutomation(args)
  if (result.ok !== true) throw new Error(JSON.stringify(result))
  return result.command
}

test("B20 singular, plural and control-plane aliases cover all nine inventory items", () => {
  for (const prefix of [["loop"], ["loops"], ["control-plane", "loops"]]) {
    expect(parsed(...prefix)).toMatchObject({ kind: "loop.status" })
    for (const name of ["examples", "templates"]) expect(parsed(...prefix, name)).toMatchObject({ kind: "loop.templates" })
    for (const name of ["show", "tail", "monitor", "activate"]) expect(parsed(...prefix, name, snapshot.loop.loopId).kind).toBe(`loop.${name}`)
    expect(parsed(...prefix, "tick")).toMatchObject({ kind: "loop.tick", limit: 1, execute: false, reportOnly: false })
    expect(parsed(...prefix, "draft", "--template", "pr-watch")).toMatchObject({ kind: "loop.draft", template: "pr-watch" })
    expect(parsed(...prefix, "list")).toMatchObject({ kind: "loop.list" })
  }
  expect(parsed("--dir", "/tmp/b20-data", "control-plane", "loops", "status", "--json")).toMatchObject({ kind: "loop.status", dir: "/tmp/b20-data", json: true })
  expect(parsed("help", "loop")).toMatchObject({ kind: "help", topic: "loop" })
})

test("B20 draft overrides and bounded command options use v1 spellings", () => {
  expect(parsed("loops", "draft", "inspect", "local", "tests", "--interval-ms", "120000")).toMatchObject({ name: "inspect", objective: "local tests", trigger: { kind: "interval", everyMs: 120_000 } })
  expect(parsed("loops", "draft", "--name", "nightly", "--objective", "inspect", "--daily-at", "09:00", "--timezone", "America/Panama")).toMatchObject({ trigger: { kind: "daily", at: "09:00", timezone: "America/Panama" } })
  expect(parsed("loops", "monitor", "id", "--once", "--interval-ms", "250")).toMatchObject({ once: true, intervalMs: 250 })
  expect(parsed("loops", "tick", "id", "--execute", "--report-only", "--limit", "3")).toMatchObject({ execute: true, reportOnly: true, limit: 3 })
  expect(parsed("loops", "activate", "id", "--no-service", "--reason", "ready")).toMatchObject({ reason: "ready" })
})

test("B20 rejects invalid or unrelated options before connecting", () => {
  for (const args of [
    ["draft"], ["show"], ["monitor"], ["activate"], ["status", "extra"], ["examples", "--execute"], ["tail", "id", "--limit", "201"], ["tick", "--limit", "0"],
    ["tick", "--execute", "--dry-run"], ["monitor", "id", "--interval-ms", "-1"], ["draft", "--name", "n", "--objective", "o", "--interval-ms", "100"],
    ["draft", "--name", "n", "--objective", "o", "--daily-at", "25:00"], ["draft", "--template", "pr-watch", "--timezone", "Invalid/Zone"],
  ]) expect(parseAutomation(["loops", ...args]).ok).toBe(false)
})

function harness(overrides: Partial<AutomationDeps> = {}) {
  let output = "", errors = ""
  const commands: Parameters<AutomationDeps["client"]["send"]>[0][] = []
  const deps: AutomationDeps = {
    client: { async send(command) { commands.push(command); return { ok: true, result: command.type === "loop.events" ? { events: snapshot.events } : snapshot as unknown as Record<string, unknown> } }, async subscribe() { return { ok: true } } },
    cwd: "/repo", now: () => NOW, listen() {}, onInterrupt() {}, isTTY: false,
    out: { write(text) { output += text } }, err: { write(text) { errors += text } }, ...overrides,
  }
  return { deps, commands, output: () => output, errors: () => errors }
}

test("B20 show and non-TTY monitor print a single snapshot; tail JSON is one event per line", async () => {
  for (const name of ["show", "monitor"]) {
    const h = harness()
    expect(await runAutomation(parsed("loops", name, snapshot.loop.loopId), h.deps)).toBe(0)
    expect(h.commands).toHaveLength(1)
    expect(h.output()).toContain("Scheduler: integrated")
    expect(h.output()).toContain("checked local files")
  }
  const h = harness()
  expect(await runAutomation(parsed("loops", "tail", snapshot.loop.loopId, "--json"), h.deps)).toBe(0)
  expect(h.output().trim().split("\n").map((line) => JSON.parse(line))).toEqual(snapshot.events)
})

test("B20 TTY monitor refreshes sequentially and Ctrl-C cancels future refreshes", async () => {
  let interrupted = () => {}
  const timers: Array<{ callback(): void; cancelled: boolean }> = []
  const frames: unknown[] = []
  const h = harness({ isTTY: true, terminalSize: { width: 100, height: 30 }, drawLoopFrame: (rows) => void frames.push(rows), onInterrupt: (handler) => { interrupted = handler }, setTimer: (_ms, callback) => { const timer = { callback, cancelled: false }; timers.push(timer); return { cancel() { timer.cancelled = true } } } })
  const running = runAutomation(parsed("loops", "monitor", snapshot.loop.loopId), h.deps)
  await Bun.sleep(5)
  expect(frames).toHaveLength(1)
  timers[0]!.callback()
  await Bun.sleep(5)
  expect(frames).toHaveLength(2)
  expect(h.commands).toHaveLength(2)
  interrupted()
  expect(await running).toBe(0)
  expect(timers.at(-1)?.cancelled).toBe(true)
})

test("B20 monitor --once renders one frame and failures preserve daemon exit semantics", async () => {
  const frames: unknown[] = []
  const h = harness({ isTTY: true, drawLoopFrame: (rows) => void frames.push(rows) })
  expect(await runAutomation(parsed("loops", "monitor", snapshot.loop.loopId, "--once"), h.deps)).toBe(0)
  expect(frames).toHaveLength(1)
  h.deps.client.send = async () => ({ ok: false, error: { code: "target_mismatch", message: "unknown loop" } })
  expect(await runAutomation(parsed("loops", "show", snapshot.loop.loopId, "--json"), h.deps)).toBe(1)
  expect(JSON.parse(h.output()).error.code).toBe("target_mismatch")
})

test("B20 monitor grid has borders, header hints and fits every contracted terminal size", () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const rows = renderLoopMonitor(snapshot, width!, height!)
    expect(rows).toHaveLength(height!)
    const plain = rows.map((row) => row.map((span) => span.text).join(""))
    expect(plain.every((row) => textWidth(row) === width && !row.includes("\x1b"))).toBe(true)
    expect(plain[0]).toContain("ctrl-c stop")
    expect(plain.join("\n")).toContain("┌")
    expect(plain.join("\n")).toContain("checked local files")
  }
})

test("B20 tick reports failed, interrupted and timed-out runs through its exit status", async () => {
  for (const [state, timedOut, exit] of [["failed", false, 1], ["interrupted", false, 1], ["running", true, 3], ["active", false, 0]] as const) {
    const h = harness()
    h.deps.client.send = async () => ({ ok: true, result: { results: [{ loopId: snapshot.loop.loopId, state, timedOut, run: 1, summary: "local check" }] } })
    expect(await runAutomation(parsed("loops", "tick", snapshot.loop.loopId, "--execute"), h.deps)).toBe(exit)
    expect(h.output()).toContain(`${state} run=1 local check`)
  }
})
