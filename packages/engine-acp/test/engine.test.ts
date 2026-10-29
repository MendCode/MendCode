import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIdFactory, type PermissionMode, type SessionId } from "@mendcode/protocol"
import type { EngineEvent, EnginePort, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { ACP_MODEL_PREFIX, acpAgentKey, createAcpAgents, createAcpEngine, parseAcpAgents, withAcpEngine, type AcpAgentConfig, type AcpModelOption } from "../src"
import { spawnAcp } from "../src/transport"

const ids = createIdFactory()
const FAKE = join(import.meta.dir, "fake-agent.ts")
const temps: string[] = []
const engines: Array<{ stop(): void }> = []
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-acp-"))
  temps.push(dir)
  return dir
}

function setup({ env = {}, agentName = "fake", idleMs, releasedIdleMs, bindings, trace, hostServers, modelFor, onModels, effortFor, onEfforts }: { env?: Record<string, string>; agentName?: string; idleMs?: number; releasedIdleMs?: number; bindings?: Map<string, string>; trace?: (direction: "in" | "out", line: string) => void; hostServers?: Parameters<typeof createAcpEngine>[0]["hostServers"]; modelFor?: () => string | undefined; onModels?: Parameters<typeof createAcpEngine>[0]["onModels"]; effortFor?: () => string | undefined; onEfforts?: Parameters<typeof createAcpEngine>[0]["onEfforts"] } = {}) {
  const dir = temp()
  const log = join(dir, "log.jsonl")
  const config: AcpAgentConfig = { command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: log, ...env } }
  const store = bindings ?? new Map<string, string>()
  const engine = createAcpEngine({
    agents: { get: (name) => (name === agentName ? config : undefined) },
    agentFor: () => agentName,
    cwdFor: () => dir,
    ...(idleMs ? { idleMs } : {}),
    ...(releasedIdleMs ? { releasedIdleMs } : {}),
    bindings: { get: (sessionId, agent) => store.get(`${sessionId}/${agent}`), set: (sessionId, agent, id) => void store.set(`${sessionId}/${agent}`, id) },
    readBlob: async () => new Uint8Array([1, 2, 3]),
    ...(trace ? { trace } : {}),
    ...(hostServers ? { hostServers } : {}),
    ...(modelFor ? { modelFor } : {}),
    ...(onModels ? { onModels } : {}),
    ...(effortFor ? { effortFor } : {}),
    ...(onEfforts ? { onEfforts } : {}),
  })
  engines.push(engine)
  const received = () =>
    (existsSync(log) ? readFileSync(log, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { engine, dir, received, store }
}

function turnInput(patch: { sessionId?: SessionId; text?: string; mode?: () => PermissionMode; answer?: (request: EngineRequest) => EngineResolution | Promise<EngineResolution>; signal?: AbortSignal; attachments?: TurnInput["attachments"] } = {}) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const input: TurnInput = {
    sessionId: patch.sessionId ?? ids("session"),
    turnId: ids("turn"),
    text: patch.text ?? "hello",
    attachments: patch.attachments ?? [],
    signal: patch.signal ?? new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => {
      asked.push(request)
      return (await patch.answer?.(request)) ?? { kind: "abandoned" }
    },
    permissionMode: patch.mode ?? (() => "ask"),
    setPermissionMode: () => undefined,
  }
  return { input, events, asked }
}

const completedText = (events: EngineEvent[], kind: string) => events.filter((event) => event.type === "item.started" && event.kind === kind).map((started) => (events.find((event) => event.type === "item.completed" && event.itemId === (started as any).itemId) as any)?.text)

