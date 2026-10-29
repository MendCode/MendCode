import { realpathSync } from "node:fs"
import path from "node:path"
import { createDiagnosticsTool, createLspManager, createLspTool } from "../../../packages/lsp/src"
import { WEB_SERVERS } from "../../../packages/lsp/src/web-presets"
import { FAKE_LSP, put } from "../../../packages/lsp/test/helpers"
import { webFixture } from "../../../packages/lsp/test/web-fixtures"
import type { ToolResult } from "../../../packages/tools/src"
import { callTitle } from "../../../packages/engine-native/src/engine"
import { parityHarness } from "./parity-b01-b02-harness"
import { conversation, ids, NOW, tempDir } from "./session-ui-harness"

type PresetCase = { name: string; tool: string; args: Record<string, unknown>; result: ToolResult }

export async function b11Cases(): Promise<PresetCase[]> {
  const cases: PresetCase[] = []
  for (const spec of WEB_SERVERS) {
    const cwd = realpathSync(tempDir("mendcode-b11-"))
    const { filePath } = webFixture(cwd, spec.id)
    const manager = createLspManager({ which: () => null })
    try {
      const args = { operation: "hover" as const, filePath, line: 1, character: 1 }
      const result = await createLspTool(manager).execute(args, { cwd, signal: new AbortController().signal })
      cases.push({ name: spec.id, tool: "lsp", args, result: { ...result, output: result.output.replaceAll(cwd, "/work/mendcode") } })
    } finally { await manager.stop() }
  }
  for (const id of ["vue", "astro", "eslint"]) {
    const cwd = realpathSync(tempDir("mendcode-b11-"))
    const { spec, filePath } = webFixture(cwd, id)
    const manager = createLspManager({ registryLoader: () => ({ servers: [spec], issues: [] }), which: () => null })
    try {
      const args = { operation: "hover" as const, filePath, line: 1, character: 1 }
      cases.push({ name: `${id}-unavailable`, tool: "lsp", args, result: await createLspTool(manager).execute(args, { cwd, signal: new AbortController().signal }) })
    } finally { await manager.stop() }
  }
  const cwd = realpathSync(tempDir("mendcode-b11-"))
  const args = { path: "src/multiple.ts" }
  put({ root: cwd, path: args.path, content: "ERROR" })
  const manager = createLspManager({ registryLoader: () => ({ servers: [
    { ...WEB_SERVERS.find((spec) => spec.id === "biome")!, command: [process.execPath, FAKE_LSP] },
    { ...WEB_SERVERS.find((spec) => spec.id === "oxlint")! },
  ], issues: [] }), which: () => null, settleMs: 20 })
  try {
    const tool = createDiagnosticsTool(manager)
    cases.push({ name: "diagnostics-partial", tool: "diagnostics", args, result: await tool.execute(args, { cwd, signal: new AbortController().signal }) })
    put({ root: cwd, path: args.path, content: "clean" })
    cases.push({ name: "diagnostics-clean-partial", tool: "diagnostics", args, result: await tool.execute(args, { cwd, signal: new AbortController().signal }) })
  } finally { await manager.stop() }
  return cases
}

export function b11Scene(scene: PresetCase, width: number, height: number) {
  const turnId = ids("turn"), userId = ids("item"), toolId = ids("item")
  const title = callTitle({ name: scene.tool, args: scene.args, callId: "b11-lsp" })
  const turn = { turnId, at: NOW, seq: 1, preview: title, outcome: "completed", items: [
    { itemId: userId, kind: "user_message", text: title, status: "ok" },
    { itemId: toolId, kind: "tool_call", tool: scene.tool, title, text: scene.result.output, status: scene.result.isError ? "error" : "ok" },
  ] }
  const harness = parityHarness({ width, height, reply: (command) => command.type === "session.history" ? { ok: true, result: { turns: [turn] } } : undefined })
  const chat = conversation(harness.sessionId, harness.app.onEvent)
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userId, status: "ok", text: title })
  chat.emit({ type: "item.started", turnId, itemId: toolId, kind: "tool_call", meta: { tool: title } })
  chat.emit({ type: "item.completed", itemId: toolId, status: scene.result.isError ? "error" : "ok", text: scene.result.output, meta: scene.result.meta })
  chat.emit({ type: "turn.completed", turnId })
  harness.app.render()
  return harness
}
