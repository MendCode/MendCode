export const examples = {
  messages: `export default {
  name: "matrix-messages",
  tui(api) {
    api.messageStyle("user", { icon: "◆", label: "You", lead: "", tint: false })
    api.messageStyle("assistant", { icon: "◇", label: "Agent", lead: "" })
    api.slot("header.replace", ({ width }) => [[{ text: "MEND · Matrix workspace", fg: "primary", bold: true }], [{ text: "─".repeat(width), fg: "border" }]])
  },
}`,
  footer: `export default {
  name: "clock-branch",
  tui(api) {
    api.slot("footer.replace", ({ now, branch }) => [
      [{ text: new Date(now).toISOString().slice(11, 19) + " UTC", fg: "primary" }],
      [{ text: branch ? "Branch · " + branch : "No Git branch", fg: "muted" }],
    ])
    const timer = setInterval(() => api.redraw(), 1000)
    api.onDispose(() => clearInterval(timer))
  },
}`,
  prompt: `export default {
  name: "prompt-console",
  tui(api) {
    api.prompt.chrome({ lead: "λ", border: "rounded", preset: "ascii-box" })
    api.slot("prompt.above", () => [[{ text: "Console · enter sends · shift-enter newline", fg: "muted" }]])
    api.slot("prompt.below", ({ state }) => [[{ text: "Session · " + state, fg: "secondary" }]])
  },
}`,
}