describe("a normal turn", () => {
  test("initializes, opens a session in the session's directory and maps thought and message chunks", async () => {
    const { engine, dir, received } = setup()
    const { input, events } = turnInput()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(completedText(events, "reasoning")).toEqual(["thinking"])
    expect(completedText(events, "agent_message")).toEqual(["Hello there"])
    expect(events.filter((event) => event.type === "item.delta").map((event: any) => event.text).join("")).toBe("thinkingHello there")
    const messages = received()
    expect(messages[0]).toMatchObject({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } })
    expect(messages[1]).toMatchObject({ method: "session/new", params: { cwd: dir, mcpServers: [] } })
    expect(messages[2]).toMatchObject({ method: "session/prompt", params: { sessionId: "sess-1", prompt: [{ type: "text", text: "hello" }] } })
  })

  test("MendCode's own tools go to an agent that takes HTTP MCP, and are left out for one that does not", async () => {
    const host = [{ type: "http" as const, name: "mendcode", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }]
    const http = setup({ env: { FAKE_ACP_HTTP: "1" }, hostServers: () => host })
    expect(await http.engine.runTurn(turnInput().input)).toEqual({ status: "ok" })
    expect(http.received().find((message) => message.method === "session/new").params.mcpServers).toEqual(host)
    const plain = setup({ hostServers: () => host })
    expect(await plain.engine.runTurn(turnInput().input)).toEqual({ status: "ok" })
    expect(plain.received().find((message) => message.method === "session/new").params.mcpServers).toEqual([])
  })

  test("the process and session stay up between turns of one session", async () => {
    const { engine, received } = setup()
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    const second = turnInput({ sessionId, text: "anything else" })
    expect(await engine.runTurn(second.input)).toEqual({ status: "ok" })
    expect(completedText(second.events, "agent_message")).toEqual(["echo:anything else"])
    expect(received().filter((message) => message.method === "initialize")).toHaveLength(1)
    expect(received().filter((message) => message.method === "session/new")).toHaveLength(1)
    expect(received().filter((message) => message.method === "session/prompt").map((message) => message.params.sessionId)).toEqual(["sess-1", "sess-1"])
  })

  test("a session no client shows any more stops its agent process soon; the next turn starts one and resumes the agent's session", async () => {
    const { engine, received } = setup({ releasedIdleMs: 50, env: { FAKE_ACP_LOAD: "1" } })
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    engine.release!(sessionId)
    await Bun.sleep(400)
    expect(await engine.runTurn(turnInput({ sessionId, text: "back" }).input)).toEqual({ status: "ok" })
    expect(received().filter((message) => message.method === "initialize")).toHaveLength(2)
    expect(received().filter((message) => message.method === "session/load")).toHaveLength(1)
  })

  test("tool calls, diffs, an update for an unknown call, and the plan", async () => {
    const { engine } = setup()
    const diff = turnInput({ text: "diff" })
    await engine.runTurn(diff.input)
    const started = diff.events.filter((event) => event.type === "item.started") as any[]
    // Named and written as MendCode's own edit, so the card draws the diff with its line numbers.
    expect(started.map((event) => event.meta?.tool)).toEqual(["edit: b.ts", "Orphan"])
    const completed = diff.events.filter((event) => event.type === "item.completed") as any[]
    expect(completed[0].text).toBe("@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 2")
    expect(completed[1].text).toContain('"ok": true')

    const plan = turnInput({ text: "plan" })
    await engine.runTurn(plan.input)
    const planStarted = plan.events.find((event) => event.type === "item.started" && event.meta?.tool === "plan") as any
    expect(planStarted).toBeDefined()
    const planDone = plan.events.find((event) => event.type === "item.completed" && event.itemId === planStarted.itemId) as any
    expect(planDone.text).toBe("[x] write code\n[~] test it")
  })

  test("a permission-gated tool call completes with the agent's own output", async () => {
    const { engine } = setup()
    const { input, events } = turnInput({ text: "tool", answer: () => ({ kind: "approve", scope: "once" }) })
    await engine.runTurn(input)
    const toolStarted = events.find((event) => event.type === "item.started" && event.kind === "tool_call") as any
    const toolDone = events.find((event) => event.type === "item.completed" && event.itemId === toolStarted.itemId) as any
    expect(toolDone).toMatchObject({ status: "ok", text: "file-list" })
  })

  test("images go as image blocks when the agent takes them, otherwise as a text marker", async () => {
    const attachment = { sha256: "a".repeat(64), mime: "image/png", size: 3, name: "shot.png" } as any
    const withImages = setup({ env: { FAKE_ACP_IMAGE: "1" } })
    const first = turnInput({ text: "image please", attachments: [attachment] })
    await withImages.engine.runTurn(first.input)
    expect(completedText(first.events, "agent_message")).toEqual(["blocks:image,text"])
    expect(withImages.received().find((message) => message.method === "session/prompt").params.prompt[0]).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") })

    const without = setup()
    const second = turnInput({ text: "image please", attachments: [attachment] })
    await without.engine.runTurn(second.input)
    expect(completedText(second.events, "agent_message")).toEqual(["blocks:text,text"])
  })

  test("an image with a token in the text goes right after the token: text, image, text", async () => {
    const attachment = { sha256: "a".repeat(64), mime: "image/png", size: 3, name: "shot.png", label: "[Image #1]", at: "mira [Image #1]".length } as any
    const withImages = setup({ env: { FAKE_ACP_IMAGE: "1" } })
    const { input } = turnInput({ text: "mira [Image #1] y luego", attachments: [attachment] })
    await withImages.engine.runTurn(input)
    expect(withImages.received().find((message) => message.method === "session/prompt").params.prompt).toEqual([
      { type: "text", text: "mira [Image #1]" },
      { type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") },
      { type: "text", text: " y luego" },
    ])
    const without = setup()
    const second = turnInput({ text: "mira [Image #1] y luego", attachments: [attachment] })
    await without.engine.runTurn(second.input)
    expect(without.received().find((message) => message.method === "session/prompt").params.prompt).toEqual([
      { type: "text", text: "mira [Image #1]" },
      { type: "text", text: "[attachment shot.png · image/png · not sent]" },
      { type: "text", text: " y luego" },
    ])
  })

  test("an agent that asks for the file system gets method-not-found (none was offered)", async () => {
    const { engine } = setup()
    const { input, events } = turnInput({ text: "fs" })
    await engine.runTurn(input)
    expect(completedText(events, "agent_message")).toEqual(["fs:-32601"])
  })
})

