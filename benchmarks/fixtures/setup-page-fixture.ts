import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createSetupPageState, renderSetupPage, setupPageKey, type SetupChecks, type SetupValues } from "../../apps/cli/src/view/setup-page"
import { textWidth } from "../../apps/cli/src/view/wrap"

const values: SetupValues = {
  theme: "mint",
  view: "full",
  defaultPermission: "edits",
  reducedMotion: false,
  dreamAt: "03:00",
  retentionDays: 90,
}

const checks: SetupChecks = {
  connected: true,
  buildId: "abcdef0123456789",
  info: {
    engine: "gpt-6",
    model: "gpt-6-luna",
    effort: "low",
    dataDir: "/Users/mendcode/.mendcode-v2",
    pid: 12345,
    login: { ok: true },
  },
  quotas: [
    {
      provider: "openai",
      windows: [
        { label: "1h", usedPercent: 42 },
        { label: "7d", usedPercent: 67 },
      ],
    },
    {
      provider: "anthropic",
      windows: [{ label: "7d", usedPercent: 28 }],
    },
  ],
  mcpServers: 3,
  memory: { saved: 12, pending: 2 },
}

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
let state = createSetupPageState()
for (const key of ["j", "j"]) state = setupPageKey(state, key, values, { themes: ["matrix", "mint", "amber"] }).state
const depth = colorDepth({ COLORTERM: "truecolor" })

const lines = renderSetupPage({ state, values, checks, firstRun: true, width, height })
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
