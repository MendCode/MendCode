import { realpathSync } from "node:fs"
import { createAfterWrite, createFormatterManager, createLspManager } from "../../../packages/lsp/src"
import { STACK_FORMATTERS } from "../../../packages/lsp/src/stack-formatters"
import { stackFormatterFixture } from "../../../packages/lsp/test/stack-formatter-fixtures"
import { put } from "../../../packages/lsp/test/helpers"
import { write } from "../../../packages/tools/src"
import { tempDir } from "./session-ui-harness"
export { b11Scene as b14Scene } from "./lsp-presets-ui-harness"

const STATES = ["clean", "failure", "missing"] as const

/** One stack in one state: its own folder, formatter manager and fixture formatter process (~0.15 s). */
async function b14Case(spec: (typeof STACK_FORMATTERS)[number], state: (typeof STATES)[number]) {
  const cwd = realpathSync(tempDir("mendcode-b14-ui-"))
  const { config } = stackFormatterFixture(cwd, spec.name, state === "failure" ? { FAKE_FORMATTER_MODE: "format-fail" } : {})
  if (state === "missing") {
    config[spec.name] = { command: [`missing-${spec.name}`, "$FILE"] }
    put({ root: cwd, path: ".mendcode/formatter.json", content: JSON.stringify(config) })
  }
  const formatter = createFormatterManager({ which: () => null })
  const manager = createLspManager({ which: () => null, registryLoader: () => ({ servers: [], issues: [] }) })
  try {
    const args = { path: `src/app${spec.extensions[0]}`, content: "BAD" }
    const result = await write.execute(args, { cwd, signal: new AbortController().signal })
    const extra = await createAfterWrite({ manager, formatter })({ cwd, paths: [args.path] })
    return { name: `${spec.name}-${state}`, tool: "write", args, result: { ...result, output: result.output + (extra ?? "") } }
  } finally {
    await formatter.stop()
    await manager.stop()
  }
}

/**
 * Callers that need one stack pass its name so the cost stays inside that test. The three states of a stack share nothing (a folder,
 * a manager and a process each), so they run at the same time; the stacks, and the cases in the result, keep their order.
 */
export async function b14Cases(only?: readonly string[]) {
  const cases = []
  for (const spec of STACK_FORMATTERS.filter((item) => !only || only.includes(item.name))) cases.push(...await Promise.all(STATES.map((state) => b14Case(spec, state))))
  return cases
}
