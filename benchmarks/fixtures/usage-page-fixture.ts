import type { UsageDay, UsageReport } from "@mendcode/protocol"
import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createUsagePageState, renderUsagePage, usagePageKey } from "../../apps/cli/src/view/usage-page"
import { textWidth } from "../../apps/cli/src/view/wrap"

const TODAY = "2026-09-26"
const NOW = Date.UTC(2026, 8, 26, 12)

function day(offset: number): UsageDay | undefined {
  const at = new Date(Date.UTC(2026, 8, 26) - offset * 86_400_000)
  const weekday = at.getUTCDay()
  if (weekday === 0 || offset % 17 === 5) return undefined
  const scale = (weekday === 6 ? 1 : 4 + (offset % 7)) * (1 + (offset % 11))
  return {
    day: at.toISOString().slice(0, 10),
    input: scale * 40_000,
    output: scale * 6_000,
    reasoning: scale * 2_000,
    cacheRead: scale * 90_000,
    cacheWrite: scale * 5_000,
    costMicros: offset % 9 === 0 ? 0 : scale * 12_000,
    costUnknownCalls: offset % 9 === 0 ? scale : 0,
    calls: scale * 3,
    sessions: 1 + (offset % 4),
  }
}

const report: UsageReport = {
  from: "2025-09-27",
  to: TODAY,
  days: Array.from({ length: 365 }, (_, offset) => day(offset)).filter((entry): entry is UsageDay => entry !== undefined).reverse(),
  models: [
    { provider: "codex", model: "gpt-5.6", input: 48_200_000, output: 6_100_000, calls: 2_310, costMicros: 0 },
    { provider: "anthropic", model: "claude-sonnet-5", input: 21_400_000, output: 2_900_000, calls: 980, costMicros: 41_000_000 },
    { provider: "openrouter", model: "qwen3-coder-480b-a35b-instruct", input: 3_100_000, output: 400_000, calls: 144, costMicros: 2_000_000 },
  ],
  quotas: [
    {
      scope: "global",
      type: "quota.snapshot",
      provider: "codex",
      windows: [
        { id: "5h", label: "5h", usedPercent: 22, resetsAt: NOW + 2 * 3_600_000, windowMinutes: 300 },
        { id: "7d", label: "7d", usedPercent: 83, resetsAt: NOW + 6 * 86_400_000, windowMinutes: 10_080 },
      ],
      fetchedAt: NOW - 120_000,
      source: "fixture",
    } as unknown as UsageReport["quotas"][number],
  ],
  sessions: 628,
  activity: [{ day: "2026-09-25", prompts: 40, words: 3_100, aiMs: 5_400_000, toolMs: 1_900_000 }],
  tools: [
    { tool: "shell", calls: 4_210, ms: 9_800_000, errors: 31 },
    { tool: "read", calls: 3_900, ms: 400_000, errors: 0 },
    { tool: "edit", calls: 1_750, ms: 300_000, errors: 4 },
  ],
  profile: { name: "Ada Lovelace", email: "ada@example.com", plan: "Pro" },
  insights: {
    lifetime: { tokens: 69_900_000_000, since: "2025-10-02" },
    peakDay: { day: "2026-09-02", tokens: 2_800_000_000 },
    streak: { current: 159, longest: 159 },
    longestSession: { sessionId: "ses_a", title: "Rewrite the usage page", directory: "/work/mendcode", tokens: 91_000_000, ms: 13 * 3_600_000, turns: 212 },
    efforts: [{ effort: "high", turns: 330 }, { effort: "max", turns: 290 }, { effort: "low", turns: 120 }],
    skills: [{ skill: "build", runs: 500 }, { skill: "fix", runs: 430 }, { skill: "release-flow", runs: 178 }],
    topSessions: [
      { sessionId: "ses_a", title: "Rewrite the usage page", directory: "/work/mendcode", tokens: 91_000_000, ms: 13 * 3_600_000, turns: 212 },
      { sessionId: "ses_b", title: "Fix reconnect after sleep", directory: "/work/mendcode", tokens: 40_000_000, ms: 4 * 3_600_000, turns: 80 },
      { sessionId: "ses_c", title: "Landing page copy", directory: "/work/site", tokens: 3_200_000, ms: 1_800_000, turns: 12 },
    ],
  },
}

const width = Number(process.argv[2] ?? 100)
const height = Number(process.argv[3] ?? 30)
const tab = process.argv[4] ?? "1"
let state = createUsagePageState(TODAY)
for (const key of ["\x1b[D", "\x1b[D", "\x1b[A", tab]) state = usagePageKey(state, key, TODAY, report)
const depth = colorDepth({ COLORTERM: "truecolor" })

const lines = renderUsagePage({ report, state, today: TODAY, width, height, now: NOW })
for (const line of lines) {
  let out = ""
  let used = 0
  for (const span of line) {
    const style = sgr(span, depth)
    out += style ? `${style}${span.text}\x1b[0m` : span.text
    used += textWidth(span.text)
  }
  process.stdout.write(`${out}\n`)
}
