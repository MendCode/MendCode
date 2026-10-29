import type { SessionSummary } from "@mendcode/protocol"
import { sgr } from "../../apps/cli/src/ui/theme"
import { createSessionListState, renderSessionList } from "../../apps/cli/src/view/session-list"

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const rows: Array<Partial<SessionSummary> & { title: string; directory: string; ago: number }> = [
  { title: "fix flaky reconnect after suspend", directory: "/Users/dev/Code/MendCodeV2", ago: 20_000, state: "generating" },
  { title: "add usage command", directory: "/Users/dev/Code/MendCodeV2/apps/cli", ago: 5 * MINUTE, state: "waiting_approval" },
  { title: "refactor transcript wrap", directory: "/Users/dev/Code/MendCodeV2/apps/cli/src/view", ago: 3 * HOUR, queued: 2 },
  { title: "", directory: "/Users/dev/Code/repos/codeconfig", ago: 9 * HOUR },
  { title: "review dream scheduler against the v1 behaviour and the new memory contract", directory: "/Users/dev/Code/MendCode/src/mendcode/packages/opencode/src/mend/memory", ago: 2 * DAY, state: "error" },
  { title: "benchmark session replay", directory: "/Users/dev/Code/MendCodeV2/benchmarks", ago: 6 * DAY },
  { title: "spec the compaction panel", directory: "/Users/dev/Code/MendCodeV2/specs", ago: 30 * DAY },
]

const sessions: SessionSummary[] = rows.map((row, i) => ({
  sessionId: `ses_fixture${i}` as SessionSummary["sessionId"],
  title: row.title,
  directory: row.directory,
  createdAt: NOW - row.ago,
  updatedAt: NOW - row.ago,
  lastSeq: 10,
  state: row.state ?? "idle",
  queued: row.queued ?? 0,
}))

const width = Number(process.argv[2] ?? 100)
const height = Number(process.argv[3] ?? 24)

const lines = renderSessionList({
  sessions,
  state: { ...createSessionListState(), selected: 2 },
  currentSessionId: sessions[3]!.sessionId,
  width,
  height,
  now: NOW,
})

for (const line of lines) {
  console.log(line.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join(""))
}
