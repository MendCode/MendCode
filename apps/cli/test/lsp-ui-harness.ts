import { realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createLspManager, createLspTool } from "../../../packages/lsp/src"
import type { LspInput } from "@mendcode/protocol"
import { callTitle } from "../../../packages/engine-native/src/engine"
import { parityHarness } from "./parity-b01-b02-harness"
import { conversation, ids, NOW, tempDir } from "./session-ui-harness"

export async function lspCases() {
  const cwd = realpathSync(tempDir("mendcode-b09-"))
  writeFileSync(path.join(cwd, "sample.fake"), "function execute() {}")
  const manager = createLspManager({ registryLoader: () => ({ servers: [{ id: "fake", command: [process.execPath, path.join(import.meta.dir, "../../..", "packages/lsp/test/fixtures/fake-lsp.ts")], extensions: [".fake"], rootMarkers: [] }], issues: [] }) })
  try {
    const operations: LspInput["operation"][] = ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"]
    const inputs: Array<{ name: string; input: LspInput }> = operations.map((operation) => ({ name: operation, input: { operation, filePath: "sample.fake", line: 1, character: 10 } }))
    inputs.push({ name: "empty", input: { operation: "workspaceSymbol", filePath: "sample.fake", line: 1, character: 1, query: "__empty__" } })
    inputs.push({ name: "unavailable", input: { operation: "hover", filePath: "missing.fake", line: 1, character: 1 } })
    const tool = createLspTool(manager)
    return await Promise.all(inputs.map(async ({ name, input }) => {
      const result = await tool.execute(input, { cwd, signal: new AbortController().signal })
      return { name, input, result: { ...result, output: result.output.replaceAll(cwd, "/work/mendcode") } }
    }))
  } finally { await manager.stop() }
}
export type LspCase = Awaited<ReturnType<typeof lspCases>>[number]

export function lspScene(scene: LspCase, width: number, height: number) {
  const turnId = ids("turn"), userId = ids("item"), toolId = ids("item")
  const title = callTitle({ name: "lsp", args: scene.input, callId: "local-lsp" })
  const preview = title.replace(/^lsp: /, "")
  const turn = { turnId, at: NOW, seq: 1, preview, outcome: "completed", items: [
    { itemId: userId, kind: "user_message", text: preview, status: "ok" },
    { itemId: toolId, kind: "tool_call", tool: "lsp", title, text: scene.result.output, status: scene.result.isError ? "error" : "ok" },
  ] }
  const h = parityHarness({ width, height, reply: (command) => command.type === "session.history" ? { ok: true, result: { turns: [turn] } } : undefined })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userId, status: "ok", text: preview })
  chat.emit({ type: "item.started", turnId, itemId: toolId, kind: "tool_call", meta: { tool: title } })
  chat.emit({ type: "item.completed", itemId: toolId, status: scene.result.isError ? "error" : "ok", text: scene.result.output, meta: scene.result.meta })
  chat.emit({ type: "turn.completed", turnId })
  h.app.render()
  return h
}
