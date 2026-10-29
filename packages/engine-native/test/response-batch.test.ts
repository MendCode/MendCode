import { describe, expect, test } from "bun:test"
import { defineTool, type Tool } from "@mendcode/tools"
import type { EngineResolution } from "@mendcode/kernel"
import type { PermissionMode } from "@mendcode/protocol"
import { z } from "zod"
import { createNativeEngine, memoryHistory, type ModelEvent } from "../src"
import { scriptedProvider, stop, turn } from "./harness"

type Call = { id: string; name: string; args: unknown }
/** One model response carrying several tool calls, in this order. */
const respond = (...calls: Call[]): ModelEvent[] => [...calls.map((call) => ({ type: "tool_call" as const, call: { callId: call.id, name: call.name, args: call.args } })), { type: "finish", reason: "tool_calls" }]
const SKIPPED = (tool: string) => `skipped: the earlier ${tool} call of this response failed, so this call did not run. Fix that edit first, then send this call again.`

/** Tools that record when they start and finish, so a test sees both order and overlap. */
function tools(log: string[], abort?: AbortController) {
  const recorded = ({ name, permission, run }: { name: string; permission: Tool["permission"]; run?: (text: string) => { output: string; isError: boolean } }) =>
    defineTool({
      name,
      description: name,
      permission,
      args: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        log.push(`start ${name} ${text}`)
        await Bun.sleep(text.includes("slow") ? 30 : 1)
        if (text.includes("cancel")) abort?.abort()
        log.push(`end ${name} ${text}`)
        const result = run?.(text) ?? { output: `${name} ${text}`, isError: text.includes("fail") }
        return { ...result, truncated: false, title: name }
      },
    })
  return [
    recorded({ name: "look", permission: "read" }),
    recorded({ name: "run", permission: "execute" }),
    recorded({ name: "apply_patch", permission: "write", run: (text) => (text.includes("fail") ? { output: "apply_patch: context not found", isError: true } : { output: `patched ${text}`, isError: false }) }),
    recorded({ name: "write", permission: "write" }),
    recorded({ name: "edit", permission: "write" }),
  ]
}

