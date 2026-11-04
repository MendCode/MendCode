// renderTool("shell"): the command from the call's arguments, the folder it ran in and whether it went to the background,
// then the last lines of output (three folded, twelve opened). Without a command argument it draws nothing and the
// built-in card is used.
const MARK = { running: "…", ok: "✓", error: "✗" }
const TAIL = { folded: 3, opened: 12 }

export default {
  name: "shell-command",
  tui(api) {
    api.renderTool("shell", ({ args, final, output, status, expanded }) => {
      if (typeof args.command !== "string") return undefined
      const head = [
        { text: "$ ", fg: "primary", bold: true },
        { text: args.command, fg: "text" },
        ...(typeof args.workdir === "string" ? [{ text: "  in " + args.workdir, fg: "muted" }] : []),
        ...(args.background === true ? [{ text: "  background", fg: "warning" }] : []),
        { text: "  " + MARK[status], fg: status === "error" ? "error" : status === "ok" ? "success" : "primary" },
      ]
      // Until the call finishes only the title is known, so the card stays one line.
      if (!final) return [head]
      const lines = output.replace(/\n+$/, "").split("\n").filter((line) => line.length > 0)
      const shown = lines.slice(-(expanded ? TAIL.opened : TAIL.folded))
      const hidden = lines.length - shown.length
      return [
        head,
        ...(hidden > 0 ? [[{ text: "  … " + hidden + " earlier lines", fg: "border" }]] : []),
        ...shown.map((line) => [{ text: "  " + line, fg: status === "error" ? "error" : "muted" }]),
      ]
    })
  },
}
