import { realpathSync } from "node:fs"
import { createDiagnosticsTool, createLspManager, createLspTool, OTHER_SERVERS } from "../../../packages/lsp/src"
import { otherFixture } from "../../../packages/lsp/test/other-fixtures"
import { put } from "../../../packages/lsp/test/helpers"
import type { ToolResult } from "../../../packages/tools/src"
import { tempDir } from "./session-ui-harness"
export { b11Scene as b12Scene } from "./lsp-presets-ui-harness"

type PresetCase = { name: string; tool: string; args: Record<string, unknown>; result: ToolResult }

export async function b12Cases(only?: readonly string[]): Promise<PresetCase[]> {
  const cases: PresetCase[] = []
  for (const preset of OTHER_SERVERS.filter((item) => !only || only.includes(item.id))) {
    const cwd = realpathSync(tempDir("mendcode-b12-"))
    const { spec, filePath } = otherFixture(cwd, preset.id)
    const manager = createLspManager({ which: () => null, settleMs: 20 })
    try {
      const args = { operation: "hover" as const, filePath, line: 1, character: 1 }
      const result = await createLspTool(manager).execute(args, { cwd, signal: new AbortController().signal })
      cases.push({ name: preset.id.replaceAll(" ", "-"), tool: "lsp", args, result: { ...result, output: result.output.replaceAll(cwd, "/work/mendcode") } })
      if (preset.id === "dockerfile") {
        const args = { path: filePath }
        const result = await createDiagnosticsTool(manager).execute(args, { cwd, signal: new AbortController().signal })
        cases.push({ name: "dockerfile-diagnostics", tool: "diagnostics", args, result })
      }
    } finally { await manager.stop() }
    const missingDir = realpathSync(tempDir("mendcode-b12-missing-"))
    put({ root: missingDir, path: filePath, content: "" })
    const missing = createLspManager({ registryLoader: () => ({ servers: [{ ...spec, enabled: true, env: { DOTNET_CLI_HOME: missingDir, VSCODE_EXTENSIONS: missingDir, VIRTUAL_ENV: missingDir } }], issues: [] }), which: () => null })
    try {
      const args = { operation: "hover" as const, filePath, line: 1, character: 1 }
      const result = await createLspTool(missing).execute(args, { cwd: missingDir, signal: new AbortController().signal })
      cases.push({ name: `${preset.id.replaceAll(" ", "-")}-unavailable`, tool: "lsp", args, result: { ...result, output: result.output.replaceAll(missingDir, "/work/mendcode") } })
    } finally { await missing.stop() }
  }
  return cases
}
