import type { FooterPackFile } from "@mendcode/protocol/wire"

/** Coloured badges for the agent and the permission (` BUILD `, ` FULL `), and the context with its real denominator (48K/200K). */
export default {
  label: "Badges",
  help: "coloured mode and permission badges, the context as used of its limit (48K/200K)",
  rows: [{ left: ["mode", "permission", "directory", "branch", "diff", "jobs", "agents", "goal", "hints"], right: ["connection", "quota", "cost", "model", "effort", "context"] }],
  separator: " · ",
  context: "fraction",
  chips: "fill",
  backgrounds: { mode: "primary", permission: "warning" },
  colors: { directory: "muted", branch: "secondary", model: "text", effort: "muted" },
  symbols: {
    unicode: { icons: { branch: "⎇" } },
    nerd: { icons: { directory: "", branch: "" } },
  },
} satisfies FooterPackFile
