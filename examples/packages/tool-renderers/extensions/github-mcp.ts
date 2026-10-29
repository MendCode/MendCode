// renderTool("mcp__github__*"): every tool of a GitHub MCP server as one line, the action, the repository and the issue or
// pull request number, read from the call's arguments. A call without owner and repo draws nothing, so the next renderer
// (or the built-in card) takes it.
const PREFIX = "mcp__github__"

export default {
  name: "github-mcp",
  tui(api) {
    api.renderTool(PREFIX + "*", ({ tool, args, status, output, expanded }) => {
      if (typeof args.owner !== "string" || typeof args.repo !== "string") return undefined
      const number = args.pull_number ?? args.issue_number
      const title = typeof args.title === "string" ? args.title : undefined
      const head = [
        { text: tool.slice(PREFIX.length).replace(/_/g, " "), fg: "primary", bold: true },
        { text: "  " + args.owner + "/" + args.repo + (typeof number === "number" ? " #" + number : ""), fg: "text" },
        ...(title ? [{ text: "  " + title, fg: "muted" }] : []),
        ...(status === "error" ? [{ text: "  failed", fg: "error" }] : []),
      ]
      if (!expanded || !output.trim()) return [head]
      return [head, ...output.trim().split("\n").slice(0, 8).map((line) => [{ text: "  " + line, fg: "muted" }])]
    })
  },
}
