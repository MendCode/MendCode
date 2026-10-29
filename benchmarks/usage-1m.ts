// Benchmark T08: 1M usage.recorded events over 365 days, 1,000 sessions; then time the /usage query.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"

const EVENTS = Number(process.env.EVENTS ?? 1_000_000)
const SESSIONS = 1_000
const DAY = 86_400_000
const T0 = Date.UTC(2025, 8, 27)
const dir = mkdtempSync(path.join(tmpdir(), "mend-bench-"))
let now = T0
const store = openStore({ dir, now: () => now, dayOf: (at) => new Date(at).toISOString().slice(0, 10) })
const ids = createIdFactory()
const sessions: SessionId[] = []
for (let i = 0; i < SESSIONS; i++) {
  const id = ids("session")
  sessions.push(id)
  store.createSession({ id, directory: "/repo", title: `s${i}` })
}
const turnId = ids("turn")
const t0 = performance.now()
for (let i = 0; i < EVENTS; i++) {
  now = T0 + Math.floor((i / EVENTS) * 365) * DAY
  store.sessionSink.append({
    type: "usage.recorded", sessionId: sessions[i % SESSIONS]!, turnId,
    provider: i % 3 ? "anthropic" : "openai", model: i % 3 ? "sonnet" : "gpt", input: 1_000, output: 100, reasoning: 10, cacheRead: 500, cacheWrite: 0,
  })
}
const insertMs = performance.now() - t0
store.close()
const reopenStart = performance.now()
const reopened = openStore({ dir, now: () => now, dayOf: (at) => new Date(at).toISOString().slice(0, 10) })
const openMs = performance.now() - reopenStart
const coldStart = performance.now()
reopened.usageDaily({ from: "2025-09-27", to: "2026-09-27" })
reopened.usageByModel({ from: "2025-09-27", to: "2026-09-27" })
const coldMs = performance.now() - coldStart
const timings: number[] = []
let days = 0
for (let run = 0; run < 5; run++) {
  const s = performance.now()
  days = reopened.usageDaily({ from: "2025-09-27", to: "2026-09-27" }).length
  reopened.usageByModel({ from: "2025-09-27", to: "2026-09-27" })
  timings.push(performance.now() - s)
}
timings.sort((a, b) => a - b)
const report = reopened.storageReport()
console.log(JSON.stringify({ events: EVENTS, insertSeconds: +(insertMs / 1000).toFixed(1), eventsPerSecond: Math.round(EVENTS / (insertMs / 1000)), days, reopenMs: +openMs.toFixed(1), coldFirstQueryMs: +coldMs.toFixed(2), usageQueryMedianMs: +timings[2]!.toFixed(2), usageQueryMaxMs: +timings[4]!.toFixed(2), dbMB: +(report.dbBytes / 1e6).toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1e6) }))
reopened.close()
rmSync(dir, { recursive: true, force: true })
