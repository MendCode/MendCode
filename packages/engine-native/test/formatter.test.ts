import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { applyPatch, edit, write } from "@mendcode/tools"
import { createAfterWrite, createFormatterManager, createLspManager } from "../../lsp/src"
import { formatterFixture } from "../../lsp/test/formatter-fixtures"
import { put } from "../../lsp/test/helpers"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelMessage, type ModelProvider } from "../src"

test("native write/edit/large patch format every written destination before the next model call; failed edits stay untouched", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "native-format-")))
  const formatter = createFormatterManager({ which: () => null })
  const lsp = createLspManager({ registryLoader: () => ({ servers: [], issues: [] }), which: () => null })
  try {
    const { command } = formatterFixture(cwd)
    put({ root: cwd, path: ".mendcode/formatter.json", content: JSON.stringify({ prettier: { command }, oxfmt: { disabled: true }, biome: { disabled: true } }) })
    put({ root: cwd, path: "old.ts", content: "old\n" })
    put({ root: cwd, path: "gone.ts", content: "deleted\n" })
    const patch = ["*** Begin Patch", "*** Update File: old.ts", "*** Move to: new.ts", "@@", "-old", "+BAD", "*** Delete File: gone.ts", ...Array.from({ length: 12 }, (_, i) => `*** Add File: ${i}.ts\n+BAD`), "*** End Patch"].join("\n")
    const call = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: `call-${name}`, name, args } }, { type: "finish", reason: "tool_calls" }]
    const steps = [call("write", { path: "write.ts", content: "BAD" }), call("edit", { path: "write.ts", oldString: "GOOD", newString: "BAD edited" }), call("apply_patch", { patch }), call("edit", { path: "new.ts", oldString: "missing", newString: "BAD" }), [{ type: "finish", reason: "stop" } as ModelEvent]]
    const messages: ModelMessage[][] = []
    const provider: ModelProvider = { id: "fake", model: "fake", async *stream(request) {
      messages.push(structuredClone(request.messages))
      if (messages.length === 2) expect(readFileSync(join(cwd, "write.ts"), "utf8")).toBe("GOOD")
      if (messages.length === 3) expect(readFileSync(join(cwd, "write.ts"), "utf8")).toBe("GOOD edited")
      if (messages.length === 4) for (const path of ["new.ts", ...Array.from({ length: 12 }, (_, i) => `${i}.ts`)]) expect(readFileSync(join(cwd, path), "utf8").trim()).toBe("GOOD")
      yield* steps.shift()!
    } }
    const hook = createAfterWrite({ manager: lsp, formatter })
    const paths: string[][] = []
    const abort = new AbortController(), ids = createIdFactory()
    const engine = createNativeEngine({ provider, tools: [write, edit, applyPatch], history: memoryHistory(), cwdFor: () => cwd, system: () => "sys", compactionPrompt: "summarize", afterWrite: async (input) => {
      expect(input.signal).toBe(abort.signal)
      paths.push(input.paths)
      return hook(input)
    } })
    expect(await engine.runTurn({ sessionId: ids("session"), turnId: ids("turn"), text: "change files", attachments: [], signal: abort.signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "approve", scope: "once" }), permissionMode: () => "full", setPermissionMode: () => {} })).toEqual({ status: "ok" })
    expect(paths).toHaveLength(3)
    expect(paths[2]).toEqual(["new.ts", ...Array.from({ length: 12 }, (_, i) => `${i}.ts`)])
    expect(messages.at(-1)!.at(-1)).toMatchObject({ role: "tool", isError: true })
  } finally {
    await formatter.stop()
    await lsp.stop()
    rmSync(cwd, { recursive: true, force: true })
  }
})
