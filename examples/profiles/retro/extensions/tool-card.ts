// tool.card: every tool call as a line-printer entry: a bracketed tag, the target, and the result on the right.
// Folded cards are one line (a shell call keeps two lines of output, a failure four); opened ones show more behind a rail. Clicking the tag folds or opens it.
const MARK = { running: "…", ok: "✓", error: "✗", cancelled: "–", interrupted: "!", unknown: "?" }
const ASCII_MARK = { running: "...", ok: "ok", error: "x", cancelled: "-", interrupted: "!", unknown: "?" }
const LINES = { summary: 0, preview: 4, full: 12 }

export default {
  name: "retro-tool-card",
  tui(api) {
    api.view("tool.card", (input) => {
      const marks = input.ascii ? ASCII_MARK : MARK
      const color = input.status === "error" ? "error" : input.status === "ok" ? "success" : "primary"
      const tag = "[" + input.kind.toUpperCase().slice(0, 12) + "]"
      const detail = input.detail || input.title || ""
      const head = [
        { text: tag, fg: "primary", bold: true, action: "toggle" },
        { text: " " + detail, fg: "text" },
        { text: "  " + (marks[input.status] ?? "?") + (input.counts?.lines ? " " + input.counts.lines + " lines" : ""), fg: color },
      ]
      // Folded: one line, except a shell call keeps its last two lines and a failure keeps four.
      const base = LINES[input.level] ?? 0
      const shown = input.status === "error" ? Math.max(base, 4) : input.kind === "shell" ? Math.max(base, 2) : base
      if (!shown || input.output.length === 0) return [head]
      const rail = input.ascii ? "| " : "│ "
      const body = input.output.slice(0, shown).map((line) => [{ text: rail, fg: "border" }, { text: line, fg: "muted" }])
      const more = input.output.length - shown
      return [head, ...body, ...(more > 0 ? [[{ text: (input.ascii ? "+ " : "└ ") + more + " more", fg: "border" }]] : [])]
    })
  },
}
