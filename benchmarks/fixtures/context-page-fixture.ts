import type { ContextReport } from "@mendcode/protocol"
import { sgr } from "../../apps/cli/src/ui/theme"
import { contextPageStateKey, createContextPageState, renderContextPage } from "../../apps/cli/src/view/context-page"

const report: ContextReport = {
  model: "gpt-5.6",
  sections: [
    { id: "system:base", label: "system · base prompt", chars: 12_000, tokens: 3_000 },
    { id: "system:instructions", label: "system · project instructions", chars: 8_000, tokens: 2_000 },
    { id: "system:skills", label: "system · skills", chars: 0, tokens: 0 },
    { id: "system:memory", label: "system · memory", chars: 400, tokens: 100 },
    { id: "tools", label: "tools", chars: 20_000, tokens: 5_000, count: 18 },
    { id: "history:user", label: "history · user", chars: 4_000, tokens: 1_000, count: 6 },
    { id: "history:assistant", label: "history · assistant", chars: 40_000, tokens: 10_000, count: 14 },
    { id: "history:tool", label: "history · tool results", chars: 400_000, tokens: 100_000, count: 12 },
  ],
  largest: [
    { role: "tool", chars: 96_000, tokens: 24_000, preview: "shell: bun test packages/kernel --coverage --reporter verbose output" },
    { role: "tool", chars: 40_000, tokens: 10_000, preview: "read: apps/cli/src/ui/app.ts" },
    { role: "assistant", chars: 20_000, tokens: 5_000, preview: "→ edit, shell" },
    { role: "user", chars: 4_000, tokens: 1_000, preview: "please refactor the transcript wrap" },
    { role: "tool", chars: 800, tokens: 200, preview: "grep: TODO" },
  ],
  images: 2,
  estimatedTokens: 121_100,
  measuredTokens: 118_432,
  compactAtTokens: 160_000,
}

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)

let state = createContextPageState()
if (process.argv[4] === "largest") state = contextPageStateKey(state, "2").state

for (const line of renderContextPage({ report, state, width, height })) {
  console.log(line.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join(""))
}