describe("the agent's own models", () => {
  test("the offered models are reported, grouped ones included; a chosen one is switched to once, then kept", async () => {
    const offered: AcpModelOption[][] = []
    let wanted: string | undefined = "vendor/big"
    const { engine, received } = setup({ env: { FAKE_ACP_MODELS: "1" }, modelFor: () => wanted, onModels: (agent, models) => void offered.push(agent === "fake" ? models : []) })
    const sessionId = ids("session")
    const first = turnInput({ sessionId, text: "which model" })
    expect(await engine.runTurn(first.input)).toEqual({ status: "ok" })
    expect(completedText(first.events, "agent_message")).toEqual(["vendor/big"])
    expect(offered[0]).toEqual([{ value: "vendor/small", name: "Small (free)" }, { value: "vendor/big", name: "Big" }])
    const second = turnInput({ sessionId, text: "which model" })
    await engine.runTurn(second.input)
    expect(received().filter((message) => message.method === "session/set_config_option").map((message) => message.params)).toEqual([{ sessionId: "sess-1", configId: "model", value: "vendor/big" }])
    // acp:<name> leaves the model in force.
    wanted = undefined
    const third = turnInput({ sessionId, text: "which model" })
    await engine.runTurn(third.input)
    expect(completedText(third.events, "agent_message")).toEqual(["vendor/big"])
  })

  test("a model the agent refuses, or an agent with no model option, fails the turn with what to pick instead", async () => {
    const refusing = setup({ env: { FAKE_ACP_MODELS: "1" }, modelFor: () => "vendor/missing" })
    const refused = await refusing.engine.runTurn(turnInput({ text: "hello" }).input)
    expect(refused).toMatchObject({ status: "error", code: "acp_model", message: expect.stringContaining(`did not switch to model "vendor/missing": no such model`) })
    const plain = setup({ modelFor: () => "vendor/big" })
    expect(await plain.engine.runTurn(turnInput({ text: "hello" }).input)).toMatchObject({ status: "error", code: "acp_model", message: expect.stringContaining("offers no model choice; pick acp:fake") })
    expect(plain.received().some((message) => message.method === "session/prompt")).toBe(false)
  })

  test("the effort select follows the model: its levels are reported per model, the asked level is set after the model, none asked sets default", async () => {
    const learned: Array<[string, string, string[]]> = []
    let model: string | undefined = "vendor/big"
    let effort: string | undefined = "max"
    const { engine, received } = setup({ env: { FAKE_ACP_MODELS: "1", FAKE_ACP_EFFORT: "1" }, modelFor: () => model, effortFor: () => effort, onEfforts: (agent, value, efforts) => void learned.push([agent, value, efforts]) })
    const sessionId = ids("session")
    const ask = async () => {
      const turn = turnInput({ sessionId, text: "which effort" })
      expect(await engine.runTurn(turn.input)).toEqual({ status: "ok" })
      return completedText(turn.events, "agent_message")[0]
    }
    expect(await ask()).toBe("vendor/big@max")
    const sets = () => received().filter((message) => message.method === "session/set_config_option").map((message) => [message.params.configId, message.params.value])
    // The model first (its levels only show once it is in force), then the level.
    expect(sets()).toEqual([["model", "vendor/big"], ["effort", "max"]])
    // The small model has no select: [] is learned for it; vendor/big's levels without `default`.
    expect(learned).toContainEqual(["fake", "vendor/small", []])
    expect(learned).toContainEqual(["fake", "vendor/big", ["low", "high", "max"]])
    // Same level again: no request.
    expect(await ask()).toBe("vendor/big@max")
    expect(sets()).toHaveLength(2)
    // No effort asked: the agent's own default level.
    effort = undefined
    expect(await ask()).toBe("vendor/big@default")
    // A level the model does not list is not sent; default stands.
    effort = "xhigh"
    expect(await ask()).toBe("vendor/big@default")
    expect(sets()).toEqual([["model", "vendor/big"], ["effort", "max"], ["effort", "default"]])
    // A model without levels: no effort request at all.
    model = "vendor/small"
    effort = "high"
    expect(await ask()).toBe("vendor/small@low")
    expect(sets().at(-1)).toEqual(["model", "vendor/small"])
  })
})