async function run({ calls, mode = "full", answers, abort }: { calls: Call[]; mode?: PermissionMode; answers?: EngineResolution[]; abort?: AbortController }) {
  const log: string[] = []
  const { provider, requests } = scriptedProvider([respond(...calls), stop("done")])
  const history = memoryHistory()
  const engine = createNativeEngine({ provider, tools: tools(log, abort), history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
  const { input, events } = turn({ text: "go", mode: () => mode, ...(answers ? { answers } : {}), ...(abort ? { signal: abort.signal } : {}) })
  const outcome = await engine.runTurn(input)
  const saved = (await history.load(input.sessionId)) ?? []
  const results = saved.flatMap((message) => (message.role === "tool" ? [{ id: message.callId, output: message.output, isError: message.isError }] : []))
  return { log, requests, results, events, outcome }
}

describe("several tool calls in one model response", () => {
  test("run one at a time in the order the model emitted them, whatever their kind", async () => {
    const { log, results, requests } = await run({ calls: [
      { id: "c1", name: "look", args: { text: "slow a" } },
      { id: "c2", name: "apply_patch", args: { text: "x" } },
      { id: "c3", name: "run", args: { text: "slow test" } },
      { id: "c4", name: "look", args: { text: "b" } },
    ] })
    expect(log).toEqual(["start look slow a", "end look slow a", "start apply_patch x", "end apply_patch x", "start run slow test", "end run slow test", "start look b", "end look b"])
    expect(results).toEqual([
      { id: "c1", output: "look slow a", isError: false },
      { id: "c2", output: "patched x", isError: false },
      { id: "c3", output: "run slow test", isError: false },
      { id: "c4", output: "look b", isError: false },
    ])
    // The next request answers every call id exactly once, in the same order.
    expect(requests[1]!.messages.flatMap((message) => (message.role === "tool" ? [message.callId] : []))).toEqual(["c1", "c2", "c3", "c4"])
  })

  test("a failed write stops the rest of the response: earlier results stay, later calls are skipped and say why", async () => {
    const { log, results, requests, events } = await run({ calls: [
      { id: "c1", name: "look", args: { text: "before" } },
      { id: "c2", name: "apply_patch", args: { text: "fail" } },
      { id: "c3", name: "run", args: { text: "bun test" } },
      { id: "c4", name: "write", args: { text: "other file" } },
      { id: "c5", name: "look", args: { text: "after" } },
    ] })
    expect(log).toEqual(["start look before", "end look before", "start apply_patch fail", "end apply_patch fail"])
    expect(results).toEqual([
      { id: "c1", output: "look before", isError: false },
      { id: "c2", output: "apply_patch: context not found", isError: true },
      { id: "c3", output: SKIPPED("apply_patch"), isError: true },
      { id: "c4", output: SKIPPED("apply_patch"), isError: true },
      { id: "c5", output: SKIPPED("apply_patch"), isError: true },
    ])
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.flatMap((message) => (message.role === "tool" ? [message.callId] : []))).toEqual(["c1", "c2", "c3", "c4", "c5"])
    // A skipped call still has a card, closed as an error with the same text.
    expect(events.filter((event) => event.type === "item.started" && event.kind === "tool_call")).toHaveLength(5)
    expect(events.filter((event) => event.type === "item.completed" && event.status === "error" && event.text === SKIPPED("apply_patch"))).toHaveLength(3)
  })

  test.each(["write", "edit"])("a failed %s counts like a failed apply_patch", async (name) => {
    const { log, results } = await run({ calls: [{ id: "c1", name, args: { text: "fail" } }, { id: "c2", name: "run", args: { text: "check" } }] })
    expect(log).toEqual([`start ${name} fail`, `end ${name} fail`])
    expect(results.map((result) => result.output)).toEqual([`${name} fail`, SKIPPED(name)])
  })

  test("a write with invalid arguments or refused by a rule is a failed write too", async () => {
    const invalid = await run({ calls: [{ id: "c1", name: "apply_patch", args: { nope: 1 } }, { id: "c2", name: "run", args: { text: "check" } }] })
    expect(invalid.log).toEqual([])
    expect(invalid.results[0]!.output).toContain("invalid arguments for apply_patch")
    expect(invalid.results[1]).toEqual({ id: "c2", output: SKIPPED("apply_patch"), isError: true })

    // Plan mode refuses every change by rule and the turn goes on: the check after it must not run against unchanged files.
    const planned = await run({ mode: "plan", calls: [{ id: "c1", name: "look", args: { text: "a" } }, { id: "c2", name: "write", args: { text: "x" } }, { id: "c3", name: "look", args: { text: "b" } }] })
    expect(planned.log).toEqual(["start look a", "end look a"])
    expect(planned.results[1]!.output).toContain("denied by permission rule")
    expect(planned.results[2]).toEqual({ id: "c3", output: SKIPPED("write"), isError: true })
    expect(planned.requests).toHaveLength(2)
  })

  test("a write the user denies ends the turn as before, with a result for every call and nothing else run", async () => {
    const { log, results, requests, outcome } = await run({ mode: "ask", answers: [{ kind: "deny", reason: "no" }], calls: [
      { id: "c1", name: "look", args: { text: "a" } },
      { id: "c2", name: "write", args: { text: "x" } },
      { id: "c3", name: "look", args: { text: "b" } },
    ] })
    expect(outcome).toEqual({ status: "ok" })
    expect(log).toEqual(["start look a", "end look a"])
    expect(results).toEqual([
      { id: "c1", output: "look a", isError: false },
      { id: "c2", output: "denied by user: no", isError: true },
      { id: "c3", output: "cancelled", isError: true },
    ])
    expect(requests).toHaveLength(1)
  })

  test("a response without a failed write is unchanged: a failed read or command does not skip what follows", async () => {
    const { log, results } = await run({ calls: [
      { id: "c1", name: "look", args: { text: "fail" } },
      { id: "c2", name: "look", args: { text: "b" } },
      { id: "c3", name: "run", args: { text: "fail" } },
      { id: "c4", name: "apply_patch", args: { text: "ok" } },
      { id: "c5", name: "look", args: { text: "c" } },
    ] })
    expect(log.filter((line) => line.startsWith("start"))).toEqual(["start look fail", "start look b", "start run fail", "start apply_patch ok", "start look c"])
    expect(results.map((result) => result.isError)).toEqual([true, false, true, false, false])
    expect(results.some((result) => result.output.startsWith("skipped"))).toBe(false)
  })

  test("a skip lasts for one response only: the model's next response runs normally", async () => {
    const log: string[] = []
    const { provider, requests } = scriptedProvider([
      respond({ id: "c1", name: "apply_patch", args: { text: "fail" } }, { id: "c2", name: "run", args: { text: "check" } }),
      respond({ id: "c3", name: "apply_patch", args: { text: "fixed" } }, { id: "c4", name: "run", args: { text: "check" } }),
      stop("done"),
    ])
    const engine = createNativeEngine({ provider, tools: tools(log), history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
    await engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(log.filter((line) => line.startsWith("start"))).toEqual(["start apply_patch fail", "start apply_patch fixed", "start run check"])
    expect(requests[2]!.messages.flatMap((message) => (message.role === "tool" ? [message.output] : []))).toEqual(["apply_patch: context not found", SKIPPED("apply_patch"), "patched fixed", "run check"])
  })

  test("cancelling during a call leaves the later calls unrun and cancelled, each with its result", async () => {
    const abort = new AbortController()
    const { log, results, requests } = await run({ abort, calls: [
      { id: "c1", name: "look", args: { text: "a" } },
      { id: "c2", name: "run", args: { text: "cancel here" } },
      { id: "c3", name: "apply_patch", args: { text: "x" } },
      { id: "c4", name: "look", args: { text: "b" } },
    ] })
    expect(log).toEqual(["start look a", "end look a", "start run cancel here", "end run cancel here"])
    expect(results.map((result) => result.id)).toEqual(["c1", "c2", "c3", "c4"])
    expect(results.slice(2)).toEqual([{ id: "c3", output: "cancelled", isError: true }, { id: "c4", output: "cancelled", isError: true }])
    expect(requests).toHaveLength(1)
  })

  test("cancelling during a write that fails reports the rest as cancelled, not as skipped", async () => {
    const abort = new AbortController()
    const { log, results, requests } = await run({ abort, calls: [
      { id: "c1", name: "apply_patch", args: { text: "fail and cancel" } },
      { id: "c2", name: "run", args: { text: "check" } },
      { id: "c3", name: "look", args: { text: "b" } },
    ] })
    expect(log).toEqual(["start apply_patch fail and cancel", "end apply_patch fail and cancel"])
    expect(results.map((result) => [result.id, result.output])).toEqual([["c1", "apply_patch: context not found"], ["c2", "cancelled"], ["c3", "cancelled"]])
    expect(requests).toHaveLength(1)
  })
})

describe("one tree", () => {
  test("every result is reported with the files it wrote, and a line One tree returns ends that result", async () => {
    const log: string[] = []
    const heard: Array<{ written: string[]; output: string; cwd: string }> = []
    const { provider, requests } = scriptedProvider([
      respond({ id: "c1", name: "write", args: { text: "a" } }),
      respond({ id: "c2", name: "look", args: { text: "b" } }),
      stop("done"),
    ])
    const writeWithPath = defineTool({ name: "write", description: "write", permission: "write", args: z.object({ text: z.string(), path: z.string().default("a.ts") }), execute: async () => ({ output: "wrote", truncated: false, title: "write", isError: false }) })
    const engine = createNativeEngine({
      provider, tools: [...tools(log).filter((tool) => tool.name !== "write"), writeWithPath], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize",
      oneTree: ({ written, output, cwd }) => {
        heard.push({ written, output, cwd })
        return output === "look b" ? "[one tree] a.ts is «Pets»'s" : undefined
      },
    })
    await engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(heard).toEqual([{ written: ["a.ts"], output: "wrote", cwd: "/repo" }, { written: [], output: "look b", cwd: "/repo" }])
    expect(requests[2]!.messages.flatMap((message) => (message.role === "tool" ? [message.output] : []))).toEqual(["wrote", "look b\n[one tree] a.ts is «Pets»'s"])
  })
})

describe("late notes of the write hook", () => {
  test("the hook is told the session, and what it learns later is appended once to that session's next tool result", async () => {
    const log: string[] = []
    const sessions: Array<string | undefined> = []
    const pending = new Map<string, string>()
    const { provider, requests } = scriptedProvider([
      respond({ id: "c1", name: "write", args: { text: "a" } }),
      respond({ id: "c2", name: "look", args: { text: "b" } }),
      respond({ id: "c3", name: "look", args: { text: "c" } }),
      stop("done"),
    ])
    const writeWithPath = defineTool({ name: "write", description: "write", permission: "write", args: z.object({ text: z.string(), path: z.string().default("a.ts") }), execute: async () => ({ output: "wrote", truncated: false, title: "write", isError: false }) })
    const engine = createNativeEngine({
      provider,
      tools: [...tools(log).filter((tool) => tool.name !== "write"), writeWithPath],
      history: memoryHistory(),
      cwdFor: () => "/repo",
      system: () => "sys",
      compactionPrompt: "summarize",
      afterWrite: async ({ sessionId }) => {
        sessions.push(sessionId)
        // Nothing within the bound; the error turns up after the result was sent.
        pending.set(sessionId!, "\n\nDiagnostics:\na.ts:1:1 error late")
        return undefined
      },
      lateWriteNotes: (sessionId) => {
        const text = pending.get(sessionId)
        pending.delete(sessionId)
        return text
      },
    })
    const { input } = turn({ text: "go", mode: () => "full" })
    await engine.runTurn(input)
    expect(sessions).toEqual([input.sessionId])
    const outputs = requests[3]!.messages.flatMap((message) => (message.role === "tool" ? [message.output] : []))
    // The hook's note was registered during the write, so the write's own result already carries it; later results do not repeat it.
    expect(outputs).toEqual(["wrote\n\nDiagnostics:\na.ts:1:1 error late", "look b", "look c"])
  })

  test("a note that arrives between two calls goes on the next result, even a failed one, and a throwing source changes nothing", async () => {
    const log: string[] = []
    let note: string | undefined
    const { provider, requests } = scriptedProvider([
      respond({ id: "c1", name: "look", args: { text: "a" } }),
      respond({ id: "c2", name: "run", args: { text: "fail" } }),
      respond({ id: "c3", name: "look", args: { text: "c" } }),
      respond({ id: "c4", name: "look", args: { text: "d" } }),
      stop("done"),
    ])
    let asked = 0
    const engine = createNativeEngine({
      provider, tools: tools(log), history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize",
      lateWriteNotes: () => {
        asked++
        if (asked === 1) { note = "\n\nDiagnostics:\na.ts:2:1 error arrived"; return undefined }
        if (asked === 4) throw new Error("source broke")
        const text = note
        note = undefined
        return text
      },
    })
    await engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(requests[4]!.messages.flatMap((message) => (message.role === "tool" ? [message.output] : []))).toEqual(["look a", "run fail\n\nDiagnostics:\na.ts:2:1 error arrived", "look c", "look d"])
  })
})
