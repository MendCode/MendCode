// Print the README tier block, or check it without modifying files.
import { FEATURE_IDS, FEATURES, TIERS, tierIncludes, type FeatureSpec } from "../packages/protocol/src/tier-data"

export const START = "<!-- tiers:start -->"
export const END = "<!-- tiers:end -->"

const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", " ")

export function renderTierTable(specs: Readonly<Record<string, FeatureSpec>> = FEATURES) {
  const rows = FEATURE_IDS.map((id) => {
    const spec = specs[id]!
    const states = TIERS.map((tier) => {
      if (spec.mode === "kernel") return "Kernel"
      if (!tierIncludes(tier, spec.tier)) return "—"
      return spec.mode === "permit" || spec.optIn ? "Opt-in" : "Included"
    })
    return `| [${cell(spec.label)}](${spec.doc}) (\`${id}\`) | ${states.join(" | ")} | ${cell(spec.own)} |`
  })
  return [START, "| Feature | Minimalist | Balanced | Full | Own switch / action |", "|---|---|---|---|---|", ...rows, END].join("\n")
}

export function tiersMatch(readme: string, table = renderTierTable()) {
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  return start >= 0 && end > start
    && readme.indexOf(START, start + START.length) === -1
    && readme.indexOf(END, end + END.length) === -1
    && readme.slice(start, end + END.length) === table
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text()
    if (!tiersMatch(readme)) {
      console.error("README tiers drifted: replace the tiers block with `bun scripts/readme-tiers.ts` output")
      process.exitCode = 1
    }
  } else console.log(renderTierTable())
}
