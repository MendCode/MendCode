import type { McpServerStatus } from "@mendcode/protocol"
import { appHarness, tempDir } from "./session-ui-harness"

export function b83Harness(width = 100, height = 30) {
  let server: McpServerStatus = { name: "docs", command: "https://mcp.example.invalid/mcp", enabled: true, state: "running", tools: 4, transport: "remote", auth: "authorized", stderr: [] }
  let gseq = 0
  const directory = tempDir("mendcode-b83-project-"), dataDir = tempDir("mendcode-b83-data-")
  const h = appHarness({ width, height, directory, dataDir, reply: (command) => {
    if (command.type === "mcp.status") return { ok: true, result: { servers: [server], issues: [] } }
    if (command.type === "mcp.auth") return { ok: true, result: { url: "https://auth.example.invalid/authorize?state=fixture" } }
    if (command.type === "models.list") return { ok: true, result: { engine: "faux", selectable: false, models: [], defaults: { model: "local" }, effective: { model: "local" }, roles: {} } }
  } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  h.app.onGlobal({ type: "tui.changed", gseq: 0, at: 0, profile: { showProject: false } })
  const key = async (value: string) => { await h.app.onKey(value); await Bun.sleep(5); h.app.render() }
  const update = async (value: Partial<McpServerStatus>) => {
    server = { ...server, ...value }
    h.app.onGlobal({ type: "mcp.changed", directory, server: "docs", gseq: ++gseq, at: gseq })
    await Bun.sleep(5)
    h.app.render()
  }
  const open = async () => { await h.app.extensionsReady; await h.type("/mcps"); await key("\r") }
  return { ...h, key, update, open, text: () => h.text().join("\n") }
}
