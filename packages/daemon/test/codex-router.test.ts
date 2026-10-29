import { expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import { withCodexEngine } from "../src/codex-router"

test("Codex routing is lazy, closes the selected process and leaves shell/compaction with the appropriate engine", async () => {
  const ids = createIdFactory()
  const native = ids("session"), codex = ids("session")
  const calls: string[] = []
  const base: EnginePort = { runTurn: async () => (calls.push("native"), { status: "ok" }), runShell: async () => (calls.push("shell"), { status: "ok" }), needsCompaction: () => true, compact: async () => (calls.push("compact"), { status: "ok" }), contextReport: async () => { throw new Error("native context") } }
  const router = withCodexEngine({ base, usesCodex: (id, override) => id === codex || override?.model === "codex:test", create: async () => ({ ...base, runTurn: async () => (calls.push("codex"), { status: "ok" }), stop: () => { calls.push("stop") } }) })
  const input: TurnInput = { sessionId: native, turnId: ids("turn"), text: "check", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {} }
  expect(calls).toEqual([])
  await router.runTurn(input)
  await router.runTurn({ ...input, sessionId: codex })
  await router.runTurn({ ...input, selection: { model: { model: "codex:test" } } })
  await router.runShell!(input)
  expect(calls).toEqual(["native", "codex", "stop", "codex", "stop", "shell"])
  expect(router.needsCompaction(codex)).toBe(false)
  expect(router.needsCompaction(native)).toBe(true)
  expect(await router.compact({ sessionId: codex, turnId: ids("turn"), signal: input.signal, newItemId: input.newItemId, emit: input.emit })).toEqual({ status: "ok" })
  expect(calls).not.toContain("compact")
  expect(router.contextReport!(codex)).rejects.toThrow("Codex manages")
})
