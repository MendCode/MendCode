import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { createCodexEngine } from "@mendcode/engine-codex"
import { createMemoryAppender, createRunLimitsStore } from "../src/run-limits"

/** A Codex app-server that answers a thread and one turn, and keeps every request it got. */
function fakeCodex() {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let done = false
  let exit!: (code: number) => void
  const requests: Array<{ method: string; params: any }> = []
  const push = (message: unknown) => { queue.push(JSON.stringify(message)); wake?.() }
  const answer = (method: string) => method === "initialize" ? { userAgent: "fake" } : method === "thread/start" ? { thread: { id: "thr1" }, model: "gpt-6-luna" } : method === "turn/start" ? { turn: { id: "turn1", status: "inProgress" } } : {}
  const transport = {
    write(line: string) {
      const message = JSON.parse(line)
      if (!message.method || message.id === undefined) return
      requests.push({ method: message.method, params: message.params })
      push({ jsonrpc: "2.0", id: message.id, result: answer(message.method) })
      if (message.method === "turn/start") setTimeout(() => push({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thr1", turn: { id: "turn1", status: "completed" } } }), 1)
    },
    lines: (async function* () {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    })(),
    close: () => { done = true; wake?.(); exit(1) },
    exited: new Promise<number>((resolve) => (exit = resolve)),
  }
  return { transport, requests }
}

const BLOCK = "<mendcode_memory>\n- [project/commands] Run tests with bun test\n</mendcode_memory>"

async function codexInstructions(sessionId: SessionId, appender: ReturnType<typeof createMemoryAppender>) {
  const fake = fakeCodex()
  const ids = createIdFactory()
  const engine = createCodexEngine({ cwd: "/repo", appendSystem: appender.forSession(() => "Terminal rendering.", sessionId), transportFactory: () => fake.transport as never })
  expect(await engine.runTurn({ sessionId, turnId: ids("turn"), text: "check", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {} })).toEqual({ status: "ok" })
  engine.stop()
  return fake.requests.find((request) => request.method === "thread/start")?.params.developerInstructions as string | undefined
}

test("the memory block reaches the Codex engine's input, once, after the base text; a PR review child gets none", async () => {
  const ids = createIdFactory()
  const limits = createRunLimitsStore()
  const asked: Array<{ directory: string; prompt: string }> = []
  // The same composition main.ts builds: the selector's block, dropped for a session whose run limits say no memory.
  const appender = createMemoryAppender({ block: (input) => { asked.push({ directory: input.directory, prompt: input.prompt }); return BLOCK }, noMemory: (sessionId) => limits.get(sessionId)?.noMemory === true })
  const chat = ids("session")
  expect(await codexInstructions(chat, appender)).toBe(`Terminal rendering.\n\n${BLOCK}`)
  // Chosen without a prompt, so the text stays the same on every turn and the cached prefix holds.
  expect(asked).toEqual([{ directory: "/repo", prompt: "" }])
  const review = ids("session")
  limits.configure(review, { noMemory: true, noContextFiles: true })
  expect(await codexInstructions(review, appender)).toBe("Terminal rendering.")
  expect(appender.perSession(() => undefined)("/repo", chat)).toBe(BLOCK)
  expect(appender.perSession(() => undefined)("/repo", review)).toBeUndefined()
})

test("main.ts appends memory to every engine that runs whole sessions: Claude Code, Codex, pi and ACP agents", () => {
  const source = readFileSync(path.join(import.meta.dir, "../src/main.ts"), "utf8")
  const wired = [...source.matchAll(/appendSystem(?::|,)\s*([^\n]*)/g)].map((match) => match[1]!)
  // Each engine's appendSystem goes through the appender (withMemory for Codex, withMemoryFor for the shared engines), never around it.
  const engines = [...source.matchAll(/appendSystem(?:: | = )(withMemory(?:For)?)\(/g)].map((match) => match[1])
  expect(engines.filter((name) => name === "withMemory")).toHaveLength(1)
  expect(engines.filter((name) => name === "withMemoryFor").length).toBeGreaterThanOrEqual(3)
  expect(wired.filter((line) => line.includes("harnessSystem") && !/withMemory(For)?\(/.test(line))).toEqual([])
})
