import type { CustomToolInfo, CustomToolsReport } from "@mendcode/protocol"
import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createToolsPageState, renderToolsPage } from "../../apps/cli/src/view/tools-page"
import { textWidth } from "../../apps/cli/src/view/wrap"

function tool(name: string, patch: Partial<CustomToolInfo> = {}): CustomToolInfo {
  return {
    name,
    toolName: `custom__${name}`,
    description: `Tool that does ${name} things`,
    source: "project",
    file: `/repo/.mendcode/tools/${name}.json`,
    command: ["./run.sh", "--flag"],
    trusted: false,
    ...patch,
  }
}

const report: CustomToolsReport = {
  directory: "/repo",
  tools: [
    tool("word_count", { trusted: false, description: "Count words, lines, and characters in text files with detailed statistics" }),
    tool("lint", { trusted: true, description: "Lint and format code files using multiple linters and style checkers" }),
    tool("hello", { source: "user", trusted: true, description: "Hello world sample tool" }),
    tool("search-very-long-name-that-truncates", { trusted: false, description: "Search for patterns in repository files with regex support and filtering options" }),
    tool("deploy", { trusted: true, description: "Deploy application to cloud services and manage releases" }),
    tool("backup", { trusted: false, description: "Create and manage system backups with compression and verification" }),
  ],
  issues: [{ file: "/repo/.mendcode/tools/bad.json", message: "invalid JSON: unexpected token" }],
}

const width = Number(process.argv[2] ?? 100)
const height = Number(process.argv[3] ?? 30)
const state = createToolsPageState()
const depth = colorDepth({ COLORTERM: "truecolor" })

const lines = renderToolsPage({ report, state, width, height })
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
