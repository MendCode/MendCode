import { describe, expect, test } from "bun:test"
import { createIdFactory, partialToolArgs, type PermissionMode, type SessionId } from "@mendcode/protocol"
import { createVirtualClock, type EngineEvent, type EngineRequest, type EngineResolution, type GlobalEventDraft, type TurnInput } from "@mendcode/kernel"
import { CANCEL_GRACE_MS, changesMcpServers, messageUuid, claudeArgs, claudeEditPatch, claudeCacheEnv, claudeProcessEnv, claudeQuota, claudeToolTitle, createClaudeEngine, createTurnMapper, resultOutcome, signInHint, spawnClaude, type ClaudeTransport } from "../src"

const ids = createIdFactory()

test("thread bridge flags are process-only, scrub traces/events, close each process and resume bindings", async () => {
  const secret = "test-process-bearer"
  const fakes = [0, 1].map(() => fakeClaude({ onUser(api) { api.push({ type: "system", subtype: "init", session_id: "cc-session-1" }); streamText(api, 0, secret); api.push(result()) } }))
  const traces: string[] = []
  const h = engineWith(fakes, { trace: (_direction, line) => traces.push(line) })
  const first = turnInput()
  const mcp = { args: ["--mcp-config", "/tmp/test-mcp.json"], cwd: "/temporary-project", scrub: (text: string) => text.replaceAll(secret, "[redacted]") }
  expect(await h.engine.runTurn({ ...first.input, externalMcp: mcp })).toEqual({ status: "ok" })
  expect(await fakes[0]!.transport.exited).toBe(1)
  expect(h.spawned[0]!.cwd).toBe("/temporary-project")
  expect(h.spawned[0]!.args).toEqual(expect.arrayContaining(mcp.args))
  const second = turnInput({ sessionId: first.input.sessionId })
  expect(await h.engine.runTurn({ ...second.input, externalMcp: mcp })).toEqual({ status: "ok" })
  expect(h.spawned[1]!.args).toContain("--resume=cc-session-1")
  expect(JSON.stringify([...first.events, ...second.events])).not.toContain(secret)
  // Stream deltas can split a secret; the completed text and raw complete trace are scrubbed.
  expect(first.events.filter((event) => event.type === "item.completed")).toContainEqual(expect.objectContaining({ text: "[redacted]" }))
  expect(traces.some((line) => line.includes(secret))).toBe(false)
  h.engine.stop()
})

test("a bridged turn that leaves a background agent running keeps its process: the next turn runs there and the agent lives; it stops once the agent ends", async () => {
  let turns = 0
  const started = fakeClaude({
    onUser(api) {
      api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
      if (++turns === 1) api.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "Fix torn_tail tests" }] })
      streamText(api, 0, "ok")
      api.push(result())
    },
  })
  const closes: Array<[string, number]> = []
  const h = engineWith([started], { onClose: (_sessionId, reason, background) => void closes.push([reason, background]) })
  const mcp = { args: ["--mcp-config", "/tmp/test-mcp.json"], cwd: "/temporary-project", scrub: (text: string) => text }
  const first = turnInput()
  expect(await h.engine.runTurn({ ...first.input, externalMcp: mcp })).toEqual({ status: "ok" })
  expect(closes).toEqual([])
  expect(h.engine.busy()).toBe(true)
  // The next turn, bridged too, joins the agent's process instead of starting one that would end it.
  expect(await h.engine.runTurn({ ...turnInput({ sessionId: first.input.sessionId }).input, externalMcp: mcp })).toEqual({ status: "ok" })
  expect(h.spawned).toHaveLength(1)
  expect(closes).toEqual([])
  started.api.push({ type: "system", subtype: "background_tasks_changed", tasks: [] })
  await Bun.sleep(5)
  expect(closes).toEqual([["its bridged turn ended", 0]])
  expect(h.engine.busy()).toBe(false)
  h.engine.stop()
})

test("a cancel while the attachments are read sends nothing: the turn ends as cancelled and Claude Code never hears the prompt", async () => {
  const fake = fakeClaude({ onUser(api) { api.push(result()) } })
  const abort = new AbortController()
  const h = engineWith([fake], { readBlob: async () => (abort.abort(), new Uint8Array([1, 2, 3])) })
  const first = turnInput({ text: "look", signal: abort.signal })
  first.input.attachments = [{ sha256: "a".repeat(64), mime: "image/png", bytes: 3, name: "shot.png" } as any]
  expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
  expect(fake.written.filter((message) => message.type === "user")).toEqual([])
  h.engine.stop()
})

test("an image with a token in the text goes right after the token: text, image, text (without tokens, images first and the text last)", async () => {
  const placed = { sha256: "a".repeat(64), mime: "image/png", bytes: 3, name: "shot.png", label: "[Image #1]", at: "mira [Image #1]".length } as any
  const fake = fakeClaude({ onUser(api) { api.push({ type: "system", subtype: "init", session_id: "cc-session-1" }); api.push(result()) } })
  const h = engineWith([fake], { readBlob: async () => new Uint8Array([1, 2, 3]) })
  const first = turnInput({ text: "mira [Image #1] y luego" })
  first.input.attachments = [placed]
  expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
  expect(fake.written.find((message) => message.type === "user").message.content).toEqual([
    { type: "text", text: "mira [Image #1]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") } },
    { type: "text", text: " y luego" },
  ])
  const loose = fakeClaude({ onUser(api) { api.push({ type: "system", subtype: "init", session_id: "cc-session-2" }); api.push(result()) } })
  const other = engineWith([loose], { readBlob: async () => new Uint8Array([1, 2, 3]) })
  const second = turnInput({ text: "mira" })
  second.input.attachments = [{ ...placed, label: undefined, at: undefined }]
  await other.engine.runTurn(second.input)
  expect(loose.written.find((message) => message.type === "user").message.content.map((block: any) => block.type)).toEqual(["image", "text"])
  h.engine.stop()
  other.engine.stop()
})

test("Claude Code's own sub-agents are told about MendCode's tools through a SubagentStart hook; any other callback gets an empty answer", async () => {
  const fake = fakeClaude({ onUser(api) {
    api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
    api.push({ type: "control_request", request_id: "hook-1", request: { subtype: "hook_callback", callback_id: "mendcode-subagent-start", input: { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" } } })
    api.push({ type: "control_request", request_id: "hook-2", request: { subtype: "hook_callback", callback_id: "someone-else", input: {} } })
    setTimeout(() => api.push(result()), 5)
  } })
  const h = engineWith([fake], { subagentContext: async () => "Use mcp__mendcode__graph_find first." })
  expect(await h.engine.runTurn(turnInput().input)).toEqual({ status: "ok" })
  expect(fake.written[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize", hooks: { SubagentStart: [{ hookCallbackIds: ["mendcode-subagent-start"] }] } } })
  const answers = fake.written.filter((message) => message.type === "control_response")
  expect(answers).toContainEqual({ type: "control_response", response: { subtype: "success", request_id: "hook-1", response: { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "Use mcp__mendcode__graph_find first." } } } })
  expect(answers).toContainEqual({ type: "control_response", response: { subtype: "success", request_id: "hook-2", response: {} } })
  h.engine.stop()
})

test("One tree hears Bash output and file writes through a PostToolUse hook, and its line goes back as that call's context", async () => {
  const fake = fakeClaude({ onUser(api) {
    api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
    api.push({ type: "control_request", request_id: "hook-1", request: { subtype: "hook_callback", callback_id: "mendcode-one-tree", input: { hook_event_name: "PostToolUse", cwd: "/repo", tool_name: "Bash", tool_input: { command: "git status --short" }, tool_response: { stdout: " M apps/art.ts", stderr: "" } } } })
    api.push({ type: "control_request", request_id: "hook-2", request: { subtype: "hook_callback", callback_id: "mendcode-one-tree", input: { hook_event_name: "PostToolUse", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/docs/a.md" }, tool_response: { filePath: "/repo/docs/a.md" } } } })
    // One of Claude Code's own sub-agents: a writer of its own, so the main thread is told about its files.
    api.push({ type: "control_request", request_id: "hook-3", request: { subtype: "hook_callback", callback_id: "mendcode-one-tree", input: { hook_event_name: "PostToolUse", cwd: "/repo", agent_id: "astra-4", tool_name: "Write", tool_input: { file_path: "/repo/b.ts" }, tool_response: {} } } })
    setTimeout(() => api.push(result()), 5)
  } })
  const heard: Array<{ written: string[]; output: string; cwd: string }> = []
  const writers: string[] = []
  const h = engineWith([fake], { oneTree: ({ sessionId, written, output, cwd }: { sessionId: string; written: string[]; output: string; cwd: string }) => (writers.push(sessionId), heard.push({ written, output, cwd }), output.includes("apps/art.ts") ? "[one tree] apps/art.ts is «Pets»'s" : undefined) })
  expect(await h.engine.runTurn(turnInput().input)).toEqual({ status: "ok" })
  expect(fake.written[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize", hooks: { PostToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hookCallbackIds: ["mendcode-one-tree"] }] } } })
  expect(heard).toEqual([{ written: [], output: " M apps/art.ts\n", cwd: "/repo" }, { written: ["/repo/docs/a.md"], output: "", cwd: "/repo" }, { written: ["/repo/b.ts"], output: "", cwd: "/repo" }])
  expect(writers[2]).toBe(`${writers[0]}#astra-4`)
  const answers = fake.written.filter((message) => message.type === "control_response")
  expect(answers).toContainEqual({ type: "control_response", response: { subtype: "success", request_id: "hook-1", response: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "[one tree] apps/art.ts is «Pets»'s" } } } })
  expect(answers).toContainEqual({ type: "control_response", response: { subtype: "success", request_id: "hook-2", response: {} } })
  h.engine.stop()
})

/** A scripted stand-in for one `claude` process: `onUser` / `onControl` answer what MendCode writes. */
function fakeClaude(script: { onUser?(api: FakeApi, content: any[]): void; onControl?(api: FakeApi, request: any): unknown } = {}) {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>((resolve) => (exitResolve = resolve))
  let done = false
  const written: any[] = []
  const permissionAnswers = new Map<string, (value: any) => void>()
  let stderr = ""
  const api = {
    push(message: unknown) {
      queue.push(JSON.stringify(message))
      wake?.()
    },
    ask(request: Record<string, unknown>): Promise<any> {
      const requestId = `perm-${permissionAnswers.size + 1}-${Math.random()}`
      return new Promise((resolve) => {
        permissionAnswers.set(requestId, resolve)
        api.push({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_use_id: "toolu_x", ...request } })
      })
    },
    exit(tail = "") {
      stderr = tail
      done = true
      wake?.()
      exitResolve(1)
    },
  }
  const transport: ClaudeTransport = {
    write(line) {
      const message = JSON.parse(line)
      written.push(message)
      if (message.type === "control_request") {
        const answer = script.onControl ? script.onControl(api, message.request) : {}
        if (answer !== null) api.push({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: answer ?? {} } })
      } else if (message.type === "control_response") permissionAnswers.get(message.response.request_id)?.(message.response.response)
      else if (message.type === "user") queueMicrotask(() => script.onUser?.(api, message.message.content))
    },
    lines: (async function* () {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    })(),
    close: () => api.exit(),
    exited,
    stderrTail: () => stderr,
  }
  return { transport, written, api }
}
type FakeApi = ReturnType<typeof fakeClaude>["api"]

const streamText = (api: FakeApi, index: number, text: string) => {
  api.push({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } }, parent_tool_use_id: null })
  for (const piece of text.match(/.{1,4}/g) ?? []) api.push({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }, parent_tool_use_id: null })
  api.push({ type: "stream_event", event: { type: "content_block_stop", index }, parent_tool_use_id: null })
}
const streamTool = (api: FakeApi, index: number, id: string, name: string, input: Record<string, unknown>) => {
  api.push({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }, parent_tool_use_id: null })
  const json = JSON.stringify(input)
  for (let i = 0; i < json.length; i += 7) api.push({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 7) } }, parent_tool_use_id: null })
  api.push({ type: "stream_event", event: { type: "content_block_stop", index }, parent_tool_use_id: null })
}
const result = (patch: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
  session_id: "cc-session-1",
  usage: { input_tokens: 18, cache_creation_input_tokens: 100, cache_read_input_tokens: 3000, output_tokens: 169, output_tokens_details: { thinking_tokens: 78 } },
  modelUsage: { "claude-haiku-4-5-20251001": {} },
  ...patch,
})

