import type { ModelsReport, RecipesReport } from "@mendcode/protocol"
import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createModelPageState, renderModelPage } from "../../apps/cli/src/view/model-page"
import { textWidth } from "../../apps/cli/src/view/wrap"

const report: ModelsReport = {
  engine: "native",
  selectable: true,
  models: [
    { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 },
    { id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextWindow: 272_000 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", efforts: ["standard"], defaultEffort: "standard", contextWindow: 200_000 },
    { id: "qwen3-480b", name: "Qwen 3 480B", efforts: ["standard", "extended"], defaultEffort: "standard", contextWindow: 256_000 },
  ],
  defaults: { model: "gpt-6-luna", effort: "low" },
  session: { model: "gpt-6-sol", effort: "high" },
  roles: {
    main: { model: "gpt-6-sol", effort: "medium" },
    plan: { model: "claude-sonnet-5" },
  },
  effective: { model: "gpt-6-sol", effort: "high" },
}

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
const state = createModelPageState()
const depth = colorDepth({ COLORTERM: "truecolor" })

const recipes: RecipesReport = {
  recipes: [
    { name: "balanced", file: "recipes/balanced.json", source: "user", description: "Sol for main and plan, Luna for the rest", roles: { main: { model: "gpt-6-sol" }, plan: { model: "gpt-6-sol" } } },
    { name: "cheap", file: "recipes/cheap.json", source: "project", description: "Luna everywhere", roles: { main: { model: "gpt-6-luna" } } },
  ],
  active: "balanced",
}

const lines = renderModelPage({ report, recipes, state, width, height })
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
