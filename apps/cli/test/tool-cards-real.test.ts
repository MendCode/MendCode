import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { applyPatch, edit, glob, grep, ls, notebookEdit, read, shell, write } from "../../../packages/tools/src"
import { createNativeEngine, memoryHistory, todoTool, type ModelEvent, type ModelProvider } from "@mendcode/engine-native"
import { glyphs } from "../src/ui/theme"
import { createTranscript, type PresentationMode } from "../src/view/transcript"

/**
 * Each local tool runs for real through the native engine and its events are drawn by the real transcript: a card written
 * against a text the tool never produces (apply_patch once drew only `M path`, its diff lived in the approval preview) fails here.
 */
const ids = createIdFactory()
const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function cards(mode: PresentationMode) {
  const dir = mkdtempSync(join(tmpdir(), "tool-cards-real-"))
  temps.push(dir)
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1\nexport const b = 2\n")
  writeFileSync(join(dir, "src/b.ts"), "import { a } from './a'\nconsole.log(a)\n")
  writeFileSync(join(dir, "nb.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["x = 1\n"], metadata: {}, outputs: [], execution_count: null, id: "c1" }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
  const calls: Array<[string, unknown]> = [
    ["read", { path: "src/a.ts" }],
    ["ls", { path: "src" }],
    ["glob", { pattern: "**/*.ts" }],
    ["grep", { pattern: "export", path: "src" }],
    ["edit", { path: "src/a.ts", oldString: "const a = 1", newString: "const a = 10" }],
    ["write", { path: "src/c.ts", content: "export const c = 3\n" }],
    ["apply_patch", { patch: ["*** Begin Patch", "*** Update File: src/b.ts", "@@", "-console.log(a)", "+console.info(a)", "*** Add File: src/d.ts", "+export const d = 4", "*** End Patch"].join("\n") }],
    ["shell", { command: "printf 'one\\ntwo\\n'" }],
    ["notebook_edit", { path: "nb.ipynb", action: "replace", cellId: "c1", source: "x = 2" }],
    ["todo", { items: [{ text: "first", status: "completed" }, { text: "second", status: "in_progress" }] }],
  ]
  const steps: ModelEvent[][] = [...calls.map(([name, args]): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name, args } }, { type: "finish", reason: "tool_calls" }]), [{ type: "text", delta: "done" }, { type: "finish", reason: "stop" }]]
  const provider: ModelProvider = { id: "scripted", model: "script-1", async *stream() { yield* steps.shift()! } }
  const engine = createNativeEngine({ provider, tools: [read, ls, glob, grep, edit, write, applyPatch, shell, notebookEdit, todoTool], history: memoryHistory(), cwdFor: () => dir, system: () => "sys", compactionPrompt: "summarize" })
  const events: EngineEvent[] = []
  const sessionId = ids("session"), turnId = ids("turn")
  const input: TurnInput = { permissionMode: () => "full", setPermissionMode: () => {}, sessionId, turnId, text: "go", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "approve", scope: "once" }) }
  await engine.runTurn(input)
  let seq = 0
  const transcript = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full", userIcon: "●", userLead: "", userLabel: true, assistantLead: "", userTint: false }, glyphs: glyphs({}), mode, now: () => 10_000 })
  transcript.setAppearance({ reasoning: "auto", toolOutput: "auto", toolDensity: "standard", timestamps: false })
  for (const event of [{ type: "turn.started", turnId, queueId: ids("queue") }, ...events.filter((event) => event.type.startsWith("item.") && event.type !== "item.delta")]) transcript.apply({ sessionId, seq: ++seq, at: 1_000 + seq, turnId, ...event } as unknown as SessionEvent)
  return transcript.viewport(100, 400).map((line) => line.text.trimEnd()).filter((line) => line.trim())
}

test("every local tool's real result draws its own card, not the fallback", async () => {
  const balanced = await cards("balanced")
  const has = (lines: string[], pattern: RegExp) => expect(lines.some((line) => pattern.test(line))).toBe(true)
  has(balanced, /Edit src\/a\.ts {2}\+1 −1/)
  has(balanced, /1 \+ export const a = 10/)
  has(balanced, /Write src\/c\.ts {2}created/)
  has(balanced, /Patch src\/b\.ts {2}\+1 −1/)
  has(balanced, /2 \+ console\.info\(a\)/)
  has(balanced, /Add src\/d\.ts {2}\+1/)
  expect(balanced.some((line) => /│ [MAD] src\//.test(line))).toBe(false)
  has(balanced, /\$ printf/)
  has(balanced, /│ two/)
  has(balanced, /Notebook nb\.ipynb/)
  has(balanced, /now \[0\] code c1 · x = 2/)
  has(balanced, /Todos 1\/2/)
  const full = await cards("full")
  has(full, /Read src\/a\.ts {2}2 lines/)
  has(full, /List src {2}2 entries/)
  has(full, /Glob \*\*\/\*\.ts {2}2 files/)
  has(full, /Grep "export" {2}2 matches in 1 file/)
  expect(full.some((line) => /failed/.test(line))).toBe(false)
})