describe("/env credentials", () => {
  test("reach the agent process; new ones start a new process", async () => {
    let environment: { values: Record<string, string>; note: string } | undefined = { values: { INSTABOX_KEY: "ib-secret" }, note: "MendCode credentials (set by the user in /env) are in your shell's environment: INSTABOX_KEY." }
    const dir = temp()
    const log = join(dir, "log.jsonl")
    const config: AcpAgentConfig = { command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: log } }
    const envs: Array<Record<string, string>> = []
    const engine = createAcpEngine({
      agents: { get: () => config }, agentFor: () => "fake", cwdFor: () => dir, environment: () => environment,
      transportFactory: ({ env, cwd }) => (envs.push(env), spawnAcp({ command: config.command, args: config.args ?? [], env: { ...config.env, ...env }, cwd })),
    })
    engines.push(engine)
    const sessionId = ids("session")
    expect(await engine.runTurn(turnInput({ sessionId }).input)).toEqual({ status: "ok" })
    expect(envs[0]).toEqual({ INSTABOX_KEY: "ib-secret" })
    environment = { values: { INSTABOX_KEY: "ib-rotated" }, note: environment.note }
    expect(await engine.runTurn(turnInput({ sessionId }).input)).toEqual({ status: "ok" })
    expect(envs).toEqual([{ INSTABOX_KEY: "ib-secret" }, { INSTABOX_KEY: "ib-rotated" }])
  })
})

describe("permissions", () => {
  test("ask mode: the approval names the tool, its kind and detail, and approve-once selects allow_once", async () => {
    const { engine } = setup()
    const { input, asked, events } = turnInput({ text: "tool", answer: () => ({ kind: "approve", scope: "once" }) })
    await engine.runTurn(input)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: "approval", title: "Run ls -la", tool: "Run ls -la", permission: "execute" })
    expect(asked[0]?.detail).toContain("about to run")
    expect(asked[0]?.detail).toContain('"command": "ls -la"')
    const toolStarted = events.find((event) => event.type === "item.started" && event.kind === "tool_call") as any
    expect(asked[0]?.itemId).toBe(toolStarted.itemId)
    expect(completedText(events, "agent_message")).toEqual(["picked:allow-1"])
  })

  test("approve for the session selects allow_always; deny selects reject_once; abandoned cancels the request", async () => {
    const session = turnInput({ text: "tool", answer: () => ({ kind: "approve", scope: "session" }) })
    await setup().engine.runTurn(session.input)
    expect(completedText(session.events, "agent_message")).toEqual(["picked:allow-all"])

    const denied = turnInput({ text: "tool", answer: () => ({ kind: "deny", reason: "no" }) })
    await setup().engine.runTurn(denied.input)
    expect(completedText(denied.events, "agent_message")).toEqual(["picked:reject-1"])
    const failed = denied.events.find((event) => event.type === "item.completed" && (event as any).status === "error") as any
    expect(failed.text).toBe("not permitted")

    const abandoned = turnInput({ text: "tool", answer: () => ({ kind: "abandoned" }) })
    await setup().engine.runTurn(abandoned.input)
    expect(completedText(abandoned.events, "agent_message")).toEqual(["picked:cancelled"])
  })

  test("full mode approves without asking; edits mode approves edits only; plan mode refuses anything but reading", async () => {
    const full = turnInput({ text: "tool", mode: () => "full" })
    await setup().engine.runTurn(full.input)
    expect(full.asked).toHaveLength(0)
    expect(completedText(full.events, "agent_message")).toEqual(["picked:allow-1"])

    const editsEdit = turnInput({ text: "tool edit", mode: () => "edits" })
    await setup().engine.runTurn(editsEdit.input)
    expect(editsEdit.asked).toHaveLength(0)
    expect(completedText(editsEdit.events, "agent_message")).toEqual(["picked:allow-1"])

    const editsShell = turnInput({ text: "tool", mode: () => "edits", answer: () => ({ kind: "deny" }) })
    await setup().engine.runTurn(editsShell.input)
    expect(editsShell.asked).toHaveLength(1)

    const planWrite = turnInput({ text: "tool edit", mode: () => "plan" })
    await setup().engine.runTurn(planWrite.input)
    expect(planWrite.asked).toHaveLength(0)
    expect(completedText(planWrite.events, "agent_message")).toEqual(["picked:reject-1"])

    // Reading is allowed in plan mode, but still goes through the normal approval.
    const planRead = turnInput({ text: "tool read", mode: () => "plan", answer: () => ({ kind: "approve", scope: "once" }) })
    await setup().engine.runTurn(planRead.input)
    expect(planRead.asked).toHaveLength(1)
    expect(planRead.asked[0]?.permission).toBe("read")
    expect(completedText(planRead.events, "agent_message")).toEqual(["picked:allow-1"])
  })
})

