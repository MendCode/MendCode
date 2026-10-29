import { createIdFactory, type Loop } from "@mendcode/protocol"
import { sgr } from "../../apps/cli/src/ui/theme"
import { createLoopsPageState, renderLoopsPage } from "../../apps/cli/src/view/loops-page"

const ids = createIdFactory()
const NOW = Date.UTC(2026, 8, 26, 14, 32)
const MIN = 60_000

function loop(over: Partial<Loop> = {}): Loop {
  return {
    loopId: ids("loop"),
    name: "check ci",
    directory: "/Users/dev/Code/MendCodeV2",
    objective: "check the CI status on every push and fix failing tests before they block the team",
    trigger: { kind: "interval", everyMs: 30 * MIN },
    budget: { mode: "monitor" },
    state: "active",
    sessionId: ids("session"),
    runs: 2,
    nextWakeAt: NOW + 12 * MIN + 3_000,
    history: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...over,
  }
}

const loops: Loop[] = [
  loop({
    name: "check ci and fix failing tests",
    history: [
      { run: 1, startedAt: NOW - 40 * MIN, endedAt: NOW - 36 * MIN, outcome: "completed", checkpoint: { status: "continue", summary: "fixed a flaky test in the queue" } },
      { run: 2, startedAt: NOW - 10 * MIN, endedAt: NOW - 6 * MIN, outcome: "failed", checkpoint: { status: "blocked", summary: "tests still red on main" } },
    ],
    checks: ["bun test", "tsc -b"],
    audit: "independent",
  }),
  loop({ name: "triage open issues", state: "running", nextWakeAt: undefined, budget: { mode: "goal", maxRuns: 3 }, criteria: "no untriaged issues remain" }),
  loop({ name: "release notes for the beta", state: "needs_input", reason: "waiting for your answer about the changelog tone" }),
  loop({ name: "nightly dependency bump", state: "paused", trigger: { kind: "daily", at: "09:00" }, nextWakeAt: undefined }),
  loop({ name: "migrate legacy config", state: "completed", budget: { mode: "fixed", maxRuns: 5 }, runs: 5, nextWakeAt: undefined }),
  loop({ name: "rebuild the search index", state: "blocked", reason: "the daemon is unreachable", nextWakeAt: undefined }),
  loop({ name: "cleanup old branches", state: "stopped", trigger: { kind: "manual" }, nextWakeAt: undefined }),
]

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
const state = { ...createLoopsPageState(), selected: 0 }

for (const line of renderLoopsPage({ loops, state, width, height, now: NOW })) {
  console.log(line.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join(""))
}
