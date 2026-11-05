import type { FooterPackFile } from "@mendcode/protocol/wire"

/** The default footer: one quiet row. Folder and branch on the left; model, effort and context on the right; the rest when it matters. */
export default {
  label: "Clean",
  help: "one quiet row: folder and branch; model, effort and context on the right; the rest only when it matters",
  rows: [{ left: ["directory", "branch", "diff", "jobs", "agents", "goal", "hints"], right: ["connection", "permission", "mode", "quota", "cost", "model", "effort", "context"] }],
  separator: " · ",
  context: "percent",
  labels: { context: "ctx" },
  colors: { directory: "muted", branch: "muted", model: "muted", effort: "muted", context: "muted", cost: "muted", mode: "heading" },
  symbols: { unicode: { context: "pie", labels: { context: "" } } },
} satisfies FooterPackFile