describe("cancel, failures and recovery", () => {
  test("aborting sends session/cancel and the agent's cancelled answer ends the turn ok", async () => {
    const { engine, received } = setup()
    const controller = new AbortController()
    const { input, events } = turnInput({ text: "slow", signal: controller.signal })
    const running = engine.runTurn(input)
    while (!events.some((event) => event.type === "item.delta")) await Bun.sleep(10)
    controller.abort()
    expect(await running).toEqual({ status: "ok" })
    expect(received().some((message) => message.method === "session/cancel" && message.params.sessionId === "sess-1")).toBe(true)
    expect(completedText(events, "agent_message")).toEqual(["working"])
  })

  test("an agent that ignores the cancel is closed when the grace ends; the next turn starts a fresh process", async () => {
    const { engine, received } = setup()
    const sessionId = ids("session")
    const controller = new AbortController()
    const running = engine.runTurn(turnInput({ sessionId, text: "silent", signal: controller.signal }).input)
    while (!received().some((message) => message.method === "session/prompt")) await Bun.sleep(10)
    controller.abort()
    expect(await running).toEqual({ status: "ok" })
    const starts = () => received().filter((message) => message.method === "initialize").length
    expect(starts()).toBe(1)
    expect(await engine.runTurn(turnInput({ sessionId, text: "hello" }).input)).toEqual({ status: "ok" })
    expect(starts()).toBe(2)
    engine.stop()
  }, 15_000)

  test("an already aborted turn does not start the agent", async () => {
    const { engine, dir } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await engine.runTurn(turnInput({ signal: controller.signal }).input)).toEqual({ status: "ok" })
    expect(() => readFileSync(join(dir, "log.jsonl"))).toThrow()
  })

  test("an agent that never answers is cancelled by the idle watchdog", async () => {
    const { engine, received } = setup({ idleMs: 150 })
    const outcome = await engine.runTurn(turnInput({ text: "silent" }).input)
    expect(outcome).toMatchObject({ status: "error", code: "stream_idle" })
    // The notification is written just before the turn ends; the child process logs it a moment later.
    const deadline = Date.now() + 3_000
    while (!received().some((message) => message.method === "session/cancel") && Date.now() < deadline) await Bun.sleep(20)
    expect(received().some((message) => message.method === "session/cancel")).toBe(true)
  })

  test("a crash mid-turn reports the exit with the stderr tail, and the next turn starts a fresh process", async () => {
    const { engine } = setup()
    const sessionId = ids("session")
    const crashed = await engine.runTurn(turnInput({ sessionId, text: "crash" }).input)
    expect(crashed).toMatchObject({ status: "error", code: "acp_exited" })
    expect((crashed as any).message).toContain("boom: the agent crashed")
    const again = turnInput({ sessionId })
    expect(await engine.runTurn(again.input)).toEqual({ status: "ok" })
    expect(completedText(again.events, "agent_message")).toEqual(["Hello there"])
  })

  test("refusal, token limit and a JSON-RPC error are errors with their own codes", async () => {
    const { engine } = setup()
    expect(await engine.runTurn(turnInput({ text: "refuse" }).input)).toMatchObject({ status: "error", code: "acp_refusal" })
    expect(await engine.runTurn(turnInput({ text: "limit" }).input)).toMatchObject({ status: "error", code: "acp_limit" })
    const failed = await engine.runTurn(turnInput({ text: "error" }).input)
    expect(failed).toMatchObject({ status: "error", code: "acp_turn_failed" })
    expect((failed as any).message).toContain("the model exploded")
  })

  test("a missing command is reported with the file to fix", async () => {
    const engine = createAcpEngine({ agents: { get: () => ({ command: "/nonexistent/acp-agent-binary" }) }, agentFor: () => "ghost", cwdFor: () => tmpdir() })
    engines.push(engine)
    const outcome = await engine.runTurn(turnInput().input)
    expect(outcome).toMatchObject({ status: "error", code: "acp_missing" })
    expect((outcome as any).message).toContain("acp-agents.json")
  })

  test("an agent that needs sign-in says so", async () => {
    const { engine } = setup({ env: { FAKE_ACP_AUTH: "1" } })
    const outcome = await engine.runTurn(turnInput().input)
    expect(outcome).toMatchObject({ status: "error", code: "acp_auth" })
    expect((outcome as any).message).toContain("sign in")
  })

  test("a model that is not a configured agent is refused, not guessed", async () => {
    const engine = createAcpEngine({ agents: { get: () => undefined }, agentFor: () => undefined, cwdFor: () => tmpdir() })
    expect(await engine.runTurn(turnInput().input)).toMatchObject({ status: "error", code: "acp_no_agent" })
    const other = createAcpEngine({ agents: { get: () => undefined }, agentFor: () => "gone", cwdFor: () => tmpdir() })
    expect(await other.runTurn(turnInput().input)).toMatchObject({ status: "error", code: "acp_no_agent" })
  })
})

