import { describe, expect, test } from "bun:test"
import { helpText, parseAutomation, runAutomation, type Automation, type AutomationDeps } from "../src/automation"

function parse(...args: string[]) {
  const result = parseAutomation(args)
  if (result.ok !== true) throw new Error(JSON.stringify(result))
  return result.command
}
const failure = (...args: string[]) => {
  const result = parseAutomation(args)
  expect(result.ok).toBe(false)
}

describe("B19 automation", () => {
  test("default status and every memory operation have the control-plane alias", () => {
    expect(parse("memory")).toMatchObject({ kind: "memory.control", input: { operation: "status" } })
    for (const args of [["status"], ["preview", "release", "--mode", "after-compaction", "--provider", "p", "--model", "m"], ["edit", "mem_1", "new text", "--scope", "global"], ["delete", "mem_1"], ["propose", "fact", "--tags", "a,b"], ["apply", "mem_1"], ["reject", "mem_1"], ["index"], ["config", "--project", "--use"], ["import-codex", "--from", "/tmp/notes", "--apply", "--max-proposals", "4"]]) {
      expect(parse("control-plane", "memory", ...args)).toEqual(parse("memory", ...args))
    }
    expect(parse("memory", "propose", "--from-file", "notes.txt", "--max-proposals", "2")).toMatchObject({ input: { scope: "project", fromFile: "notes.txt", maxProposals: 2 } })
    expect(parse("memory", "edit", "mem_1", "new", "--scope", "global")).toMatchObject({ input: { scope: "user", text: "new" } })
    expect(parse("control-plane", "memory", "search", "old fact")).toMatchObject({ kind: "memory.search", query: "old fact" })
  })
  test("Dream aliases and consolidation flags keep their literal meaning", () => {
    expect(parse("memory", "dream")).toMatchObject({ kind: "dream.control", input: { operation: "status" } })
    for (const operation of ["status", "tick", "run", "consolidate"]) expect(parse("control-plane", "memory", "dream", operation)).toEqual(parse("memory", "dream", operation))
    expect(parse("memory", "dream", "run", "--preview")).toMatchObject({ input: { policy: "preview" } })
    expect(parse("memory", "dream", "consolidate", "--auto")).toMatchObject({ input: { policy: "auto-consolidate" } })
    failure("memory", "dream", "run", "--preview", "--auto")
    expect(parse("memory", "dream", "consolidate", "--auto", "--deterministic")).toMatchObject({ input: { policy: "auto-consolidate", deterministic: true } })
    failure("memory", "dream", "status", "--deterministic")
  })
  test("v1 configuration flags and input/output aliases become validated settings patches", () => {
    expect(parse("memory", "config", "--disable")).toMatchObject({ input: { patch: { memoryEnabled: false, memoryUse: false, memoryGenerate: false } } })
    expect(parse("memory", "config", "--enable", "--input", "--output", "--max-prompt-tokens", "200", "--max-entries", "12", "--project-max-entries", "4", "--global-compaction-max-entries", "8", "--dream-consolidation-policy", "preview", "--project")).toMatchObject({ input: { project: true, patch: { memoryEnabled: true, memoryUse: true, memoryGenerate: true, memoryMaxPromptTokens: 200, memoryMaxEntries: 12, memoryProjectMaxEntries: 4, memoryGlobalCompactionMaxEntries: 8, dreamConsolidationPolicy: "preview" } } })
    expect(parse("memory", "config", "--no-input", "--no-output")).toMatchObject({ input: { patch: { memoryUse: false, memoryGenerate: false } } })
    for (const args of [["edit", "mem_1"], ["apply"], ["reject"], ["delete"], ["preview", "--mode", "wrong"], ["propose", "text", "--from-file", "p"], ["propose"], ["config", "--max-entries", "NaN"], ["config", "--project-max-entries", "1.5"], ["config", "--dream-consolidation-policy", "wrong"], ["config", "--use", "--no-use"], ["import-codex", "--max-proposals", "51"]]) failure("memory", ...args)
    expect(helpText("memory")).toContain("import-codex")
    expect(helpText("memory")).toContain("dream [status|tick|run|consolidate]")
  })
  test("CLI sends one daemon command and prints v2 JSON envelopes or the v1-style human JSON", async () => {
    const sent: unknown[] = []
    const output: string[] = []
    const deps = { client: { send: async (command: unknown) => { sent.push(command); return { ok: true, result: { counts: { pending: 2 } } } } }, listen() {}, out: { write: (text: string) => output.push(text) }, err: { write() {} }, cwd: "/repo", now: () => 0, onInterrupt() {} } as unknown as AutomationDeps
    expect(await runAutomation(parse("memory", "status", "--json"), deps)).toBe(0)
    expect(sent).toEqual([{ type: "memory.control", directory: "/repo", input: { operation: "status" } }])
    expect(JSON.parse(output[0]!)).toMatchObject({ schema: "mendcode-next.cli.v1", kind: "result", command: "memory.status", data: { counts: { pending: 2 } } })
    output.length = 0
    expect(await runAutomation(parse("memory", "status"), deps)).toBe(0)
    expect(JSON.parse(output[0]!)).toEqual({ counts: { pending: 2 } })
  })
  test("a failed Dream run exits 1, and daemon refusals are errors", async () => {
    const output: string[] = []
    const deps = { client: { send: async () => ({ ok: true, result: { run: { status: "failed" } } }) }, listen() {}, out: { write: (text: string) => output.push(text) }, err: { write: (text: string) => output.push(text) }, cwd: "/repo", now: () => 0, onInterrupt() {} } as unknown as AutomationDeps
    expect(await runAutomation(parse("memory", "dream", "run", "--json"), deps)).toBe(1)
    expect(JSON.parse(output[0]!)).toMatchObject({ command: "memory.dream.run", data: { run: { status: "failed" } } })
    deps.client.send = async () => ({ ok: false, error: { code: "invalid_command", message: "Memory not found" } })
    expect(await runAutomation(parse("memory", "delete", "mem_1") as Automation, deps)).toBe(1)
    expect(output.at(-1)).toBe("error: Memory not found\n")
  })
})
