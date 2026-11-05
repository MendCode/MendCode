import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type AdvisorSettings, type PermissionMode, type SessionId } from "@mendcode/protocol"
import { defineTool, type Tool } from "@mendcode/tools"
import { z } from "zod"
import { ADVISOR_NUDGE_PREFIX, advisorLimits, createNativeEngine, memoryHistory, parseAdvisorVerdict, type AdvisorPort, type AdvisorTrigger, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest } from "../src"

const ids = createIdFactory()
const project = realpathSync(mkdtempSync(join(tmpdir(), "advisor-engine-")))
afterAll(() => rmSync(project, { recursive: true, force: true }))

function scriptedProvider(steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      yield* step
    },
  }
  return { provider, requests }
}

/** A file write large enough for the completion sign-off (see COMPLETION_MIN_CHANGE). */
const SUBSTANTIAL = Array.from({ length: 30 }, (_, line) => `line ${line}`).join("\n")
const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name, args } }, { type: "finish", reason: "tool_calls" }]

const tools = (): Tool[] => [
  defineTool({ name: "write", description: "write a file", permission: "write", args: z.object({ path: z.string(), content: z.string() }), execute: async ({ path }) => ({ output: `wrote ${path}`, truncated: false, title: "write", isError: false }) }),
  defineTool({ name: "shell", description: "run a command", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command }) => ({ output: `error: ${command} failed\nline 2`, truncated: false, title: "shell", isError: true }) }),
  defineTool({ name: "read", description: "read a file", permission: "read", args: z.object({ path: z.string() }), execute: async ({ path }) => ({ output: `contents of ${path}`, truncated: false, title: "read", isError: false }) }),
]

/** An advisor that answers from a script and records every consultation. */
function scriptedAdvisor(answers: string[], options: { enabled?: boolean; limits?: AdvisorSettings } = {}) {
  const consultations: Array<{ trigger: AdvisorTrigger; brief: string }> = []
  const port: AdvisorPort = {
    enabled: () => options.enabled ?? true,
    limits: () => advisorLimits(options.limits),
    consult: async (request) => {
      consultations.push({ trigger: request.trigger, brief: request.brief })
      return { verdict: parseAdvisorVerdict(answers.shift() ?? '{"verdict":"proceed","summary":"fine"}'), model: "gpt-6.1-sol", usage: { provider: "openai", model: "gpt-6.1-sol", input: 1200, output: 80 } }
    },
    diff: async () => "+ fixed line",
  }
  return { port, consultations }
}

function turn(sessionId: SessionId, mode: PermissionMode = "full", answers: EngineResolution[] = []) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const input: TurnInput = {
    permissionMode: () => mode,
    setPermissionMode: (next) => { mode = next },
    sessionId,
    turnId: ids("turn"),
    text: "fix the parser",
    attachments: [],
    signal: new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => (asked.push(request), answers.shift() ?? { kind: "deny", reason: "nobody answered" }),
  }
  return { input, events, asked }
}

function engineFor(steps: ModelEvent[][], advisor: AdvisorPort | undefined) {
  const { provider, requests } = scriptedProvider(steps)
  const history = memoryHistory()
  const engine = createNativeEngine({ provider, tools: tools(), history, cwdFor: () => project, system: () => "sys", compactionPrompt: "summarize", ...(advisor ? { advisor } : {}) })
  return { engine, requests, history }
}