describe("session resume", () => {
  test("bridge processes inject HTTP servers into new/load, scrub split output, disable tracing and never reuse the bearer", async () => {
    const traces: string[] = []
    const h = setup({ env: { FAKE_ACP_LOAD: "1", FAKE_ACP_HTTP: "1" }, trace: (_direction, line) => { traces.push(line) } })
    const sessionId = ids("session")
    const secret = "fake-process-token-long-enough"
    const servers = [{ type: "http" as const, name: "mendcode_threads", url: "http://127.0.0.1:12345/mcp", headers: [{ name: "Authorization", value: `Bearer ${secret}` }] }]
    const mcp = { args: [], servers, cwd: h.dir, scrub: (text: string) => text.replaceAll(secret, "[redacted]"), stream: () => {
      let held = ""
      return { push(text: string) { held += text; return "" }, flush() { const text = held.replaceAll(secret, "[redacted]"); held = ""; return text } }
    } }
    for (let count = 0; count < 2; count++) {
      const turn = turnInput({ sessionId, text: "mcp echo" })
      expect(await h.engine.runTurn({ ...turn.input, externalMcp: mcp })).toEqual({ status: "ok" })
      expect(JSON.stringify(turn.events)).not.toContain(secret)
      expect(completedText(turn.events, "agent_message")).toEqual(["Bearer [redacted]"])
    }
    expect(traces).toEqual([])
    const messages = h.received()
    expect(messages.filter((message) => message.method === "initialize")).toHaveLength(2)
    expect(messages.find((message) => message.method === "session/new").params).toMatchObject({ cwd: h.dir, mcpServers: servers })
    expect(messages.find((message) => message.method === "session/load").params).toMatchObject({ cwd: h.dir, mcpServers: servers })
    await h.engine.runTurn(turnInput({ sessionId }).input)
    expect(h.received().filter((message) => message.method === "initialize")).toHaveLength(3)
    expect(h.received().filter((message) => message.method === "session/load").at(-1).params.mcpServers).toEqual([])
  })

  test("bridge opt-in refuses an agent without HTTP MCP capability before session creation", async () => {
    const h = setup()
    const turn = turnInput()
    const outcome = await h.engine.runTurn({ ...turn.input, externalMcp: { args: [], cwd: h.dir, scrub: (text) => text, servers: [{ type: "http", name: "mendcode_threads", url: "http://127.0.0.1:12345/mcp", headers: [] }] } })
    expect(outcome).toMatchObject({ status: "error", code: "acp_start" })
    expect((outcome as any).message).toContain("HTTP MCP support")
    expect(h.received().map((message) => message.method)).toEqual(["initialize"])
  })

  test("cancelled bridge turns close their ACP process and the next turn creates a fresh process", async () => {
    const h = setup({ env: { FAKE_ACP_HTTP: "1", FAKE_ACP_LOAD: "1" } })
    const controller = new AbortController()
    const sessionId = ids("session")
    const turn = turnInput({ sessionId, text: "slow", signal: controller.signal })
    const pending = h.engine.runTurn({ ...turn.input, externalMcp: { args: [], cwd: h.dir, scrub: (text) => text, servers: [{ type: "http", name: "mendcode_threads", url: "http://127.0.0.1:12345/mcp", headers: [] }] } })
    const deadline = Date.now() + 2_000
    while (!turn.events.some((event) => event.type === "item.delta")) {
      if (Date.now() > deadline) throw new Error("fake ACP did not start")
      await Bun.sleep(5)
    }
    controller.abort()
    expect(await pending).toEqual({ status: "ok" })
    expect(h.received().some((message) => message.method === "session/cancel")).toBe(true)
    await h.engine.runTurn(turnInput({ sessionId }).input)
    expect(h.received().filter((message) => message.method === "initialize")).toHaveLength(2)
    expect(h.received().find((message) => message.method === "session/load").params.mcpServers).toEqual([])
  })

  test("cancellation during bridge initialization closes the process without creating or prompting a session", async () => {
    const h = setup({ env: { FAKE_ACP_SLOW_INIT: "1" } })
    const controller = new AbortController()
    const pending = h.engine.runTurn({ ...turnInput({ signal: controller.signal }).input, externalMcp: { args: [], cwd: h.dir, scrub: (text) => text, servers: [{ type: "http", name: "mendcode_threads", url: "http://127.0.0.1:12345/mcp", headers: [] }] } })
    const deadline = Date.now() + 2_000
    while (!h.received().some((message) => message.method === "initialize")) {
      if (Date.now() > deadline) throw new Error("fake ACP did not initialize")
      await Bun.sleep(5)
    }
    controller.abort()
    expect(await pending).toEqual({ status: "ok" })
    expect(h.received().map((message) => message.method)).toEqual(["initialize"])
  })

  test("a new process resumes with session/load when the agent supports it; the replay is not shown", async () => {
    const bindings = new Map<string, string>()
    const sessionId = ids("session")
    const first = setup({ env: { FAKE_ACP_LOAD: "1" }, bindings })
    await first.engine.runTurn(turnInput({ sessionId }).input)
    expect(bindings.get(`${sessionId}/fake`)).toBe("sess-1")
    first.engine.stop()

    const second = setup({ env: { FAKE_ACP_LOAD: "1" }, bindings })
    const resumed = turnInput({ sessionId, text: "next" })
    expect(await second.engine.runTurn(resumed.input)).toEqual({ status: "ok" })
    const messages = second.received()
    expect(messages.some((message) => message.method === "session/new")).toBe(false)
    expect(messages.find((message) => message.method === "session/load")).toMatchObject({ params: { sessionId: "sess-1" } })
    expect(completedText(resumed.events, "agent_message")).toEqual(["echo:next"])
  })

  test("without loadSession a new session is created and remembered", async () => {
    const bindings = new Map<string, string>()
    const sessionId = ids("session")
    const first = setup({ bindings })
    await first.engine.runTurn(turnInput({ sessionId }).input)
    first.engine.stop()
    const second = setup({ bindings })
    await second.engine.runTurn(turnInput({ sessionId }).input)
    expect(second.received().some((message) => message.method === "session/load")).toBe(false)
    expect(second.received().some((message) => message.method === "session/new")).toBe(true)
  })
})

