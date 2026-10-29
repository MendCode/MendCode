import type { McpServerStatus, McpStatusReport } from "@mendcode/protocol"
import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createMcpsPageState, renderMcpsPage } from "../../apps/cli/src/view/mcps-page"
import { textWidth } from "../../apps/cli/src/view/wrap"

function server(name: string, patch: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name,
    command: `npx -y @scope/${name}-server`,
    enabled: true,
    state: "running",
    pid: 4000 + name.length,
    tools: 3,
    stderr: [],
    ...patch,
  }
}

const report: McpStatusReport = {
  servers: [
    server("demo", { stderr: ["listening on stdio", "loaded 3 tools"] }),
    server("stopped-one", { state: "stopped", pid: undefined, tools: 0 }),
    server("broken-long-name-server-that-is-quite-verbose", { state: "failed", tools: 0, pid: undefined, lastError: 'MCP server "broken" exited (code 3) with a very long error message that describes the exact problem in detail', stderr: ["bad config", "fatal: cannot open /etc/x.json", "additional error line"] }),
    server("warming", { state: "starting", tools: 0 }),
    server("off", { enabled: false, state: "stopped", tools: 0 }),
    server("async-tools", { tools: 7, stderr: ["ready", "all handlers initialized"] }),
  ],
  issues: [{ source: "mcp.json", server: "config-example", message: "invalid server config: command is required but was not provided" }],
}

const width = Number(process.argv[2] ?? 100)
const height = Number(process.argv[3] ?? 30)
const state = createMcpsPageState()
const depth = colorDepth({ COLORTERM: "truecolor" })

const lines = renderMcpsPage({ report, state, width, height })
for (const line of lines) {
  let out = ""
  let used = 0
  for (const span of line) {
    const style = sgr(span, depth)
    out += style ? `${style}${span.text}\x1b[0m` : span.text
    used += textWidth(span.text)
  }
  process.stdout.write(`${out}\n`)
}
