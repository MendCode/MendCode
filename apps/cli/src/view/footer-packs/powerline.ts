import type { FooterPackFile } from "@mendcode/protocol/wire"

/** Powerlevel10k / oh-my-posh: coloured segments joined by powerline arrows. The arrows need a Nerd Font; any other glyph set draws flat blocks. */
export default {
  label: "Powerline",
  help: "coloured segments with powerline arrows (Nerd Font), git state and context; flat blocks without a Nerd Font",
  style: "powerline",
  rows: [{ left: ["directory", "git", "diff", "jobs", "agents", "goal", "hints"], right: ["connection", "permission", "mode", "quota", "cost", "model", "effort", "context"] }],
  context: "percent",
  labels: { context: "ctx" },
  backgrounds: { directory: "primary", git: "secondary", diff: "element", jobs: "info", agents: "info", goal: "heading", mode: "heading", quota: "warning", cost: "element", model: "accent", effort: "element", context: "success", hints: "element" },
  colors: { diff: "text", cost: "text", effort: "text", hints: "muted" },
  symbols: {
    nerd: {
      arrows: { left: "", right: "" },
      caps: { start: "", end: "" },
      icons: { directory: "", git: "", model: "\u{F035B}", context: "\u{F01BC}" },
    },
    ascii: {},
  },
} satisfies FooterPackFile
