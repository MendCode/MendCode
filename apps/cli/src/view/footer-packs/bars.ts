import type { FooterPackFile } from "@mendcode/protocol/wire"

/** A small dashboard: the context and every quota window as bars, on their own rows. */
export default {
  label: "Bars",
  help: "several rows: who answers, then the context and each quota window as a bar",
  rows: [
    { left: ["mode", "permission", "model", "effort"], right: ["connection", "directory", "branch", "diff"] },
    { left: ["context"], right: ["cost", "jobs", "agents", "goal", "hints"] },
    { left: ["quota"] },
  ],
  separator: " · ",
  context: "percent",
  quota: "percent",
  quotaBelow: 101,
  labels: { context: "ctx" },
  colors: { model: "text", effort: "muted", directory: "muted", branch: "muted", mode: "heading" },
  symbols: { ascii: { context: "bar", quota: "bar" } },
} satisfies FooterPackFile
