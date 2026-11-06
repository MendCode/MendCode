import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type PermissionMode, type SessionId } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { classifySmart, createNativeEngine, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"

const ids = createIdFactory()
const project = realpathSync(mkdtempSync(join(tmpdir(), "read-only-session-")))
afterAll(() => rmSync(project, { recursive: true, force: true }))

const call = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name, args } }, { type: "finish", reason: "tool_calls" }]
const stop: ModelEvent[] = [{ type: "text", delta: "ok" }, { type: "finish", reason: "stop" }]

/** One turn on `mode` in which the model runs each command; returns what actually ran and what the model was told. */
async function run(commands: string[], options: { mode: PermissionMode; readOnly: boolean; permissionAllow?: string[] }) {
  const steps: ModelEvent[][] = [...commands.map((command) => call("shell", { command })), stop]
  const requests: ModelRequest[] = []
  const provider: ModelProvider = { id: "scripted", model: "script-1", async *stream(request) { requests.push({ ...request, messages: structuredClone(request.messages) }); yield* steps.shift() ?? stop } }
  const ran: string[] = []
  const shell = defineTool({ name: "shell", description: "shell", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command }) => (ran.push(command), { output: "done", truncated: false, title: "s", isError: false }) })
  const sessionId: SessionId = ids("session")
  const engine = createNativeEngine({
    provider, tools: [shell], history: memoryHistory(), cwdFor: () => project, system: () => "sys", compactionPrompt: "summarize",
    permissionPolicy: () => ({ experimental: { continue_loop_on_deny: true } }),
    ...(options.permissionAllow ? { permissionAllow: () => options.permissionAllow! } : {}),
    tasks: { run: async () => { throw new Error("no") }, status: async () => "", isChild: () => options.readOnly, readOnly: () => options.readOnly },
  })
  const asked: unknown[] = []
  const input: TurnInput = {
    permissionMode: () => options.mode, setPermissionMode: () => {}, sessionId, turnId: ids("turn"), text: "go", attachments: [],
    signal: new AbortController().signal, newItemId: () => ids("item"), emit: (_event: EngineEvent) => {},
    ask: async (request) => (asked.push(request), { kind: "deny", reason: "nobody answered" }),
  }
  await engine.runTurn(input)
  return { ran, asked, told: requests.at(-1)!.messages.filter((message) => (message as { role: string }).role === "tool").map((message) => (message as { output: string }).output) }
}

describe("a read-only session (/btw)", () => {
  test("touch and mv are refused in smart mode and never reach an approval; the main session still runs them", async () => {
    const side = await run(["touch notes.txt", "mv a.txt b.txt"], { mode: "smart", readOnly: true })
    expect(side.ran).toEqual([])
    expect(side.asked).toEqual([])
    expect(side.told.join("\n")).toContain("read-only")
    expect((await run(["touch notes.txt", "mv a.txt b.txt"], { mode: "smart", readOnly: false })).ran).toEqual(["touch notes.txt", "mv a.txt b.txt"])
  })

  test("read-only commands still run", async () => {
    expect((await run(["ls -la", "git status -sb", "rg -n foo src"], { mode: "smart", readOnly: true })).ran).toEqual(["ls -la", "git status -sb", "rg -n foo src"])
  })

  test("project checks, user-allowed prefixes, redirection into a file and sort -o are refused too", async () => {
    const commands = ["bun test", "make build", "echo hi > out.txt", "sort -o out.txt in.txt", "mkdir x", "cp a b"]
    expect((await run(commands, { mode: "smart", readOnly: true, permissionAllow: ["make build"] })).ran).toEqual([])
  })
})

describe("the classification behind it", () => {
  const shell = (command: string, readOnly: boolean) => classifySmart({ tool: { name: "shell", permission: "execute" }, args: { command }, cwd: project, readOnly })
  test.each(["touch a", "mv a b", "cp a b", "mkdir d", "bun test", "echo x > f", "cat a | tee b", "sort -o b a", "ls && touch a"])("%s is refused when read-only, and the answer is not left behind for the next call", (command) => {
    expect(shell(command, true).decision).toBe("ask")
    const normal = shell("touch a", false)
    expect(normal.decision).toBe("allow")
  })
  test.each(["ls", "cat package.json", "git log --oneline", "rg foo", "echo hi > /dev/null", "sort a"])("%s still passes when read-only", (command) => {
    expect(shell(command, true).decision).toBe("allow")
  })
})
