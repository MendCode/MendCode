import type { McpCatalogReport, McpStatusReport } from "@mendcode/protocol"
import { appHarness, tempDir } from "./session-ui-harness"

export const B47_CATALOG: McpCatalogReport = {
  resources: [{ server: "docs", id: "docs:Project_guide", name: "Project guide", description: "Architecture and conventions", uri: "docs://guide", mimeType: "text/plain" }, { server: "docs", id: "docs:Release_notes", name: "Release notes", uri: "docs://release" }],
  templates: [{ server: "docs", id: "docs:Issue", name: "Issue", uriTemplate: "issues://{id}", description: "Issue by identifier" }],
  prompts: [{ server: "docs", id: "docs:Review_code", name: "Review code", description: "Review a target with a chosen focus", arguments: [{ name: "target", required: true }, { name: "focus", description: "Review focus" }] }],
  issues: [],
}
export const B47_STATUS: McpStatusReport = { servers: [{ name: "docs", command: "bun catalog-server.ts", enabled: true, state: "running", tools: 1, stderr: [] }], issues: [] }

export function b47Harness(width = 100, height = 30, options: { empty?: boolean; failed?: boolean; partial?: boolean } = {}) {
  const catalog = options.empty ? { resources: [], templates: [], prompts: [], issues: [] } : options.partial ? { ...B47_CATALOG, prompts: [], issues: [{ server: "docs", source: "runtime", message: "prompts/list: unavailable" }] } : B47_CATALOG
  const h = appHarness({ width, height, directory: tempDir("mendcode-b47-project-"), dataDir: tempDir("mendcode-b47-data-"), reply: (command) => {
    if (command.type === "mcp.status") return { ok: true, result: B47_STATUS }
    if (command.type === "mcp.catalog") return options.failed ? { ok: false, error: { code: "target_mismatch", message: "docs: connection refused" } } : { ok: true, result: catalog }
    if (command.type === "mcp.resource.read") return { ok: true, result: { contents: [{ uri: command.uri, mimeType: "text/plain", text: "# Project guide\n\nDaemon owns I/O. Clients send typed commands.\n\nViews render terminal rows, never provider requests." }] } }
    if (command.type === "files.search") return { ok: true, result: { files: [] } }
    if (command.type === "commands.list") return { ok: true, result: { commands: catalog.prompts.map((entry) => ({ name: entry.id.toLowerCase(), description: entry.description, argumentHint: "<target> [focus]", source: "mcp" })) } }
    if (command.type === "commands.expand") return command.args.trim() ? { ok: true, result: { prompt: `Review ${command.args}` } } : { ok: false, error: { code: "target_mismatch", message: "/docs:review_code needs <target>" } }
    if (command.type === "models.list") return { ok: true, result: { engine: "faux", selectable: false, models: [], defaults: { model: "local" }, effective: { model: "local" }, roles: {} } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  h.app.onGlobal({ type: "tui.changed", gseq: 0, at: 0, profile: { showProject: false } })
  const key = async (value: string) => {
    await h.app.onKey(value)
    await Bun.sleep(5)
    h.app.render()
  }
  const open = async () => {
    await h.app.extensionsReady
    await h.type("/mcps")
    await key("\r")
    await key("x")
  }
  return { ...h, text: () => h.text().join("\n"), key, open }
}