const toolNames = (request: ModelRequest) => request.tools.map((tool) => tool.name)
const advisorResults = (messages: ModelMessage[]) => messages.filter((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool" && message.name === "advisor")

describe("advisor tool", () => {
  test("a session without an advisor model gets no tool and no consultation", async () => {
    const { port, consultations } = scriptedAdvisor([], { enabled: false })
    const { engine, requests } = engineFor([callTool("write", { path: "a.ts", content: SUBSTANTIAL }), stop("done")], port)
    const { input } = turn(ids("session"))
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(toolNames(requests[0]!)).not.toContain("advisor")
    expect(consultations).toHaveLength(0)
  })

  test("the agent's own call returns the verdict and reports usage under the advisor's model, without an approval prompt", async () => {
    const { port, consultations } = scriptedAdvisor(['{"verdict":"proceed","summary":"approach is sound","findings":[],"next":["write the test first"]}'])
    const { engine, requests } = engineFor([callTool("advisor", { question: "Is a recursive parser fine here?" }), stop("ok")], port)
    const { input, events, asked } = turn(ids("session"), "ask")
    await engine.runTurn(input)
    expect(toolNames(requests[0]!)).toContain("advisor")
    expect(asked).toHaveLength(0)
    expect(consultations.map((entry) => entry.trigger)).toEqual(["tool"])
    expect(consultations[0]!.brief).toContain("Is a recursive parser fine here?")
    expect(consultations[0]!.brief).toContain("fix the parser")
    const result = JSON.parse((requests[1]!.messages.at(-1) as { output: string }).output)
    expect(result).toMatchObject({ trigger: "tool", verdict: "proceed", next: ["write the test first"], model: "gpt-6.1-sol", usage: { input: 1200, output: 80 } })
    expect(events.some((event) => event.type === "usage" && event.model === "gpt-6.1-sol" && event.input === 1200)).toBe(true)
  })

  test("the per-turn cap refuses the agent's extra call with a reason", async () => {
    const { port, consultations } = scriptedAdvisor([], { limits: { maxCallsPerTurn: 1 } })
    const { engine, requests } = engineFor([callTool("advisor", { question: "one" }), callTool("advisor", { question: "two" }), stop("ok")], port)
    await engine.runTurn(turn(ids("session")).input)
    expect(consultations).toHaveLength(1)
    const refused = requests[2]!.messages.at(-1) as { output: string; isError: boolean }
    expect(refused).toMatchObject({ isError: true })
    expect(refused.output).toContain("advisor unavailable: the advisor was consulted 1 times in this turn")
  })
})

describe("advisor checkpoints", () => {
  test("completion after an edit: revise buys exactly one more step, and the history stays assistant → tool", async () => {
    const { port, consultations } = scriptedAdvisor(['{"verdict":"revise","summary":"empty input still crashes","findings":[{"claim":"no guard","evidence":"a.ts:1","severity":"high"}]}'])
    const { engine, requests, history } = engineFor([callTool("write", { path: "a.ts", content: SUBSTANTIAL }), stop("done"), stop("fixed the guard")], port)
    const sessionId = ids("session")
    expect(await engine.runTurn(turn(sessionId).input)).toEqual({ status: "ok" })
    expect(consultations.map((entry) => entry.trigger)).toEqual(["completion"])
    expect(consultations[0]!.brief).toContain("+ fixed line")
    expect(requests).toHaveLength(3)
    const messages = (await history.load(sessionId)) ?? []
    const done = messages.findIndex((message) => message.role === "assistant" && message.content === "done")
    expect((messages[done] as Extract<ModelMessage, { role: "assistant" }>).toolCalls.map((call) => call.name)).toEqual(["advisor"])
    expect(messages[done + 1]).toMatchObject({ role: "tool", name: "advisor" })
    expect(messages[done + 2]).toMatchObject({ role: "user" })
    expect((messages[done + 2] as { content: string }).content.startsWith(ADVISOR_NUDGE_PREFIX)).toBe(true)
    expect(advisorResults(messages)).toHaveLength(1)
  })

  test("completion proceed ends the turn as before; a turn without edits is never reviewed", async () => {
    const proceed = scriptedAdvisor([])
    const edited = engineFor([callTool("write", { path: "a.ts", content: SUBSTANTIAL }), stop("done")], proceed.port)
    expect(await edited.engine.runTurn(turn(ids("session")).input)).toEqual({ status: "ok" })
    expect(proceed.consultations.map((entry) => entry.trigger)).toEqual(["completion"])
    expect(edited.requests).toHaveLength(2)

    const chat = scriptedAdvisor([])
    const readOnly = engineFor([callTool("read", { path: "a.ts" }), stop("it parses JSON")], chat.port)
    await readOnly.engine.runTurn(turn(ids("session")).input)
    expect(chat.consultations).toHaveLength(0)
  })

  test("a trivial turn (one file, a few lines) ends without the sign-off", async () => {
    const small = scriptedAdvisor([])
    const tweak = engineFor([callTool("write", { path: "config.toml", content: "theme = \"dark\"" }), stop("set the theme")], small.port)
    expect(await tweak.engine.runTurn(turn(ids("session")).input)).toEqual({ status: "ok" })
    expect(small.consultations).toHaveLength(0)
    expect(tweak.requests).toHaveLength(2)
  })

  test("the images of the user's request go to an advisor that takes images, and are named in the brief", async () => {
    const shot = { sha256: "b".repeat(64), mime: "image/png", bytes: 4, name: "layout.png" }
    const seen: Array<{ images: number; brief: string }> = []
    const port: AdvisorPort = {
      enabled: () => true,
      limits: () => advisorLimits(undefined),
      acceptsImages: () => true,
      consult: async (request) => (seen.push({ images: request.images?.length ?? 0, brief: request.brief }), { verdict: parseAdvisorVerdict('{"verdict":"proceed","summary":"matches the screenshot"}') }),
    }
    const { provider } = scriptedProvider([callTool("write", { path: "a.ts", content: SUBSTANTIAL }), stop("done")])
    const engine = createNativeEngine({ provider, tools: tools(), history: memoryHistory(), cwdFor: () => project, system: () => "sys", compactionPrompt: "summarize", advisor: port, readBlob: async () => new Uint8Array([1, 2, 3, 4]) })
    const { input } = turn(ids("session"))
    await engine.runTurn({ ...input, text: "make it look like this", attachments: [shot] })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.images).toBe(1)
    expect(seen[0]!.brief).toContain("layout.png (from the user's request)")
  })

  test("repeat_error fires on the second identical failure, not the first", async () => {
    const { port, consultations } = scriptedAdvisor(['{"verdict":"revise","summary":"the binary is missing; install it instead of retrying"}'])
    const { engine, requests } = engineFor([callTool("shell", { command: "bun test" }), callTool("shell", { command: "bun test" }), stop("giving up")], port)
    await engine.runTurn(turn(ids("session")).input)
    expect(consultations.map((entry) => entry.trigger)).toEqual(["repeat_error"])
    const seen = requests[2]!.messages
    expect(seen.at(-1)).toMatchObject({ role: "tool", name: "advisor" })
    expect(seen.at(-2)).toMatchObject({ role: "assistant", content: "" })
  })

  test("a disabled checkpoint and the session cap skip silently", async () => {
    const off = scriptedAdvisor([], { limits: { checkpoints: ["plan"] } })
    const first = engineFor([callTool("write", { path: "a.ts", content: SUBSTANTIAL }), stop("done")], off.port)
    await first.engine.runTurn(turn(ids("session")).input)
    expect(off.consultations).toHaveLength(0)

    const capped = scriptedAdvisor([], { limits: { maxCallsPerSession: 1 } })
    const sessionId = ids("session")
    const second = engineFor([callTool("write", { path: "a.ts", content: SUBSTANTIAL }), stop("done"), callTool("write", { path: "b.ts", content: SUBSTANTIAL }), stop("done again")], capped.port)
    await second.engine.runTurn(turn(sessionId).input)
    await second.engine.runTurn(turn(sessionId).input)
    expect(capped.consultations).toHaveLength(1)
  })

  test("plan: a revise verdict returns the plan to the agent before the user sees it, once per turn", async () => {
    const { port, consultations } = scriptedAdvisor(['{"verdict":"revise","summary":"step 2 skips the migration"}'])
    const plan = "1. read the parser\n2. change it"
    const { engine, requests } = engineFor([callTool("plan_submit", { plan }), callTool("plan_submit", { plan: `${plan}\n3. migrate stored data` }), stop("waiting")], port)
    const { input, asked } = turn(ids("session"), "plan", [{ kind: "deny", reason: "not yet" }])
    await engine.runTurn(input)
    expect(consultations.map((entry) => entry.trigger)).toEqual(["plan"])
    expect(consultations[0]!.brief).toContain("2. change it")
    const returned = requests[1]!.messages.at(-1) as { output: string; isError: boolean }
    expect(returned.isError).toBe(true)
    expect(returned.output).toContain("asked for changes (revise)")
    expect(asked.filter((request) => request.kind === "approval")).toHaveLength(1)
  })
})

describe("sub-agent tools", () => {
  const workflowStart = defineTool({ name: "workflow_start", description: "start a workflow", permission: "execute", args: z.object({}), execute: async () => ({ output: "started", truncated: false, title: "workflow", isError: false }) })
  const childTurn = (nested: boolean) => {
    const { provider, requests } = scriptedProvider([stop("ok")])
    const { port } = scriptedAdvisor([])
    const engine = createNativeEngine({
      provider, tools: [...tools(), workflowStart], history: memoryHistory(), cwdFor: () => project, system: () => "sys", compactionPrompt: "summarize", advisor: port, subagents: true,
      tasks: { isChild: () => true, nests: () => nested, run: async () => { throw new Error("unexpected task") }, status: async () => "" },
    })
    return { engine, requests }
  }

  test("a sub-agent is offered no advisor, workflow or task tool", async () => {
    const { engine, requests } = childTurn(false)
    await engine.runTurn(turn(ids("session")).input)
    const names = toolNames(requests[0]!)
    expect(names).toContain("write")
    for (const name of ["advisor", "workflow_start", "task"]) expect(names).not.toContain(name)
  })

  test("a deeper subagentDepth gives a sub-agent task, still without the advisor or workflows", async () => {
    const { engine, requests } = childTurn(true)
    await engine.runTurn(turn(ids("session")).input)
    const names = toolNames(requests[0]!)
    expect(names).toContain("task")
    for (const name of ["advisor", "workflow_start"]) expect(names).not.toContain(name)
  })
})
