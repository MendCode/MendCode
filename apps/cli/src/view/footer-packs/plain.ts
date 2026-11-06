import type { FooterPackFile } from "@mendcode/protocol/wire"

/** Accessible: words for every part and every state, no Nerd Font, colour never the only signal. */
export default {
  label: "Plain",
  help: "words only: every part named, every state said in words as well as colour",
  rows: [{ left: ["mode", "permission", "directory", "branch", "diff", "jobs", "agents", "goal", "hints"], right: ["connection", "quota", "cost", "model", "effort", "context"] }],
  separator: " | ",
  context: "percent",
  chips: "brackets",
  words: true,
  backgrounds: { mode: "heading", permission: "warning" },
  labels: { directory: "dir", branch: "git", diff: "diff", model: "model", effort: "effort", context: "ctx", cost: "cost", quota: "quota" },
} satisfies FooterPackFile
