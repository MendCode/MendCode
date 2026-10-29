import { realpathSync } from "node:fs"
import { createAfterWrite, createFormatterManager, createLspManager } from "../../../packages/lsp/src"
import { write } from "../../../packages/tools/src"
import { formatterFixture } from "../../../packages/lsp/test/formatter-fixtures"
import { FAKE_LSP, put } from "../../../packages/lsp/test/helpers"
import { tempDir } from "./session-ui-harness"
export { b11Scene as b13Scene } from "./lsp-presets-ui-harness"

export async function b13Cases() {
  const cases = []
  for (const name of ["clean", "failure", "missing", "diagnostics"] as const) {
    const cwd = realpathSync(tempDir("mendcode-b13-ui-"))
    const { command } = formatterFixture(cwd)
    put({ root: cwd, path: ".mendcode/formatter.json", content: JSON.stringify({ prettier: { command: name === "missing" ? ["missing-formatter", "$FILE"] : command, environment: name === "failure" ? { FAKE_FORMATTER_MODE: "fail" } : {} }, biome: { disabled: true }, oxfmt: { disabled: true } }) })
    const formatter = createFormatterManager({ which: () => null })
    const manager = createLspManager({ which: () => null, settleMs: 20, registryLoader: () => ({ servers: [{ id: "fake", command: [process.execPath, FAKE_LSP], extensions: [".ts"], rootMarkers: [] }], issues: [] }) })
    try {
      const args = { path: "src/app.ts", content: name === "diagnostics" ? "ERROR BAD" : "BAD" }
      const result = await write.execute(args, { cwd, signal: new AbortController().signal })
      // A write reports diagnostics only from a server that already runs; the `diagnostics` tool is what starts one.
      if (name === "diagnostics") await manager.diagnostics({ path: args.path, cwd })
      const extra = await createAfterWrite({ manager, formatter })({ cwd, paths: [args.path] })
      cases.push({ name, tool: "write", args, result: { ...result, output: result.output + (extra ?? "") } })
    } finally {
      await formatter.stop()
      await manager.stop()
    }
  }
  return cases
}