function turnInput(patch: { sessionId?: SessionId; mode?: () => PermissionMode; answer?: (request: EngineRequest) => EngineResolution | Promise<EngineResolution>; signal?: AbortSignal; text?: string } = {}) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const modes: PermissionMode[] = []
  const input: TurnInput = {
    sessionId: patch.sessionId ?? ids("session"),
    turnId: ids("turn"),
    text: patch.text ?? "hello",
    attachments: [],
    signal: patch.signal ?? new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => {
      asked.push(request)
      return (await patch.answer?.(request)) ?? { kind: "abandoned" }
    },
    permissionMode: patch.mode ?? (() => "ask"),
    setPermissionMode: (mode) => void modes.push(mode),
  }
  return { input, events, asked, modes }
}

function engineWith(fakes: Array<ReturnType<typeof fakeClaude>>, extra: Partial<Parameters<typeof createClaudeEngine>[0]> = {}) {
  const spawned: Array<{ args: string[]; cwd: string }> = []
  const quotas: GlobalEventDraft[] = []
  const bound = new Map<SessionId, string>()
  let model: { model?: string; effort?: "low" | "medium" | "high" } = { model: "haiku", effort: "low" }
  const engine = createClaudeEngine({
    cwdFor: () => "/work/app",
    modelFor: () => model,
    bindings: { get: (sessionId) => bound.get(sessionId), set: (sessionId, id) => void bound.set(sessionId, id) },
    onQuota: (quota) => void quotas.push(quota),
    transportFactory: (input) => {
      spawned.push(input)
      const fake = fakes[spawned.length - 1]
      if (!fake) throw new Error("spawn ENOENT claude")
      return fake.transport
    },
    ...extra,
  })
  return { engine, spawned, quotas, bound, setModel: (next: typeof model) => void (model = next) }
}

