import type { FooterPackFile } from "@mendcode/protocol/wire"

/** The least that still says something: the model and the context. A permission that acts without asking and a lost connection still show. */
export default {
  label: "Minimal",
  help: "model and context, nothing else",
  rows: [{ left: ["model", "context"], right: ["connection", "permission"] }],
  separator: " · ",
  context: "percent",
  labels: { context: "ctx" },
  colors: { model: "muted", context: "muted" },
  symbols: { unicode: { context: "pie", labels: { context: "" } } },
} satisfies FooterPackFile