describe("agents file and routing", () => {
  test("parses acp-agents.json, skipping bad entries with a reason", () => {
    const loaded = parseAcpAgents(JSON.stringify({ gemini: { command: "gemini", args: ["--experimental-acp"], env: { K: "v" } }, "bad name": { command: "x" }, nocmd: {}, worse: "x" }))
    expect(Object.keys(loaded.agents)).toEqual(["gemini"])
    expect(loaded.agents.gemini).toEqual({ command: "gemini", args: ["--experimental-acp"], env: { K: "v" } })
    expect(loaded.issues).toHaveLength(3)
    expect(parseAcpAgents("{oops").issues[0]).toContain("invalid JSON")
    expect(parseAcpAgents("[]").issues[0]).toContain("expected")
  })

  test("models an agent offered are listed as acp:<name>/<model> after its default, and name the agent and its model", () => {
    const dir = temp()
    const agents = createAcpAgents({ dir })
    writeFileSync(join(dir, "acp-agents.json"), JSON.stringify({ opencode: { command: "opencode", args: ["acp"] } }))
    agents.learn("opencode", [{ value: "opencode/big-pickle", name: "OpenCode/Big Pickle" }, { value: `x/${"y".repeat(100)}`, name: "too long for a model id" }])
    agents.learn("removed", [{ value: "a/b", name: "B" }])
    expect(agents.models()).toEqual([
      { id: "acp:opencode", name: "opencode harness", efforts: [] },
      { id: "acp:opencode/opencode/big-pickle", name: "OpenCode/Big Pickle · opencode harness", efforts: [] },
    ])
    expect(agents.agentOf("acp:opencode/opencode/big-pickle")).toBe("opencode")
    expect(agents.modelOf("acp:opencode/opencode/big-pickle")).toBe("opencode/big-pickle")
    expect(agents.modelOf("acp:opencode")).toBeUndefined()
    expect(agents.agentOf("acp:removed/a/b")).toBeUndefined()
    expect(acpAgentKey("acp:opencode/opencode/big-pickle")).toBe("acp:opencode")
    expect(acpAgentKey("acp:opencode")).toBe("acp:opencode")
    // A fresh reader of the same directory sees the list: it survives a restart.
    expect(createAcpAgents({ dir }).models().map((model) => model.id)).toEqual(["acp:opencode", "acp:opencode/opencode/big-pickle"])
  })

  test("levels an agent's effort select listed for a model become that model's efforts, kept across a new listing and a restart", () => {
    const dir = temp()
    const agents = createAcpAgents({ dir })
    writeFileSync(join(dir, "acp-agents.json"), JSON.stringify({ opencode: { command: "opencode", args: ["acp"] } }))
    agents.learn("opencode", [{ value: "opencode/deepseek-v4.1-flash-free", name: "DeepSeek" }, { value: "opencode/big-pickle", name: "Big Pickle" }])
    agents.learnEfforts("opencode", "opencode/deepseek-v4.1-flash-free", ["low", "high", "max", "turbo"])
    agents.learnEfforts("opencode", "opencode/big-pickle", [])
    agents.learnEfforts("opencode", "opencode/not-listed", ["low"])
    const efforts = () => Object.fromEntries(createAcpAgents({ dir }).models().map((model) => [model.id, model.efforts]))
    expect(efforts()).toEqual({ "acp:opencode": [], "acp:opencode/opencode/deepseek-v4.1-flash-free": ["low", "high", "max"], "acp:opencode/opencode/big-pickle": [] })
    // The model select lists the models again (without levels): the levels stay.
    agents.learn("opencode", [{ value: "opencode/deepseek-v4.1-flash-free", name: "DeepSeek" }])
    expect(efforts()).toEqual({ "acp:opencode": [], "acp:opencode/opencode/deepseek-v4.1-flash-free": ["low", "high", "max"] })
  })

  test("models appear as acp:<name>, follow edits to the file, and only configured agents are owned", () => {
    const dir = temp()
    const agents = createAcpAgents({ dir })
    expect(agents.models()).toEqual([])
    writeFileSync(join(dir, "acp-agents.json"), JSON.stringify({ gemini: { command: "gemini" } }))
    expect(agents.models()).toEqual([{ id: `${ACP_MODEL_PREFIX}gemini`, name: "gemini harness", efforts: [] }])
    expect(agents.agentOf("acp:gemini")).toBe("gemini")
    expect(agents.agentOf("acp:other")).toBeUndefined()
    expect(agents.agentOf("gpt-5")).toBeUndefined()
    writeFileSync(join(dir, "acp-agents.json"), JSON.stringify({ gemini: { command: "gemini" }, codex: { command: "codex-acp", args: ["--x"] } }))
    expect(agents.models().map((model) => model.id)).toEqual(["acp:gemini", "acp:codex"])
  })

  test("the router sends ACP sessions to the ACP engine and the rest to the base engine", async () => {
    const calls: string[] = []
    const port = (name: string): EnginePort => ({
      runTurn: async () => (calls.push(`${name}:turn`), { status: "ok" }),
      runShell: async () => (calls.push(`${name}:shell`), { status: "ok" }),
      needsCompaction: () => name === "base",
      compact: async () => (calls.push(`${name}:compact`), { status: "ok" }),
    })
    const acpSession = ids("session")
    const otherSession = ids("session")
    let created = 0
    const router = withAcpEngine({ base: port("base"), acp: async () => (created++, port("acp")), usesAcp: (sessionId) => sessionId === acpSession })
    await router.runTurn(turnInput({ sessionId: otherSession }).input)
    expect(created).toBe(0)
    await router.runTurn(turnInput({ sessionId: acpSession }).input)
    await router.runTurn(turnInput({ sessionId: acpSession }).input)
    expect(created).toBe(1)
    await router.runShell!(turnInput({ sessionId: acpSession }).input)
    expect(router.needsCompaction(acpSession)).toBe(false)
    expect(router.needsCompaction(otherSession)).toBe(true)
    await router.compact({ sessionId: acpSession, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => undefined })
    // Compaction of an ACP session is a no-op: the agent compacts its own context.
    expect(calls).toEqual(["base:turn", "acp:turn", "acp:turn", "base:shell"])
  })

  test("a per-turn model selection routes that turn alone, to or away from the ACP engine", async () => {
    const calls: string[] = []
    const port = (name: string): EnginePort => ({ runTurn: async () => (calls.push(name), { status: "ok" }), needsCompaction: () => false, compact: async () => ({ status: "ok" }) })
    const router = withAcpEngine({ base: port("base"), acp: async () => port("acp"), usesAcp: (_sessionId, override) => override?.model.startsWith("acp:") ?? false })
    const session = ids("session")
    await router.runTurn(turnInput({ sessionId: session }).input)
    await router.runTurn({ ...turnInput({ sessionId: session }).input, selection: { model: { model: "acp:fake" } } })
    await router.runTurn(turnInput({ sessionId: session }).input)
    expect(calls).toEqual(["base", "acp", "base"])
  })

  test("agentFor sees the per-turn selection, so an override starts the other agent", async () => {
    const seen: unknown[] = []
    const dir = temp()
    const config: AcpAgentConfig = { command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: join(dir, "log.jsonl") } }
    const engine = createAcpEngine({ agents: { get: (name) => (name === "fake" ? config : undefined) }, agentFor: (_sessionId, override) => (seen.push(override), "fake"), cwdFor: () => dir })
    engines.push(engine)
    const turn = turnInput()
    await engine.runTurn({ ...turn.input, selection: { model: { model: "acp:fake" } } })
    expect(seen).toEqual([{ model: "acp:fake" }])
  })

  test("a failing ACP engine factory is an error outcome that is retried on the next turn", async () => {
    let attempts = 0
    const base: EnginePort = { runTurn: async () => ({ status: "ok" }), needsCompaction: () => false, compact: async () => ({ status: "ok" }) }
    const router = withAcpEngine({
      base,
      acp: async () => {
        attempts++
        if (attempts === 1) throw new Error("not ready")
        return base
      },
      usesAcp: () => true,
    })
    expect(await router.runTurn(turnInput().input)).toMatchObject({ status: "error", code: "acp_unavailable" })
    expect(await router.runTurn(turnInput().input)).toEqual({ status: "ok" })
  })
})