describe("claude engine turns", () => {
  test("a tool call and an answer stream as items; usage, quota and the Claude session id are recorded", async () => {
    const fake = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1", model: "claude-haiku-4-5-20251001", permissionMode: "default" })
        api.push({ type: "stream_event", event: { type: "message_start", message: { model: "claude-haiku-4-5-20251001" } }, parent_tool_use_id: null })
        api.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, parent_tool_use_id: null })
        api.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } }, parent_tool_use_id: null })
        api.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null })
        streamTool(api, 1, "toolu_1", "Bash", { command: "cat note.txt", description: "Read it" })
        api.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: 1790755200 }, seven_day: { utilization: 0.51, resetsAt: 1791046800 } } } })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello from the capture", is_error: false }] }, parent_tool_use_id: null })
        streamText(api, 0, "hello from the capture")
        api.push(result())
      },
    })
    const { engine, spawned, quotas, bound } = engineWith([fake])
    const { input, events } = turnInput()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })

    expect(spawned[0]!.cwd).toBe("/work/app")
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--model", "haiku", "--effort", "low", "--thinking-display", "summarized"]))
    expect(fake.written[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize" } })
    expect(fake.written[1]).toMatchObject({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } })

    const tool = events.find((event) => event.type === "item.started" && event.kind === "tool_call")
    expect(tool).toMatchObject({ meta: { tool: "shell: cat note.txt" } })
    expect(events).toContainEqual({ type: "item.completed", itemId: (tool as any).itemId, status: "ok", text: "hello from the capture" })
    // A thinking block without text is still an item (the working row says "Thinking..."); it ends with no text, so the transcript draws no card.
    const thought = events.find((event) => event.type === "item.started" && event.kind === "reasoning") as any
    expect(events.indexOf(thought)).toBeLessThan(events.indexOf(tool!))
    expect(events).toContainEqual({ type: "item.completed", itemId: thought.itemId, status: "ok", text: "" })
    expect(events.some((event) => event.type === "item.delta" && event.itemId === thought.itemId)).toBe(false)
    const text =events.find((event) => event.type === "item.started" && event.kind === "agent_message") as any
    expect(events.filter((event) => event.type === "item.delta" && event.itemId === text.itemId).map((event: any) => event.text).join("")).toBe("hello from the capture")
    expect(events).toContainEqual({ type: "item.completed", itemId: text.itemId, status: "ok", text: "hello from the capture" })
    expect(events).toContainEqual({ type: "usage", provider: "claude", model: "claude-haiku-4-5-20251001", input: 18, output: 169, reasoning: 78, cacheRead: 3000, cacheWrite: 100 })

    expect(quotas).toEqual([
      {
        type: "quota.snapshot",
        provider: "claude",
        windows: [
          { id: "five_hour", label: "5h", usedPercent: 7, resetsAt: 1790755200000, windowMinutes: 300 },
          { id: "seven_day", label: "7d", usedPercent: 51, resetsAt: 1791046800000, windowMinutes: 10080 },
        ],
        status: "allowed",
        fetchedAt: expect.any(Number),
        source: "claude code rate_limit_event",
      },
    ])
    expect([...bound.values()]).toEqual(["cc-session-1"])
    engine.stop()
  })

  /** One main-thread model call as Claude Code streams it: message_start carries the prompt, message_delta the cumulative output, and a whole `assistant` message repeats both. */
  const modelCall = (api: FakeApi, call: { id: string; input: number; cacheRead: number; cacheWrite: number; output: number; parent?: string; tool?: boolean }) => {
    const parent = call.parent ?? null
    api.push({ type: "stream_event", event: { type: "message_start", message: { id: call.id, model: "claude-opus-4-8", usage: { input_tokens: call.input, cache_read_input_tokens: call.cacheRead, cache_creation_input_tokens: call.cacheWrite, output_tokens: 1 } } }, parent_tool_use_id: parent })
    if (call.tool) streamTool(api, 0, `toolu_${call.id}`, "Bash", { command: "ls" })
    else streamText(api, 0, "done")
    api.push({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: call.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: call.output } }, parent_tool_use_id: parent })
    api.push({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: parent })
    api.push({ type: "assistant", message: { id: call.id, role: "assistant", usage: { input_tokens: call.input, cache_read_input_tokens: call.cacheRead, cache_creation_input_tokens: call.cacheWrite, output_tokens: call.output }, content: [] }, parent_tool_use_id: parent })
    if (call.tool) api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${call.id}`, content: "ok", is_error: false }] }, parent_tool_use_id: parent })
  }
  const longTurn = (windowTokens: number) => (api: FakeApi) => {
    api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
    modelCall(api, { id: "msg_1", input: 6, cacheRead: 40_000, cacheWrite: 2_000, output: 120, tool: true })
    // A sub-agent works for several calls with a big prompt of its own: none of it is the main thread's context.
    for (const n of [1, 2, 3]) modelCall(api, { id: `sub_${n}`, input: 4, cacheRead: 90_000, cacheWrite: 1_000, output: 200, parent: "toolu_msg_1" })
    modelCall(api, { id: "msg_2", input: 3, cacheRead: 43_000, cacheWrite: 500, output: 300, tool: true })
    modelCall(api, { id: "msg_3", input: 2, cacheRead: 43_500, cacheWrite: 300, output: 450 })
    // The result's usage and modelUsage are sums over every call of the turn, sub-agents included.
    api.push(result({ usage: { input_tokens: 15, cache_creation_input_tokens: 3_800, cache_read_input_tokens: 400_000, output_tokens: 1_470, output_tokens_details: { thinking_tokens: 0 } }, modelUsage: { "claude-opus-4-8": { contextWindow: windowTokens } } }))
  }

  test("context after a multi-call turn is the last main-thread call's prompt, never the turn's cumulative usage; the usage totals stay the true sums", async () => {
    const { engine } = engineWith([fakeClaude({ onUser: longTurn(200_000) })])
    const { input, events } = turnInput()
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    const usage = events.filter((event) => event.type === "usage")
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ provider: "claude", model: "claude-opus-4-8", input: 15, cacheWrite: 3_800, cacheRead: 400_000, output: 1_470 })
    // msg_3: 2 + 43_500 + 300 prompt, plus the 450 tokens it answered with.
    expect(usage[0]).toMatchObject({ context: 2 + 43_500 + 300 + 450, contextWindow: 200_000 })
    expect(usage[0]).not.toHaveProperty("contextApprox")
    engine.stop()
  })

  test("a context the engine's own window cannot hold is clamped to that window and marked approximate", async () => {
    const { engine } = engineWith([fakeClaude({ onUser: longTurn(30_000) })])
    const { input, events } = turnInput()
    await engine.runTurn(input)
    expect(events.find((event) => event.type === "usage")).toMatchObject({ context: 30_000, contextWindow: 30_000, contextApprox: true })
    engine.stop()
  })

  test("a turn that ends without a result still records what its calls reported, once each, marked partial", async () => {
    const { engine } = engineWith([fakeClaude({ onUser: (api) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
      modelCall(api, { id: "msg_1", input: 6, cacheRead: 40_000, cacheWrite: 2_000, output: 120, tool: true })
      modelCall(api, { id: "msg_2", input: 3, cacheRead: 43_000, cacheWrite: 500, output: 300 })
      api.exit("killed")
    } })])
    const { input, events } = turnInput()
    expect(await engine.runTurn(input)).toMatchObject({ status: "error", code: "claude_exited" })
    const usage = events.filter((event) => event.type === "usage")
    expect(usage).toEqual([{ type: "usage", provider: "claude", model: "claude-opus-4-8", input: 9, output: 420, reasoning: 0, cacheRead: 83_000, cacheWrite: 2_500, partial: true }])
    engine.stop()
  })

  test("a turn whose result reports usage sends only the result's totals, never the partial sums too", async () => {
    const { engine } = engineWith([fakeClaude({ onUser: longTurn(200_000) })])
    const { input, events } = turnInput()
    await engine.runTurn(input)
    expect(events.filter((event) => event.type === "usage").map((event) => "partial" in event)).toEqual([false])
    engine.stop()
  })

  test("a turn with no main-thread call on the stream reports no context rather than the cumulative totals", async () => {
    const { engine } = engineWith([fakeClaude({ onUser: (api) => { api.push({ type: "system", subtype: "init", session_id: "cc-session-1" }); api.push(result()) } })])
    const { input, events } = turnInput()
    await engine.runTurn(input)
    expect(events.find((event) => event.type === "usage")).not.toHaveProperty("context")
    engine.stop()
  })

  test("the process is reused between turns; a new model restarts it resuming the Claude session", async () => {
    const answer = (api: FakeApi) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-7" })
      streamText(api, 0, "ok")
      api.push(result({ session_id: "cc-7" }))
    }
    const first = fakeClaude({ onUser: answer })
    const second = fakeClaude({ onUser: answer })
    const { engine, spawned, setModel } = engineWith([first, second])
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(spawned).toHaveLength(1)
    setModel({ model: "opus", effort: "high" })
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(spawned).toHaveLength(2)
    expect(spawned[1]!.args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high", "--resume=cc-7"]))
    engine.stop()
  })

  test("claudeCacheTtl: the process gets Claude Code's two cache TTL variables only while the setting is on and the lifetime is 1h", async () => {
    const answer = (api: FakeApi) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-ttl" })
      streamText(api, 0, "ok")
      api.push(result({ session_id: "cc-ttl" }))
    }
    const settings: { claudeCacheTtl?: boolean; promptCacheTtl?: "5m" | "1h" } = {}
    const { engine, spawned } = engineWith([fakeClaude({ onUser: answer }), fakeClaude({ onUser: answer }), fakeClaude({ onUser: answer })], { env: () => claudeCacheEnv(settings) })
    // Off (the default in every tier): the child inherits the daemon's environment untouched.
    settings.promptCacheTtl = "1h"
    await engine.runTurn(turnInput().input)
    expect(spawned[0]).toEqual({ args: spawned[0]!.args, cwd: "/work/app" })
    expect("env" in spawned[0]!).toBe(false)
    // On: read when the next process starts.
    settings.claudeCacheTtl = true
    await engine.runTurn(turnInput().input)
    expect((spawned[1] as { env?: Record<string, string> }).env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h" })
    // On at 5m: nothing is passed, Claude Code keeps its own defaults.
    settings.promptCacheTtl = "5m"
    await engine.runTurn(turnInput().input)
    expect("env" in spawned[2]!).toBe(false)
    engine.stop()
  })

  test("the process environment is asked for with the session and the model it starts on (the sub-agent model follows it)", async () => {
    const answer = (api: FakeApi) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-sub" })
      streamText(api, 0, "ok")
      api.push(result({ session_id: "cc-sub" }))
    }
    const asked: Array<[string, string | undefined]> = []
    const { engine, spawned, setModel } = engineWith([fakeClaude({ onUser: answer })], { env: (sessionId, model) => (asked.push([sessionId, model.model]), model.model === "opus" ? { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } : undefined) })
    setModel({ model: "opus" })
    const { input } = turnInput()
    await engine.runTurn(input)
    expect(asked).toEqual([[input.sessionId, "opus"]])
    expect((spawned[0] as { env?: Record<string, string> }).env).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" })
    engine.stop()
  })

  test("a claude that does not know --thinking-display exits at start; the engine starts it again without the flag and keeps it off", async () => {
    const answer = (api: FakeApi) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-1" })
      streamText(api, 0, "ok")
      api.push(result())
    }
    const old = fakeClaude({ onControl(api) { api.exit("error: unknown option '--thinking-display'"); return null } })
    const { engine, spawned } = engineWith([old, fakeClaude({ onUser: answer }), fakeClaude({ onUser: answer })])
    expect(await engine.runTurn(turnInput().input)).toEqual({ status: "ok" })
    expect(spawned).toHaveLength(2)
    expect(spawned[0]!.args).toContain("--thinking-display")
    expect(spawned[1]!.args).not.toContain("--thinking-display")
    // Another session no longer asks for it.
    expect(await engine.runTurn(turnInput({ sessionId: ids("session") }).input)).toEqual({ status: "ok" })
    expect(spawned[2]!.args).not.toContain("--thinking-display")
    engine.stop()
  })

  test("a per-turn model selection reaches modelFor, restarts the process for that turn and the saved model returns on the next", async () => {
    const answer = (api: FakeApi) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-8" })
      streamText(api, 0, "ok")
      api.push(result({ session_id: "cc-8" }))
    }
    const fakes = [fakeClaude({ onUser: answer }), fakeClaude({ onUser: answer }), fakeClaude({ onUser: answer })]
    const seen: Array<unknown> = []
    const { engine, spawned } = engineWith(fakes, { modelFor: (_sessionId, override) => (seen.push(override), override ? { model: "opus", effort: "high" } : { model: "haiku", effort: "low" }) })
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    const override = turnInput({ sessionId })
    await engine.runTurn({ ...override.input, selection: { model: { model: "claude-opus", effort: "high" } } })
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(seen).toEqual([undefined, { model: "claude-opus", effort: "high" }, undefined])
    expect(spawned.map((entry) => entry.args.filter((arg) => ["haiku", "opus"].includes(arg)))).toEqual([["haiku"], ["opus"], ["haiku"]])
    expect(spawned[1]!.args).toContain("--resume=cc-8")
    engine.stop()
  })

  test("a permission mode change between turns is sent before the next message", async () => {
    const fake = fakeClaude({ onUser: (api) => (streamText(api, 0, "ok"), api.push(result())) })
    const { engine } = engineWith([fake])
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    await engine.runTurn(turnInput({ sessionId, mode: () => "edits" }).input)
    const controls = fake.written.filter((message) => message.type === "control_request").map((message) => message.request)
    expect(controls).toContainEqual({ subtype: "set_permission_mode", mode: "acceptEdits" })
    const setIndex = fake.written.findIndex((message) => message.request?.subtype === "set_permission_mode")
    expect(fake.written.slice(setIndex).some((message) => message.type === "user")).toBe(true)
    engine.stop()
  })

  test("stop interrupts: the interrupt control request goes out, open text ends interrupted, and the turn is ok", async () => {
    const controller = new AbortController()
    const fake = fakeClaude({
      onUser(api) {
        api.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null })
        api.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "1 2 3" } }, parent_tool_use_id: null })
        queueMicrotask(() => controller.abort())
      },
      onControl(api, request) {
        if (request.subtype === "interrupt") queueMicrotask(() => api.push(result({ terminal_reason: "aborted_streaming" })))
        return {}
      },
    })
    const { engine } = engineWith([fake])
    const { input, events } = turnInput({ signal: controller.signal })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(fake.written.some((message) => message.request?.subtype === "interrupt")).toBe(true)
    const text = events.find((event) => event.type === "item.started") as any
    expect(events).toContainEqual({ type: "item.completed", itemId: text.itemId, status: "interrupted", text: "1 2 3" })
    engine.stop()
  })

  test("esc ends the turn within the grace even when Claude Code is slow to stop; the rest of that turn never reaches the next", async () => {
    const clock = createVirtualClock(1_000)
    const controller = new AbortController()
    let pushLate: (() => void) | undefined
    let turns = 0
    const fake = fakeClaude({
      onUser(api) {
        turns++
        if (turns === 1) {
          api.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null })
          queueMicrotask(() => controller.abort())
          // The interrupted turn's own end arrives only after the next prompt was sent.
          pushLate = () => api.push(result({ terminal_reason: "aborted_streaming" }))
          return
        }
        pushLate?.()
        streamText(api, 0, "second answer")
        api.push(result())
      },
      onControl() { return {} },
    })
    const { engine } = engineWith([fake], { clock })
    const sessionId = ids("session")
    const first = engine.runTurn(turnInput({ sessionId, signal: controller.signal }).input)
    await Bun.sleep(5)
    clock.advance(CANCEL_GRACE_MS)
    expect(await first).toEqual({ status: "ok" })
    const next = turnInput({ sessionId })
    expect(await engine.runTurn(next.input)).toEqual({ status: "ok" })
    expect(next.events.filter((event) => event.type === "item.delta").map((event) => (event as any).text).join("")).toBe("second answer")
    engine.stop()
  })

  test("claude exiting mid-turn fails the turn with its stderr, and the next turn starts a new process", async () => {
    const dying = fakeClaude({ onUser: (api) => api.exit("Error: not logged in") })
    const fresh = fakeClaude({ onUser: (api) => (streamText(api, 0, "back"), api.push(result())) })
    const { engine, spawned } = engineWith([dying, fresh])
    const sessionId = ids("session")
    const outcome = await engine.runTurn(turnInput({ sessionId }).input)
    expect(outcome).toMatchObject({ status: "error", code: "claude_exited" })
    expect((outcome as any).message).toContain("not logged in")
    expect(await engine.runTurn(turnInput({ sessionId }).input)).toEqual({ status: "ok" })
    expect(spawned).toHaveLength(2)
    engine.stop()
  })

  test("without claude installed the turn fails with the install hint", async () => {
    const { engine } = engineWith([])
    expect(await engine.runTurn(turnInput().input)).toEqual({ status: "error", code: "claude_missing", message: "[CLAUDE]: `claude` was not found. Install Claude Code and run `claude auth login`." })
  })

  test("a failed result is an error with Claude's message", async () => {
    const fake = fakeClaude({ onUser: (api) => api.push(result({ subtype: "error_during_execution", is_error: true, terminal_reason: "error", errors: ["prompt is too long"] })) })
    const { engine } = engineWith([fake])
    expect(await engine.runTurn(turnInput().input)).toEqual({ status: "error", code: "claude_turn_failed", message: "[CLAUDE]: prompt is too long" })
    engine.stop()
  })

  test("silence past the idle limit interrupts the turn", async () => {
    const fake = fakeClaude({ onUser: () => {} })
    const { engine } = engineWith([fake], { idleMs: 20 })
    const outcome = await engine.runTurn(turnInput().input)
    expect(outcome).toMatchObject({ status: "error", code: "stream_idle" })
    expect(fake.written.some((message) => message.request?.subtype === "interrupt")).toBe(true)
    engine.stop()
  })
})

describe("claude engine permissions", () => {
  async function permissionTurn(request: Record<string, unknown>, options: { mode?: PermissionMode; answer?: (request: EngineRequest) => EngineResolution; safetyPrompts?: () => boolean | undefined } = {}) {
    let decision: any
    const fake = fakeClaude({
      async onUser(api) {
        decision = await api.ask(request)
        streamText(api, 0, "done")
        api.push(result())
      },
    })
    const { engine, spawned } = engineWith([fake], { safetyPrompts: options.safetyPrompts ?? (() => true) })
    const turn = turnInput({ mode: () => options.mode ?? "ask", ...(options.answer ? { answer: options.answer } : {}) })
    const outcome = await engine.runTurn(turn.input)
    engine.stop()
    return { outcome, decision, asked: turn.asked, modes: turn.modes, spawned }
  }

  test("in ask mode a tool waits for the user: approve allows, deny sends the reason back", async () => {
    const approved = await permissionTurn({ tool_name: "Bash", input: { command: "rm -rf build" }, decision_reason: "\x1b[1mdeletes files\x1b[0m" }, { answer: () => ({ kind: "approve", scope: "once" }) })
    expect(approved.asked[0]).toMatchObject({ kind: "approval", title: "shell: rm -rf build", tool: "Bash", permission: "execute" })
    expect(approved.asked[0]!.detail).toBe("deletes files\n\nrm -rf build")
    expect(approved.decision).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" } })
    const denied = await permissionTurn({ tool_name: "Bash", input: { command: "rm -rf build" } }, { answer: () => ({ kind: "deny", reason: "not now" }) })
    expect(denied.decision).toEqual({ behavior: "deny", message: "not now" })
  })

  test("always for this session keeps Claude's suggested rules in memory only", async () => {
    const { decision } = await permissionTurn({ tool_name: "Bash", input: { command: "bun test" }, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "localSettings" }] }, { answer: () => ({ kind: "approve", scope: "session" }) })
    expect(decision.updatedPermissions).toEqual([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "session" }])
  })

  test("a mode suggestion is never applied, and Claude's short description is not shown as a reason", async () => {
    const { decision, asked } = await permissionTurn(
      { tool_name: "Write", display_name: "Write", description: "hello.txt", input: { file_path: "/p/hello.txt", content: "hi" }, permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] },
      { answer: () => ({ kind: "approve", scope: "session" }) },
    )
    expect(decision).toEqual({ behavior: "allow", updatedInput: { file_path: "/p/hello.txt", content: "hi" } })
    expect(asked[0]!.detail).toBe("/p/hello.txt\n\nhi")
  })

  describe("a call Claude Code flags although the session is in full access (bypass mode)", () => {
    const dangerous = { tool_name: "Bash", input: { command: "mkdir -p /tmp/x && cd /tmp/x && rm -f * && curl example.test" }, decision_reason: "Dangerous rm operation", permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow", destination: "localSettings" }] }

    test("Claude Code runs in bypass mode, and the flagged call is shown with its own reason and without an always choice", async () => {
      const shown = await permissionTurn(dangerous, { mode: "full", answer: () => ({ kind: "approve", scope: "session" }) })
      expect(shown.spawned[0]!.args).toContain("bypassPermissions")
      expect(shown.asked).toHaveLength(1)
      expect(shown.asked[0]).toMatchObject({ kind: "approval", tool: "Bash", permission: "execute", engineFlagged: true })
      expect(shown.asked[0]!.detail).toBe(`Dangerous rm operation\n\n${dangerous.input.command}`)
      // Even a "for this session" answer allows this call only: Claude's suggested rule is not kept.
      expect(shown.decision).toEqual({ behavior: "allow", updatedInput: dangerous.input })
    })
    test("reject sends the user's reason back and the turn carries on", async () => {
      const denied = await permissionTurn(dangerous, { mode: "full", answer: () => ({ kind: "deny", reason: "not in /tmp" }) })
      expect(denied.decision).toEqual({ behavior: "deny", message: "not in /tmp" })
      expect(denied.outcome).toEqual({ status: "ok" })
      const unanswered = await permissionTurn(dangerous, { mode: "full" })
      expect(unanswered.decision).toEqual({ behavior: "deny", message: "The user denied this." })
    })
    test("a request without a reason still says why it is shown", async () => {
      const shown = await permissionTurn({ tool_name: "Bash", input: { command: "rm -rf build" } }, { mode: "full", answer: () => ({ kind: "approve", scope: "once" }) })
      expect(shown.asked[0]!.detail).toBe("Claude Code asks about this call even though the session is in full access.\n\nrm -rf build")
    })
    test("full access runs it unattended unless engineSafetyPrompts is on: unset and false both allow without asking", async () => {
      for (const safetyPrompts of [() => false, () => undefined]) {
        const quiet = await permissionTurn(dangerous, { mode: "full", safetyPrompts })
        expect(quiet.asked).toHaveLength(0)
        expect(quiet.decision).toEqual({ behavior: "allow", updatedInput: dangerous.input })
      }
    })
    test("a mode switch to full after Claude Code started in ask mode is not a flagged call", async () => {
      let mode: PermissionMode = "ask"
      let decision: any
      const fake = fakeClaude({
        async onUser(api) {
          mode = "full"
          decision = await api.ask({ tool_name: "Bash", input: { command: "make" } })
          streamText(api, 0, "done")
          api.push(result())
        },
      })
      const { engine } = engineWith([fake])
      const turn = turnInput({ mode: () => mode })
      await engine.runTurn(turn.input)
      engine.stop()
      expect(turn.asked).toHaveLength(0)
      expect(decision.behavior).toBe("allow")
    })
  })

  test("full allows everything, edits allows writes without asking, plan refuses changes", async () => {
    expect((await permissionTurn({ tool_name: "Bash", input: { command: "make" } }, { mode: "full", safetyPrompts: () => false })).decision.behavior).toBe("allow")
    const edits = await permissionTurn({ tool_name: "Write", input: { file_path: "a.ts", content: "x" } }, { mode: "edits" })
    expect(edits.decision.behavior).toBe("allow")
    expect(edits.asked).toHaveLength(0)
    const plan = await permissionTurn({ tool_name: "Edit", input: { file_path: "a.ts" } }, { mode: "plan" })
    expect(plan.decision).toEqual({ behavior: "deny", message: "Plan mode: only reading is allowed until the plan is approved." })
  })

  test("AskUserQuestion becomes a MendCode question and its answer goes back in the tool input", async () => {
    const question = { question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "relational" }, { label: "Convex" }], multiSelect: false }
    const { decision, asked } = await permissionTurn({ tool_name: "AskUserQuestion", input: { questions: [question] } }, { answer: () => ({ kind: "answer", text: "Convex" }) })
    expect(asked[0]).toEqual({ kind: "question", title: "DB", detail: "Which database?", options: [{ label: "Postgres", description: "relational" }, { label: "Convex" }], multiple: false })
    expect(decision).toEqual({ behavior: "allow", updatedInput: { questions: [question], answers: { "Which database?": "Convex" } } })
  })

  test("several AskUserQuestion questions become one batch; each answer goes back under its question, a multiple choice joined", async () => {
    const images = { question: "How do we make the slides?", header: "Images", options: [{ label: "Codex", description: "image_gen there" }, { label: "Here" }], multiSelect: false }
    const formats = { question: "Which formats?", header: "Formats", options: [{ label: "PDF" }, { label: "PNG" }], multiSelect: true }
    const notes = { question: "Anything else?", header: "Notes", options: [{ label: "No" }] }
    const { decision, asked } = await permissionTurn({ tool_name: "AskUserQuestion", input: { questions: [images, formats, notes] } }, { answer: () => ({ kind: "answer", text: "Here\nPDF, PNG\n", answers: [["Here"], ["PDF", "PNG"], []] }) })
    expect(asked[0]).toEqual({ kind: "question", title: "Asked 3 questions", detail: "", questions: [
      { header: "Images", question: "How do we make the slides?", options: [{ label: "Codex", description: "image_gen there" }, { label: "Here" }] },
      { header: "Formats", question: "Which formats?", options: [{ label: "PDF" }, { label: "PNG" }], multiple: true },
      { header: "Notes", question: "Anything else?", options: [{ label: "No" }] },
    ] })
    expect(decision).toEqual({ behavior: "allow", updatedInput: { questions: [images, formats, notes], answers: { "How do we make the slides?": "Here", "Which formats?": "PDF, PNG" } } })
  })

  test("an approved plan leaves plan mode; a rejected one sends the user's changes", async () => {
    const approved = await permissionTurn({ tool_name: "ExitPlanMode", input: { plan: "1. do it" } }, { mode: "plan", answer: () => ({ kind: "approve", scope: "once" }) })
    expect(approved.asked[0]).toMatchObject({ kind: "approval", title: "Plan ready", detail: "1. do it" })
    expect(approved.decision.behavior).toBe("allow")
    expect(approved.modes).toEqual(["ask"])
    const rejected = await permissionTurn({ tool_name: "ExitPlanMode", input: { plan: "1. do it" } }, { mode: "plan", answer: () => ({ kind: "deny", reason: "add tests" }) })
    expect(rejected.decision).toEqual({ behavior: "deny", message: "The user wants changes to the plan: add tests" })
    expect(rejected.modes).toEqual([])
  })
})

describe("claude thinking blocks", () => {
  const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event, parent_tool_use_id: null })
  const mapped = (messages: Array<Record<string, unknown>>) => {
    const events: EngineEvent[] = []
    const mapper = createTurnMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event), model: "claude-haiku-5-5" })
    for (const message of messages) mapper.accept(message)
    return { events, mapper }
  }

  // The shape Claude Code 2.1.296 streamed for `claude -p "think step by step: what is 17*23?" --model claude-haiku-5-5` (signature shortened).
  const TEXTLESS = [
    stream({ type: "message_start", message: { model: "claude-haiku-5-5", id: "msg_011CftrRHyuRbMxvDP7SYbBe", usage: { input_tokens: 2, cache_creation_input_tokens: 27468, cache_read_input_tokens: 10959, output_tokens: 1 } } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50 },
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50 } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: null } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "CAQS2AYKEAgSGAI4AUII" } }),
  ]

  test("a text-less thinking block is a reasoning item from its start, without deltas, and ends with no text", () => {
    const { events, mapper } = mapped(TEXTLESS)
    expect(events).toEqual([{ type: "item.started", itemId: expect.any(String), kind: "reasoning" }])
    mapper.accept(stream({ type: "content_block_stop", index: 0 }))
    expect(events[1]).toEqual({ type: "item.completed", itemId: (events[0] as any).itemId, status: "ok", text: "" })
    mapper.accept(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }))
    mapper.accept(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "**391" } }))
    expect(events.slice(2).map((event) => event.type === "item.started" ? event.kind : event.type)).toEqual(["agent_message", "item.delta"])
  })

  test("wordless thinking that goes on says the model is alive with an empty delta every 20 of its own", () => {
    const { events, mapper } = mapped([stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })])
    for (let i = 0; i < 45; i++) mapper.accept(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: i } }))
    expect(events.filter((event) => event.type === "item.delta")).toEqual([
      { type: "item.delta", itemId: (events[0] as any).itemId, text: "" },
      { type: "item.delta", itemId: (events[0] as any).itemId, text: "" },
    ])
  })

  test("a tool whose input is long opens its card while the input is still being written, titled from what has arrived, and says how much is written", () => {
    const json = JSON.stringify({ file_path: "/p/app.js", content: "x\n".repeat(2000) })
    const { events, mapper } = mapped([
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Write", input: {} } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 1000) } }),
    ])
    expect(events).toEqual([])
    mapper.accept(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(1000, 2000) } }))
    const itemId = (events[0] as any).itemId
    expect(events).toEqual([
      { type: "item.started", itemId: expect.any(String), kind: "tool_call", meta: { tool: "write: /p/app.js" } },
      { type: "item.delta", itemId, text: "", input: { chars: 2000, lines: json.slice(0, 2000).split("\\n").length } },
    ])
    // At most one progress per 2,000 characters, then the input is whole: `done`, with its full size.
    mapper.accept(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(2000, 3000) } }))
    expect(events).toHaveLength(2)
    mapper.accept(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(3000) } }))
    mapper.accept(stream({ type: "content_block_stop", index: 0 }))
    expect(events.at(-1)).toEqual({ type: "item.delta", itemId, text: "", input: { chars: json.length, lines: 2001, done: true } })
    mapper.accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "File created" }] }, parent_tool_use_id: null })
    expect(events.at(-1)).toMatchObject({ type: "item.completed", itemId, status: "ok" })
  })

  test("an agent call writing a long prompt opens its card at once, and its completion carries the agent and background flag the input ended with", () => {
    const json = JSON.stringify({ description: "Audit fork", prompt: "p".repeat(4000), subagent_type: "general-purpose", run_in_background: true })
    const { events, mapper } = mapped([
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "Agent", input: {} } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 2000) } }),
    ])
    expect(events[0]).toEqual({ type: "item.started", itemId: expect.any(String), kind: "tool_call", meta: expect.objectContaining({ subagent: true, background: false }) })
    mapper.accept(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(2000) } }))
    mapper.accept(stream({ type: "content_block_stop", index: 0 }))
    expect(events.filter((event) => event.type !== "item.delta")).toHaveLength(1)
    mapper.accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "Launched in the background" }] }, parent_tool_use_id: null })
    expect(events.at(-1)).toMatchObject({ type: "item.completed", itemId: (events[0] as any).itemId, status: "ok", meta: { subagent: true, agent: "general-purpose", background: true } })
  })

  test("an edit's result carries the diff Claude Code made, so its card draws it like MendCode's own edit", () => {
    const { events, mapper } = mapped([
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_e", name: "Edit", input: {} } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/p/README.md","old_string":"a","new_string":"b"}' } }),
      stream({ type: "content_block_stop", index: 0 }),
    ])
    const structuredPatch = [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [" keep", "-old line", "+new line", "+another"] }]
    mapper.accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_e", content: "The file /p/README.md has been updated successfully." }] }, tool_use_result: { filePath: "/p/README.md", structuredPatch }, parent_tool_use_id: null })
    expect(events[1]).toMatchObject({ type: "item.completed", status: "ok", text: "@@ -3,2 +3,3 @@\n keep\n-old line\n+new line\n+another" })
    expect(claudeEditPatch({ type: "create", structuredPatch })).toBeUndefined()
    expect(claudeEditPatch({ structuredPatch: [] })).toBeUndefined()
    expect(claudeEditPatch({ structuredPatch: [{ oldStart: "x", lines: [] }] })).toBeUndefined()
  })

  test("a streaming tool input gives its finished and unfinished string fields, and nothing it cannot read", () => {
    expect(partialToolArgs('{"command":"python3 - <<\'E\'\\nimport os\\n')).toEqual({ command: "python3 - <<'E'\nimport os\n" })
    expect(partialToolArgs('{"file_path":"/a b","limit":3,"content":"say \\"hi\\" \\u00')).toEqual({ file_path: "/a b", content: 'say "hi" ' })
    expect(partialToolArgs('{"file_pa')).toEqual({})
  })

  test("a thinking block that carries text streams it into the same item", () => {
    const { events } = mapped([
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "17 × 20 " } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "= 340" } }),
      stream({ type: "content_block_stop", index: 0 }),
    ])
    const itemId = (events[0] as any).itemId
    expect(events).toEqual([
      { type: "item.started", itemId, kind: "reasoning" },
      { type: "item.delta", itemId, text: "17 × 20 " },
      { type: "item.delta", itemId, text: "= 340" },
      { type: "item.completed", itemId, status: "ok", text: "17 × 20 = 340" },
    ])
  })

  test("the turn's usage carries the window Claude Code states for the model, and the context of its one call", () => {
    const { events, mapper } = mapped(TEXTLESS)
    mapper.accept(stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 2, cache_creation_input_tokens: 27468, cache_read_input_tokens: 10959, output_tokens: 184, output_tokens_details: { thinking_tokens: 97 } } }))
    mapper.accept({
      type: "result", subtype: "success", terminal_reason: "completed",
      usage: { input_tokens: 2, cache_creation_input_tokens: 27468, cache_read_input_tokens: 10959, output_tokens: 184, output_tokens_details: { thinking_tokens: 97 } },
      modelUsage: { "claude-haiku-5-5": { inputTokens: 2, outputTokens: 184, cacheReadInputTokens: 10959, cacheCreationInputTokens: 27468, contextWindow: 1000000, maxOutputTokens: 128000, thinkingTokens: 97 } },
    })
    expect(events.at(-1)).toEqual({ type: "usage", provider: "claude", model: "claude-haiku-5-5", input: 2, output: 184, reasoning: 97, cacheRead: 10959, cacheWrite: 27468, context: 38613, contextWindow: 1_000_000 })
  })

  test("a turn cut off while thinking closes the open item as interrupted", () => {
    const { events, mapper } = mapped(TEXTLESS)
    mapper.finish("interrupted")
    expect(events[1]).toEqual({ type: "item.completed", itemId: (events[0] as any).itemId, status: "interrupted", text: "" })
  })
})

describe("the daemon's own tools inside claude code", () => {
  test("its process gets the session's flags; an own tool is allowed without a question, even in plan mode, and draws no card here", async () => {
    let decision: any
    let other: any
    const fake = fakeClaude({
      async onUser(api) {
        streamTool(api, 0, "toolu_own", "mcp__mendcode__graph_find", { query: "router" })
        decision = await api.ask({ tool_name: "mcp__mendcode__graph_find", input: { query: "router" } })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_own", content: "found" }] }, parent_tool_use_id: null })
        other = await api.ask({ tool_name: "mcp__linear__save_issue", input: {} })
        streamText(api, 1, "done")
        api.push(result())
      },
    })
    const { engine, spawned } = engineWith([fake], { ownTools: "mcp__mendcode__", sessionArgs: (sessionId) => ["--mcp-config", `/tmp/${sessionId}.json`] })
    const { input, events, asked } = turnInput({ mode: () => "plan" })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["--mcp-config", `/tmp/${input.sessionId}.json`]))
    expect(decision.behavior).toBe("allow")
    expect(other.behavior).toBe("deny")
    expect(asked).toEqual([])
    expect(events.filter((event) => event.type === "item.started").map((event) => (event as any).kind)).toEqual(["agent_message"])
    engine.stop?.()
  })
})

describe("MCP servers changed during a turn", () => {
  test("the process ends with that turn and the next turn starts a new one that resumes the conversation", async () => {
    const adds = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        streamTool(api, 0, "toolu_add", "Bash", { command: "claude mcp add plane -- npx plane-mcp" })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_add", content: "Added" }] }, parent_tool_use_id: null })
        streamText(api, 1, "added")
        api.push(result())
      },
    })
    const next = fakeClaude({ onUser(api) { streamText(api, 0, "plane is here"); api.push(result()) } })
    const { engine, spawned } = engineWith([adds, next])
    const first = turnInput({ mode: () => "full" })
    expect(await engine.runTurn(first.input)).toEqual({ status: "ok" })
    expect(await engine.runTurn(turnInput({ sessionId: first.input.sessionId, mode: () => "full" }).input)).toEqual({ status: "ok" })
    expect(spawned).toHaveLength(2)
    expect(spawned[1]!.args).toContain("--resume=cc-session-1")
    expect(spawned[0]!.args[spawned[0]!.args.indexOf("--append-system-prompt") + 1]).toContain("restarts Claude Code when the turn ends")
    engine.stop?.()
  })

  test("with a background agent running the restart waits for it; the process ends once none runs, and says why", async () => {
    const adds = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        api.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "Opaque handles" }] })
        streamTool(api, 0, "toolu_add", "Bash", { command: "claude mcp add plane -- npx plane-mcp" })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_add", content: "Added" }] }, parent_tool_use_id: null })
        streamText(api, 1, "added")
        api.push(result())
      },
    })
    const closes: Array<[string, number]> = []
    const reported: unknown[] = []
    const { engine, spawned } = engineWith([adds], { onClose: (_sessionId, reason, background) => void closes.push([reason, background]), onBackground: (_sessionId, tasks) => void reported.push(tasks) })
    expect(await engine.runTurn(turnInput({ mode: () => "full" }).input)).toEqual({ status: "ok" })
    expect(closes).toEqual([])
    adds.api.push({ type: "system", subtype: "background_tasks_changed", tasks: [] })
    await Bun.sleep(5)
    expect(closes).toEqual([["MCP servers changed", 0]])
    expect(spawned).toHaveLength(1)
    engine.stop?.()
  })

  test("a process that ends with background tasks still listed empties their list, so no row outlives the agent", async () => {
    const one = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        api.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "Opaque handles" }] })
        streamText(api, 0, "started")
        api.push(result())
      },
    })
    const closes: Array<[string, number]> = []
    const reported: unknown[] = []
    const { engine } = engineWith([one], { onClose: (_sessionId, reason, background) => void closes.push([reason, background]), onBackground: (_sessionId, tasks) => void reported.push(tasks) })
    await engine.runTurn(turnInput({ mode: () => "full" }).input)
    engine.stop?.()
    expect(closes).toEqual([["engine stopped", 1]])
    expect(reported.at(-1)).toEqual([])
  })

  test("an ordinary turn keeps its process; only MCP commands and MCP config files count", async () => {
    const one = fakeClaude({
      onUser(api) {
        streamTool(api, 0, `toolu_${Math.random()}`, "Bash", { command: "claude mcp list && ls" })
        streamText(api, 1, "ok")
        api.push(result())
      },
    })
    const { engine, spawned } = engineWith([one])
    const first = turnInput({ mode: () => "full" })
    await engine.runTurn(first.input)
    await engine.runTurn(turnInput({ sessionId: first.input.sessionId, mode: () => "full" }).input)
    expect(spawned).toHaveLength(1)
    expect(changesMcpServers("Bash", { command: "claude mcp add-json x '{}'" })).toBe(true)
    expect(changesMcpServers("Bash", { command: "claude mcp remove x" })).toBe(true)
    expect(changesMcpServers("Write", { file_path: "/repo/.mcp.json" })).toBe(true)
    expect(changesMcpServers("Edit", { file_path: "/Users/x/.claude.json" })).toBe(true)
    expect(changesMcpServers("Write", { file_path: "/repo/src/mcp.json.ts" })).toBe(false)
    expect(changesMcpServers("Read", { file_path: "/repo/.mcp.json" })).toBe(false)
    engine.stop?.()
  })
})

describe("claude protocol helpers", () => {
  test("arguments follow the session's model, effort, permission and resume id", () => {
    expect(claudeArgs({ permission: "full", model: "sonnet", effort: "minimal", resume: "abc" })).toEqual([
      "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--include-partial-messages", "--permission-prompt-tool", "stdio",
      "--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions", "--model", "sonnet", "--effort", "low", "--thinking-display", "summarized", "--resume=abc",
    ])
    expect(claudeArgs({ permission: "plan" })).toContain("plan")
    expect(claudeArgs({ permission: "plan", thinkingDisplay: false })).not.toContain("--thinking-display")
    // Fast mode holds for the process it starts, through `--settings`, and is absent when off.
    const fast = claudeArgs({ permission: "ask", model: "opus", fast: true })
    expect(fast.slice(fast.indexOf("--settings"), fast.indexOf("--settings") + 2)).toEqual(["--settings", JSON.stringify({ fastMode: true })])
    expect(claudeArgs({ permission: "ask", model: "opus" })).not.toContain("--settings")
    expect(claudeArgs({ permission: "plan" })).not.toContain("--append-system-prompt")
    const appended = claudeArgs({ permission: "plan", appendSystem: "A mermaid fence is drawn." })
    expect(appended[appended.indexOf("--append-system-prompt") + 1]).toBe("A mermaid fence is drawn.")
  })

  test("the cache TTL variables are opt-in and only for 1h; the child's environment is the daemon's own with them on top", () => {
    expect(claudeCacheEnv({})).toBeUndefined()
    expect(claudeCacheEnv({ promptCacheTtl: "1h" })).toBeUndefined()
    expect(claudeCacheEnv({ claudeCacheTtl: false, promptCacheTtl: "1h" })).toBeUndefined()
    expect(claudeCacheEnv({ claudeCacheTtl: true })).toBeUndefined()
    expect(claudeCacheEnv({ claudeCacheTtl: true, promptCacheTtl: "5m" })).toBeUndefined()
    expect(claudeCacheEnv({ claudeCacheTtl: true, promptCacheTtl: "1h" })).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h" })
    const base = { PATH: "/usr/bin", HOME: "/home/u", CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }
    // Nothing to add: undefined, so the process inherits as it always did.
    expect(claudeProcessEnv(undefined, base)).toBeUndefined()
    expect(claudeProcessEnv({}, base)).toBeUndefined()
    expect(claudeProcessEnv(claudeCacheEnv({ claudeCacheTtl: true, promptCacheTtl: "1h" }), base)).toEqual({ PATH: "/usr/bin", HOME: "/home/u", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h" })
  })

  test.skipIf(process.platform === "win32")("a spawned process really sees the variables next to the inherited ones (`env` stands in for claude)", async () => {
    const printed = async (env: Record<string, string> | undefined) => {
      const transport = spawnClaude({ bin: "/usr/bin/env", args: [], cwd: process.cwd(), ...(env ? { env } : {}) })
      const lines: string[] = []
      for await (const line of transport.lines) lines.push(line)
      await transport.exited
      return lines
    }
    const on = await printed(claudeCacheEnv({ claudeCacheTtl: true, promptCacheTtl: "1h" }))
    expect(on).toContain("CLAUDE_CODE_PROMPT_CACHE_TTL=1h")
    expect(on).toContain("CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h")
    expect(on.some((line) => line.startsWith("PATH="))).toBe(true)
    const off = await printed(claudeCacheEnv({ promptCacheTtl: "1h" }))
    // Off adds nothing: the child has the variable only if this test's own environment does.
    expect(off.some((line) => line.startsWith("CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL="))).toBe(process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL !== undefined)
    expect(off.some((line) => line.startsWith("PATH="))).toBe(true)
  })

  test("quota from a single named window, a warning, and nothing usable", () => {
    expect(claudeQuota({ status: "allowed_warning", rateLimitType: "seven_day_opus", utilization: 0.905, resetsAt: 10 }, 1)).toEqual({
      type: "quota.snapshot",
      provider: "claude",
      windows: [{ id: "seven_day_opus", label: "seven day opus", usedPercent: 90.5, resetsAt: 10_000, windowMinutes: 10080 }],
      status: "warning",
      fetchedAt: 1,
      source: "claude code rate_limit_event",
    })
    expect(claudeQuota({ status: "allowed" }, 1)).toBeUndefined()
    expect(claudeQuota(undefined, 1)).toBeUndefined()
  })

  test("tool titles and outcomes", () => {
    expect(claudeToolTitle("Edit", { file_path: "src/a.ts" })).toBe("edit: src/a.ts")
    expect(claudeToolTitle("Grep", { pattern: "TODO" })).toBe("grep: TODO")
    expect(claudeToolTitle("Skill", { skill: "design" })).toBe("skill: design")
    expect(claudeToolTitle("mcp__linear__list", {})).toBe("mcp__linear__list")
    expect(resultOutcome({ subtype: "success", terminal_reason: "completed" })).toEqual({ status: "ok" })
    expect(resultOutcome({ subtype: "error_max_turns", is_error: true })).toEqual({ status: "error", code: "claude_turn_failed", message: "[CLAUDE]: error_max_turns" })
  })
  test("a signed-out Claude Code's turn names its official login, not Claude Code's own /login that MendCode's prompt lacks", () => {
    const failed = resultOutcome({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" })
    expect(signInHint(failed)).toEqual({ status: "error", code: "claude_turn_failed", message: "[CLAUDE]: Not logged in · Please run /login · sign Claude Code in from a terminal: claude auth login" })
    const other = resultOutcome({ subtype: "error_max_turns", is_error: true })
    expect(signInHint(other)).toBe(other)
  })
})

describe("claude sub-agents", () => {
  const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event, parent_tool_use_id: null })
  // The shape Claude Code 2.1.296 sent for a turn that called the Agent tool (texts shortened).
  const TURN = [
    stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_agent", name: "Agent" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"description":"Read a.txt","subagent_type":"general-purpose","prompt":"Locate a.txt."}' } }),
    stream({ type: "content_block_stop", index: 0 }),
    { type: "system", subtype: "task_started", task_id: "a01", tool_use_id: "toolu_agent", description: "Read a.txt", subagent_type: "general-purpose", is_backgrounded: false, prompt: "Locate a.txt." },
    { type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_child", name: "Read", input: { file_path: "/work/a.txt" } }] }, parent_tool_use_id: "toolu_agent" },
    { type: "system", subtype: "task_progress", task_id: "a01", tool_use_id: "toolu_agent", description: "Reading a.txt", usage: { total_tokens: 27428, tool_uses: 1, duration_ms: 1154 } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_child", content: "hello", is_error: false }] }, parent_tool_use_id: "toolu_agent" },
    { type: "system", subtype: "task_notification", task_id: "a01", tool_use_id: "toolu_agent", status: "completed", summary: "The file says hello.", usage: { total_tokens: 33406, tool_uses: 1, duration_ms: 9163 } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "The file says hello." }] }, parent_tool_use_id: null },
  ]

  test("the call is marked as a sub-agent and what it does are items of its thread: its prompt, its tools, and its report with what it took", () => {
    const events: EngineEvent[] = []
    const mapper = createTurnMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event), model: "claude-haiku-5-5" })
    for (const message of TURN) mapper.accept(message)
    const call = events[0] as Extract<EngineEvent, { type: "item.started" }>
    expect(call).toMatchObject({ kind: "tool_call", meta: { tool: "agent Read a.txt", subagent: true, agent: "general-purpose", background: false } })
    const inThread = events.filter((event) => "meta" in event && event.meta?.agentParent === call.itemId)
    expect(inThread.map((event) => (event.type === "item.started" ? event.kind : `done:${event.type === "item.completed" ? event.text : ""}`))).toEqual([
      "user_message", "done:Locate a.txt.", "tool_call", "done:hello", "agent_message", "done:The file says hello.",
    ])
    expect(inThread.at(-1)).toMatchObject({ status: "ok", meta: { agentEnd: true, toolCalls: 1, tokens: 33406, durationMs: 9163 } })
    expect(events.find((event) => event.type === "item.started" && event.meta?.tool === "read: /work/a.txt")).toBeDefined()
    // The call itself ends with its result, as any tool.
    expect(events.at(-1)).toMatchObject({ type: "item.completed", itemId: call.itemId, status: "ok", text: "The file says hello." })
  })

  test("a sub-agent's thinking and text are items of its thread with its model, and a report that repeats its last text is not drawn twice", () => {
    const events: EngineEvent[] = []
    const mapper = createTurnMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event), model: "claude-haiku-5-5" })
    for (const message of TURN.slice(0, 4)) mapper.accept(message)
    mapper.accept({ type: "assistant", message: { id: "msg_2", model: "claude-sonnet-5-5-20260901", content: [{ type: "thinking", thinking: "Check the file first." }, { type: "text", text: "The file says hello." }] }, parent_tool_use_id: "toolu_agent" })
    for (const message of TURN.slice(7)) mapper.accept(message)
    const call = events[0] as Extract<EngineEvent, { type: "item.started" }>
    const inThread = events.filter((event) => "meta" in event && event.meta?.agentParent === call.itemId)
    expect(inThread.map((event) => (event.type === "item.started" ? event.kind : `done:${event.type === "item.completed" ? event.text : ""}`))).toEqual([
      "user_message", "done:Locate a.txt.", "reasoning", "done:Check the file first.", "agent_message", "done:The file says hello.", "agent_message", "done:",
    ])
    expect(inThread.find((event) => event.type === "item.started" && event.kind === "reasoning")).toMatchObject({ meta: { agentModel: "claude-sonnet-5-5-20260901" } })
  })

  test("a sub-agent's message about a call this turn did not make is dropped, and a tool it left open closes with the turn", () => {
    const events: EngineEvent[] = []
    const mapper = createTurnMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event), model: "claude-haiku-5-5" })
    mapper.accept({ type: "assistant", message: { id: "msg_x", content: [{ type: "tool_use", id: "toolu_x", name: "Read", input: {} }] }, parent_tool_use_id: "toolu_unknown" })
    expect(events).toEqual([])
    for (const message of TURN.slice(0, 5)) mapper.accept(message)
    mapper.finish("interrupted")
    expect(events.filter((event) => event.type === "item.completed" && event.status === "interrupted")).toHaveLength(2)
  })
})

describe("claude engine background tasks", () => {
  test("a background command that ends after the turn: its task list is reported, the daemon gets a notice, and that notice shows the answer Claude Code gave on its own without sending anything", async () => {
    const fake = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        streamTool(api, 0, "toolu_bg", "Bash", { command: "sleep 6; echo done-bg", run_in_background: true })
        api.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bl4urb1ok", task_type: "local_bash", description: "Run sleep 6 then echo done-bg" }] })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: bl4urb1ok." }] } })
        streamText(api, 1, "started")
        api.push(result())
      },
    })
    const notices: string[] = []
    const reported: unknown[] = []
    const h = engineWith([fake], { notify: (_sessionId, text) => void notices.push(text), onBackground: (_sessionId, tasks) => void reported.push(tasks) })
    const first = turnInput()
    expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
    expect(reported).toEqual([[{ id: "bl4urb1ok", description: "Run sleep 6 then echo done-bg", kind: "local_bash" }]])
    // The command ends with no MendCode turn open; Claude Code tells the model and answers on its own.
    fake.api.push({ type: "system", subtype: "task_notification", task_id: "bl4urb1ok", tool_use_id: "toolu_bg", status: "completed", output_file: "/tmp/tasks/bl4urb1ok.output", summary: "Background command \"Run sleep 6 then echo done-bg\" completed (exit code 0)" })
    fake.api.push({ type: "system", subtype: "background_tasks_changed", tasks: [] })
    fake.api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
    streamText(fake.api, 0, "It finished with exit code 0.")
    fake.api.push(result())
    await Bun.sleep(10)
    expect(notices).toEqual(["Background command \"Run sleep 6 then echo done-bg\" completed (exit code 0)\nOutput: /tmp/tasks/bl4urb1ok.output"])
    expect(reported.at(-1)).toEqual([])
    const userWrites = fake.written.filter((message) => message.type === "user").length
    const notice = turnInput({ sessionId: first.input.sessionId, text: notices[0]! })
    expect(await h.engine.runTurn(notice.input)).toEqual({ status: "ok" })
    expect(fake.written.filter((message) => message.type === "user").length).toBe(userWrites)
    expect(notice.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "It finished with exit code 0.")).toBe(true)
    h.engine.stop()
  })

  test("a background agent goes on reporting after its turn: its tools and its end reach the daemon under that turn, and its launch note is not shown", async () => {
    const fake = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        streamTool(api, 0, "toolu_agent", "Agent", { description: "T7 zb-shield", subagent_type: "general-purpose", prompt: "build it", run_in_background: true })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Async agent launched successfully. (This tool result is internal metadata) agentId: a040b" }] } })
        streamText(api, 1, "launched")
        api.push(result())
      },
    })
    const late: Array<{ turnId: string; event: EngineEvent }> = []
    const h = engineWith([fake], { notify: () => {}, onAgentEvent: (_sessionId, turnId, event) => void late.push({ turnId, event }) })
    const first = turnInput()
    expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
    const call = first.events.find((event) => event.type === "item.started" && event.meta?.subagent === true)
    if (call?.type !== "item.started") throw new Error("no agent call")
    expect(first.events.find((event) => event.type === "item.completed" && event.itemId === call.itemId)).toMatchObject({ text: "running in the background" })
    fake.api.push({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/app/Cargo.toml" } }] } })
    fake.api.push({ type: "user", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "[workspace]" }] } })
    fake.api.push({ type: "system", subtype: "task_notification", task_id: "a040b", tool_use_id: "toolu_agent", status: "completed", summary: "T7 done", usage: { tool_uses: 1, total_tokens: 10, duration_ms: 5 } })
    await Bun.sleep(10)
    expect(late.every((entry) => entry.turnId === first.input.turnId)).toBe(true)
    expect(late.map((entry) => [entry.event.type, "meta" in entry.event ? entry.event.meta?.agentParent : undefined])).toEqual([
      ["item.started", call.itemId], ["item.completed", call.itemId], ["item.started", call.itemId], ["item.completed", call.itemId],
    ])
    expect(late[0]!.event).toMatchObject({ meta: { tool: "read: /work/app/Cargo.toml" } })
    expect(late[3]!.event).toMatchObject({ text: "T7 done", meta: { agentEnd: true } })
    h.engine.stop()
  })

  test("an agent Claude Code sends to the background on its own (async_launched, no run_in_background) is a background agent: bg call, reports after its turn", async () => {
    const fake = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        streamTool(api, 0, "toolu_agent", "Agent", { description: "Re-verify table", subagent_type: "general-purpose", prompt: "check it" })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Async agent launched successfully. agentId: ad41" }] }, tool_use_result: { isAsync: true, status: "async_launched", agentId: "ad41" } })
        streamText(api, 1, "launched")
        api.push(result())
      },
    })
    const late: EngineEvent[] = []
    const h = engineWith([fake], { notify: () => {}, onAgentEvent: (_sessionId, _turnId, event) => void late.push(event) })
    const first = turnInput()
    expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
    const call = first.events.find((event) => event.type === "item.started" && event.meta?.subagent === true)
    if (call?.type !== "item.started") throw new Error("no agent call")
    expect(first.events.find((event) => event.type === "item.completed" && event.itemId === call.itemId)).toMatchObject({ text: "running in the background", meta: { subagent: true, background: true, tool: "agent Re-verify table" } })
    fake.api.push({ type: "system", subtype: "task_notification", task_id: "ad41", tool_use_id: "toolu_agent", status: "completed", summary: "table ok", usage: { tool_uses: 3 } })
    await Bun.sleep(10)
    expect(late.at(-1)).toMatchObject({ type: "item.completed", status: "ok", text: "table ok", meta: { agentParent: call.itemId, agentEnd: true } })
    h.engine.stop()
  })

  test("a message Claude Code queues behind its own run (a resumed session's notice of unfinished agents) gets its own answer, not that run's empty result", async () => {
    const fake = fakeClaude({
      onUser(api) {
        const uuid = fake.written.filter((message) => message.type === "user").at(-1)!.uuid
        api.push({ type: "system", subtype: "task_notification", task_id: "ad41", status: "stopped", summary: "2 background agents didn't finish before the previous session ended" })
        api.push({ type: "command_lifecycle", command_uuid: uuid, state: "queued" })
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        api.push(result({ result: "" }))
        api.push({ type: "command_lifecycle", command_uuid: uuid, state: "started" })
        streamText(api, 0, "Relaunching both agents.")
        api.push(result())
        api.push({ type: "command_lifecycle", command_uuid: uuid, state: "completed" })
      },
    })
    const h = engineWith([fake], { notify: () => {} })
    const turn = turnInput({ text: "relaunch them" })
    expect(await h.engine.runTurn(turn.input)).toEqual({ status: "ok" })
    expect(turn.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "Relaunching both agents.")).toBe(true)
    h.engine.stop()
  })

  test("esc ends every background agent as cancelled and stopped by the user, this turn's and an earlier turn's; Claude Code's late notice adds no second end", async () => {
    const controller = new AbortController()
    let turns = 0
    const fake = fakeClaude({
      onUser(api) {
        turns++
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        const id = `toolu_agent${turns}`
        streamTool(api, 0, id, "Agent", { description: `Agent ${turns}`, subagent_type: "general-purpose", prompt: "work", run_in_background: true })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Async agent launched successfully." }] } })
        if (turns === 1) { streamText(api, 1, "launched"); api.push(result()); return }
        streamTool(api, 1, "toolu_sleep", "Bash", { command: "sleep 60" })
        setTimeout(() => controller.abort(), 10)
      },
      onControl(api, request) {
        if (request.subtype === "interrupt") queueMicrotask(() => api.push(result({ terminal_reason: "aborted_tools" })))
        return {}
      },
    })
    const late: EngineEvent[] = []
    const h = engineWith([fake], { notify: () => {}, onAgentEvent: (_sessionId, _turnId, event) => void late.push(event) })
    const first = turnInput()
    expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
    const second = turnInput({ sessionId: first.input.sessionId, signal: controller.signal })
    expect(await h.engine.runTurn(second.input)).toEqual({ status: "ok" })
    const callOf = (events: EngineEvent[]) => { const call = events.find((event) => event.type === "item.started" && event.meta?.subagent === true); return call?.type === "item.started" ? call.itemId : undefined }
    const ended = (events: EngineEvent[], parent: unknown) => events.filter((event) => event.type === "item.completed" && event.meta?.agentEnd === true && event.meta?.agentParent === parent)
    expect(ended(second.events, callOf(second.events))).toEqual([expect.objectContaining({ status: "cancelled", meta: { agentParent: callOf(second.events), agentEnd: true, stoppedBy: "user" } })])
    expect(ended(late, callOf(first.events))).toEqual([expect.objectContaining({ status: "cancelled", meta: expect.objectContaining({ stoppedBy: "user" }) })])
    fake.api.push({ type: "system", subtype: "task_notification", task_id: "a2", tool_use_id: "toolu_agent2", status: "killed", summary: "stopped" })
    await Bun.sleep(10)
    expect(ended([...second.events, ...late], callOf(second.events))).toHaveLength(1)
    h.engine.stop()
  })

  test("send now hands the message to the running turn with Claude Code's send_now interrupt, so background agents keep running; the message's own turn adopts the answer", async () => {
    const fake = fakeClaude({
      onUser(api, content) {
        if (content.some((part: any) => part.text === "New info")) return
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        streamTool(api, 0, "toolu_agent", "Agent", { description: "Auditor", subagent_type: "general-purpose", prompt: "audit", run_in_background: true })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Async agent launched successfully." }] } })
        streamTool(api, 1, "toolu_sleep", "Bash", { command: "sleep 60" })
      },
      onControl(api, request) {
        if (request.subtype === "interrupt" && request.send_now) queueMicrotask(() => {
          api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sleep", content: "Moved to the background." }] } })
          api.push(result())
          api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
          streamText(api, 0, "Got the new info.")
          api.push(result())
        })
        return { still_queued: [] }
      },
    })
    const h = engineWith([fake], { notify: () => {}, onAgentEvent: () => {} })
    const first = turnInput()
    let sendNow: ((message: { text: string; attachments: [] }) => boolean) | undefined
    first.input.onSendNow = (handler) => { sendNow = handler }
    const running = h.engine.runTurn(first.input)
    await Bun.sleep(10)
    expect(sendNow?.({ text: "New info", attachments: [] })).toBe(true)
    expect(await running).toEqual({ status: "ok" })
    const message = fake.written.find((written) => written.type === "user" && written.message.content.some((part: any) => part.text === "New info"))
    expect(message?.uuid).toBeString()
    const interrupts = fake.written.filter((written) => written.request?.subtype === "interrupt")
    expect(interrupts.map((written) => written.request)).toEqual([{ subtype: "interrupt", send_now: true, for_user_message_uuids: [message.uuid] }])
    const writes = fake.written.filter((written) => written.type === "user").length
    const next = turnInput({ sessionId: first.input.sessionId, text: "New info" })
    expect(await h.engine.runTurn(next.input)).toEqual({ status: "ok" })
    expect(fake.written.filter((written) => written.type === "user").length).toBe(writes)
    expect(next.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "Got the new info.")).toBe(true)
    h.engine.stop()
  })

  test("send now that Claude Code takes into the running turn ends that turn where the message starts, so the answer follows the message", async () => {
    const fake = fakeClaude({
      onUser(api, content) {
        if (content.some((part: any) => part.text === "New info")) return
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        streamTool(api, 0, "toolu_curl", "Bash", { command: "curl example.test" })
      },
      onControl(api, request) {
        if (request.subtype === "interrupt" && request.send_now) queueMicrotask(() => {
          api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_curl", content: "ok" }] } })
          api.push({ type: "command_lifecycle", command_uuid: request.for_user_message_uuids[0], state: "started" })
          streamText(api, 0, "Got the new info.")
          api.push(result())
        })
        return { still_queued: [], send_now: "delivering" }
      },
    })
    const h = engineWith([fake], { notify: () => {} })
    const first = turnInput()
    let sendNow: ((message: { text: string; attachments: [] }) => boolean) | undefined
    first.input.onSendNow = (handler) => { sendNow = handler }
    const running = h.engine.runTurn(first.input)
    await Bun.sleep(10)
    expect(sendNow?.({ text: "New info", attachments: [] })).toBe(true)
    expect(await running).toEqual({ status: "ok" })
    await Bun.sleep(10)
    expect(first.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "Got the new info.")).toBe(false)
    const next = turnInput({ sessionId: first.input.sessionId, text: "New info" })
    expect(await h.engine.runTurn(next.input)).toEqual({ status: "ok" })
    expect(next.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "Got the new info.")).toBe(true)
    h.engine.stop()
  })

  test("a message queued while the turn runs goes to Claude Code at the next tool result and is answered inside the same turn", async () => {
    const fake = fakeClaude({
      onUser(api, content) {
        const queued = fake.written.at(-1)
        if (content.some((part: any) => part.text === "Also say BANANA")) {
          queueMicrotask(() => {
            api.push({ type: "command_lifecycle", command_uuid: queued.uuid, state: "started" })
            streamText(api, 0, "DONE BANANA")
            api.push({ type: "command_lifecycle", command_uuid: queued.uuid, state: "completed" })
            api.push(result())
          })
          return
        }
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        api.push({ type: "command_lifecycle", command_uuid: queued.uuid, state: "started" })
        streamTool(api, 0, "toolu_sleep", "Bash", { command: "sleep 8" })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sleep", content: "" }] } })
      },
    })
    const h = engineWith([fake], { notify: () => {} })
    const turn = turnInput()
    let offered = false
    turn.input.takeQueued = async () => (offered ? undefined : ((offered = true), { text: "Also say BANANA", attachments: [] }))
    expect(await h.engine.runTurn(turn.input)).toEqual({ status: "ok" })
    const steered = fake.written.filter((message) => message.type === "user").at(-1)
    expect(steered.message.content).toEqual([{ type: "text", text: "Also say BANANA" }])
    expect(fake.written.some((message) => message.request?.subtype === "interrupt")).toBe(false)
    expect(turn.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "DONE BANANA")).toBe(true)
    h.engine.stop()
  })

  test("a turn whose result comes while a steered message still waits ends with the answer to that message, not before", async () => {
    let steeredUuid = ""
    const fake = fakeClaude({
      onUser(api, content) {
        if (content.some((part: any) => part.text === "One more thing")) {
          steeredUuid = fake.written.at(-1).uuid
          api.push({ type: "command_lifecycle", command_uuid: steeredUuid, state: "queued" })
          api.push(result())
          queueMicrotask(() => {
            api.push({ type: "command_lifecycle", command_uuid: steeredUuid, state: "started" })
            streamText(api, 0, "Here is the one more thing.")
            api.push(result())
          })
          return
        }
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        api.push({ type: "command_lifecycle", command_uuid: fake.written.at(-1).uuid, state: "started" })
        streamTool(api, 0, "toolu_ls", "Bash", { command: "ls" })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ls", content: "a" }] } })
      },
    })
    const h = engineWith([fake], { notify: () => {} })
    const turn = turnInput()
    let offered = false
    turn.input.takeQueued = async () => (offered ? undefined : ((offered = true), { text: "One more thing", attachments: [] }))
    expect(await h.engine.runTurn(turn.input)).toEqual({ status: "ok" })
    expect(turn.events.some((event) => event.type === "item.completed" && "text" in event && event.text === "Here is the one more thing.")).toBe(true)
    h.engine.stop()
  })

  test("an agent call whose long prompt comes before its description is named by the description once its input is whole", async () => {
    const fake = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        streamTool(api, 0, "toolu_agent", "Agent", { prompt: "x".repeat(2_000), description: "G1Lit lighting profile", subagent_type: "general-purpose", run_in_background: true })
        api.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Async agent launched successfully." }] } })
        api.push(result())
      },
    })
    const h = engineWith([fake], { notify: () => {}, onAgentEvent: () => {} })
    const turn = turnInput()
    expect(await h.engine.runTurn(turn.input)).toEqual({ status: "ok" })
    const started = turn.events.find((event) => event.type === "item.started" && event.kind === "tool_call")
    expect(started).toMatchObject({ meta: { subagent: true } })
    expect(started && "meta" in started ? started.meta?.tool : undefined).not.toBe("agent G1Lit lighting profile")
    expect(turn.events.find((event) => event.type === "item.completed" && "itemId" in event && started && "itemId" in started && event.itemId === started.itemId)).toMatchObject({ meta: { tool: "agent G1Lit lighting profile", background: true } })
    h.engine.stop()
  })

  test("/env credentials reach the Claude Code process and its prompt names them; new ones restart an idle process", async () => {
    const answer = (api: any) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
      streamText(api, 0, "ok")
      api.push(result())
    }
    let environment: { values: Record<string, string>; note: string } | undefined = { values: { INSTABOX_KEY: "ib-secret" }, note: "MendCode credentials (set by the user in /env) are in your shell's environment: INSTABOX_KEY." }
    const h = engineWith([fakeClaude({ onUser: answer }), fakeClaude({ onUser: answer })], { environment: () => environment })
    const first = turnInput()
    expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
    expect((h.spawned[0] as any).env).toMatchObject({ INSTABOX_KEY: "ib-secret" })
    expect(h.spawned[0]!.args.join(" ")).toContain("environment: INSTABOX_KEY.")
    expect(h.spawned[0]!.args.join(" ")).not.toContain("ib-secret")
    expect(await h.engine.runTurn(turnInput({ sessionId: first.input.sessionId }).input)).toEqual({ status: "ok" })
    expect(h.spawned).toHaveLength(1)
    environment = { values: { INSTABOX_KEY: "ib-rotated" }, note: environment.note }
    expect(await h.engine.runTurn(turnInput({ sessionId: first.input.sessionId }).input)).toEqual({ status: "ok" })
    expect(h.spawned).toHaveLength(2)
    expect((h.spawned[1] as any).env).toMatchObject({ INSTABOX_KEY: "ib-rotated" })
    h.engine.stop()
  })

  test("an undo cuts Claude Code's own conversation before the undone message, named by the uuid its turn gave it", async () => {
    const answer = (api: any) => {
      api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
      streamText(api, 0, "ok")
      api.push(result())
    }
    const rewinds: any[] = []
    const fake = fakeClaude({ onUser: answer, onControl: (_api, request) => request.subtype === "rewind_conversation" ? (rewinds.push(request), { rewound: true }) : undefined })
    const h = engineWith([fake, fakeClaude({ onUser: answer, onControl: (_api, request) => request.subtype === "rewind_conversation" ? (rewinds.push(request), { rewound: true }) : undefined })])
    const first = turnInput()
    expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
    const sent = fake.written.find((written) => written.type === "user")
    expect(sent?.uuid).toBe(messageUuid(first.input.turnId))
    expect(await h.engine.rewind!({ sessionId: first.input.sessionId, turnId: first.input.turnId })).toBe(true)
    expect(rewinds).toEqual([{ subtype: "rewind_conversation", target_message_uuid: messageUuid(first.input.turnId), interrupt_if_running: true }])
    h.engine.stop()
    // With no process running, the cut waits for the session's next one and goes before its message.
    const next = fakeClaude({ onUser: answer, onControl: (_api, request) => request.subtype === "rewind_conversation" ? (rewinds.push(request), { rewound: true }) : undefined })
    const later = engineWith([next])
    later.bound.set(first.input.sessionId, "cc-session-1")
    expect(await later.engine.rewind!({ sessionId: first.input.sessionId, turnId: first.input.turnId })).toBe(true)
    expect(await later.engine.runTurn(turnInput({ sessionId: first.input.sessionId }).input)).toEqual({ status: "ok" })
    expect(rewinds).toHaveLength(2)
    const order = next.written.map((written) => written.request?.subtype ?? written.type)
    expect(order.indexOf("rewind_conversation")).toBeLessThan(order.indexOf("user"))
    later.engine.stop()
  })

  test("/compact is sent to Claude Code as its own command; its compact_boundary packs the session and the summary becomes the card", async () => {
    const sent: string[] = []
    const fake = fakeClaude({
      onUser(api, content) {
        const text = content.map((part: any) => part.text ?? "").join("")
        sent.push(text)
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        if (text.startsWith("/compact")) {
          api.push({ type: "system", subtype: "status", status: "compacting" })
          api.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 286_097, post_tokens: 9_800 } })
          api.push({ type: "user", isSynthetic: true, message: { role: "user", content: "This session is being continued from a previous conversation. Summary: the blasting filter." }, parent_tool_use_id: null })
          api.push({ type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" }, parent_tool_use_id: null })
          api.push(result({ result: "" }))
        } else {
          streamText(api, 0, "ok")
          api.push(result())
        }
      },
    })
    const h = engineWith([fake])
    const first = turnInput({ mode: () => "full" })
    expect(await h.engine.runTurn(first.input)).toEqual({ status: "ok" })
    const events: EngineEvent[] = []
    const outcome = await h.engine.compact({ sessionId: first.input.sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), instructions: "keep the filter rules" })
    expect(outcome).toEqual({ status: "ok", compacted: true })
    expect(sent.at(-1)).toBe("/compact keep the filter rules")
    expect(h.spawned).toHaveLength(1)
    const card = events.find((event) => event.type === "item.started" && event.kind === "compaction")
    expect(card).toMatchObject({ meta: { compactionMethod: "Claude Code" } })
    expect(events.find((event) => event.type === "item.completed" && event.itemId === (card as any).itemId)).toMatchObject({ text: expect.stringContaining("the blasting filter") })
    expect(events.some((event) => event.type === "item.started" && event.kind === "user_message")).toBe(false)
    h.engine.stop()
  })

  test("/compact before Claude Code has a conversation, or one it does not report, says why it did nothing", async () => {
    const h = engineWith([fakeClaude({ onUser: (api) => { api.push({ type: "system", subtype: "init", session_id: "cc-session-1" }); api.push(result({ result: "" })) } })])
    const compact = (sessionId: SessionId) => h.engine.compact({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {} })
    const fresh = ids("session") as SessionId
    expect(await compact(fresh)).toEqual({ status: "ok", note: expect.stringContaining("no conversation") })
    expect(h.spawned).toHaveLength(0)
    h.bound.set(fresh, "cc-session-1")
    expect(await compact(fresh)).toEqual({ status: "ok", note: expect.stringContaining("reported no compaction") })
    expect(await h.engine.compact({ sessionId: fresh, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, idle: true })).toEqual({ status: "ok" })
    h.engine.stop()
  })

  test("a background task is stopped through Claude Code's stop_task request", async () => {
    const fake = fakeClaude({
      onUser(api) {
        api.push({ type: "system", subtype: "init", session_id: "cc-session-1" })
        api.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "T3 engine spike" }] })
        streamText(api, 0, "started")
        api.push(result())
      },
    })
    let stop: ((taskId: string) => Promise<void>) | undefined
    const h = engineWith([fake], { notify: () => {}, onBackground: (_sessionId, _tasks, stopTask) => { stop = stopTask } })
    expect(await h.engine.runTurn(turnInput().input)).toEqual({ status: "ok" })
    await stop!("a1")
    expect(fake.written.filter((message) => message.type === "control_request").map((message) => message.request).at(-1)).toEqual({ subtype: "stop_task", task_id: "a1" })
    h.engine.stop()
  })

  test("a message the user sends before the notice runs is sent as usual; the kept records are dropped, not shown as its answer", async () => {
    const fake = fakeClaude({ onUser(api) { api.push({ type: "system", subtype: "init", session_id: "cc-session-1" }); streamText(api, 0, "answer"); api.push(result()) } })
    const h = engineWith([fake], { notify: () => {} })
    const first = turnInput()
    await h.engine.runTurn(first.input)
    fake.api.push({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed", summary: "done" })
    streamText(fake.api, 0, "unseen")
    fake.api.push(result())
    await Bun.sleep(10)
    const next = turnInput({ sessionId: first.input.sessionId, text: "something else" })
    expect(await h.engine.runTurn(next.input)).toEqual({ status: "ok" })
    expect(fake.written.filter((message) => message.type === "user").at(-1).message.content.at(-1).text).toBe("something else")
    h.engine.stop()
  })
})
