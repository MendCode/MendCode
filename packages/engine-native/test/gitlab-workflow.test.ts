import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool } from "@mendcode/tools"
import { createIdFactory } from "@mendcode/protocol"
import type { EngineEvent, EngineRequest, TurnInput } from "@mendcode/kernel"
import { createApiProvider, createNativeEngine, memoryHistory, type ModelEvent, type ModelRequest } from "../src"
import { collectGitLab, gitlabRequest, gitlabResolved, GITLAB_NAMESPACE, GITLAB_TOKEN } from "./gitlab-fixtures"
import { workflowCheckpoint, workflowFake } from "./gitlab-workflow-fixtures"

const model = "duo-workflow-sonnet-4-6"
const request = (over: Partial<ModelRequest> = {}) => gitlabRequest({ model, ...over })
const adapter = (fake: ReturnType<typeof workflowFake>, over: Parameters<typeof gitlabResolved>[0] = {}) => createApiProvider({ provider: gitlabResolved(over), fetch: fake.fetch, gitlabSocket: fake.socket })
const resume = (events: ModelEvent[], first: ModelRequest, output = "read result", isError = false): ModelRequest => {
  const call = events.find((event) => event.type === "tool_call")
  const state = events.find((event) => event.type === "reasoning_state")
  if (call?.type !== "tool_call" || state?.type !== "reasoning_state") throw new Error("No workflow tool handoff")
  return { ...first, messages: [...first.messages, { role: "assistant", content: "", toolCalls: [call.call], reasoning: state.state }, { role: "tool", ...call.call, output, isError }] }
}

describe("B10.20 Duo Workflow transport", () => {
  test("native DWS routes, scoped auth, incremental checkpoints and session reuse", async () => {
    const fake = workflowFake((value, peer) => {
      if (value.startRequest?.goal === "Again") {
        peer.receive(workflowCheckpoint("Hello"))
        peer.receive(workflowCheckpoint("Next", "COMPLETED", "agent-2"))
      } else if (value.startRequest) {
        peer.receive(workflowCheckpoint("Hel"))
        peer.receive(workflowCheckpoint("Hello"))
        peer.receive(workflowCheckpoint("Hello", "COMPLETED"))
      }
    })
    const provider = adapter(fake, { gitlab: { rootNamespaceId: GITLAB_NAMESPACE, projectId: "42" } })
    const first = request({ conversationId: "session-1" })
    expect(await collectGitLab(provider.stream(first))).toEqual([{ type: "text", delta: "Hel" }, { type: "text", delta: "lo" }, { type: "finish", reason: "stop" }])
    expect(fake.calls.map((call) => call.url.split("/").at(-1))).toEqual(["direct_access", "workflows"])
    expect(new Headers(fake.calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${GITLAB_TOKEN}`)
    expect(fake.calls.every((call) => call.init.redirect === "error")).toBe(true)
    expect(JSON.parse(fake.calls[1]!.init.body as string)).toMatchObject({ namespace_id: "123", project_id: "42", agent_privileges: [6], allow_agent_to_request_user: false })
    const connection = fake.peers[0]!
    const url = new URL(connection.url)
    expect(url.origin).toBe("ws://127.0.0.1:1234")
    expect(url.pathname).toBe("/api/v4/ai/duo_workflows/ws")
    expect(url.searchParams.get("user_selected_model_identifier")).toBe("claude_sonnet_4_6")
    expect(connection.headers.authorization).toBe(`Bearer ${GITLAB_TOKEN}`)
    expect(connection.url).not.toContain(GITLAB_TOKEN)
    expect(connection.peer.sent[0]!.startRequest).toMatchObject({ workflowID: "1", mcpTools: [{ name: "read" }], additional_context: [{ category: "system_prompt", content: "Be brief" }], clientCapabilities: [] })
    expect(connection.peer.sent.some((value) => value.stopWorkflow)).toBe(false)
    expect(connection.peer.readyState).toBe(3)
    expect(await collectGitLab(provider.stream(request({ conversationId: "session-1", messages: [{ role: "user", content: "Again" }] })))).toEqual([{ type: "text", delta: "Next" }, { type: "finish", reason: "stop" }])
    expect(fake.calls.filter((call) => call.url.endsWith("/workflows"))).toHaveLength(1)
    expect(fake.peers[1]!.peer.sent[0]!.startRequest.workflowID).toBe("1")
  })

  test("MCP and built-in actions hand off to v2 and return success/error without a second workflow", async () => {
    const fake = workflowFake((value, peer) => {
      if (value.startRequest) peer.receive({ requestID: "read-1", runMCPTool: { name: "read", args: '{"path":"a.ts"}' } })
      if (value.actionResponse?.requestID === "read-1") peer.receive({ requestID: "read-2", runReadFile: { filepath: "b.ts" } })
      if (value.actionResponse?.requestID === "read-2") peer.receive(workflowCheckpoint("Done", "COMPLETED"))
    })
    const provider = adapter(fake)
    const first = request()
    const events = await collectGitLab(provider.stream(first))
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
    expect(fake.peers[0]!.peer.readyState).toBe(1)
    const next = resume(events, first)
    const second = await collectGitLab(provider.stream(next))
    expect(second).toContainEqual({ type: "tool_call", call: { callId: "read-2", name: "read", args: { path: "b.ts" } } })
    const last = await collectGitLab(provider.stream(resume(second, next, "denied", true)))
    expect(last).toContainEqual({ type: "text", delta: "Done" })
    expect(fake.peers).toHaveLength(1)
    expect(fake.peers[0]!.peer.sent.filter((value) => value.actionResponse)).toEqual([
      { actionResponse: { requestID: "read-1", plainTextResponse: { response: "read result", error: null } } },
      { actionResponse: { requestID: "read-2", plainTextResponse: { response: "denied", error: "Local tool failed or was denied" } } },
    ])
  })

  test("concurrent conversations, cancellation and token rotation cannot share pending tools", async () => {
    const fake = workflowFake((value, peer) => { if (value.startRequest) peer.receive({ requestID: "read-1", runReadFile: { filepath: value.startRequest.goal } }); if (value.actionResponse) peer.receive(workflowCheckpoint("Done", "COMPLETED")) })
    let key = GITLAB_TOKEN
    const provider = adapter(fake, { apiKey: () => key })
    const stop = new AbortController()
    const first = request({ turnSignal: stop.signal })
    const second = request({ messages: [{ role: "user", content: "b.ts" }] })
    const [a, b] = await Promise.all([collectGitLab(provider.stream(first)), collectGitLab(provider.stream(second))])
    stop.abort()
    expect(fake.peers[0]!.peer.readyState).toBe(3)
    expect(fake.peers[0]!.peer.sent.at(-1)).toMatchObject({ stopWorkflow: { reason: "USER_ACTION_TRIGGERED_STOP" } })
    expect(await collectGitLab(provider.stream(resume(a, first)))).toEqual([])
    key = "rotated-token"
    await expect(collectGitLab(provider.stream(resume(b, second)))).rejects.toThrow("continuation expired")
    expect(fake.peers[1]!.peer.readyState).toBe(3)
  })

  test("unadvertised remote tools get an error, never a local execution or HTTP request", async () => {
    const fake = workflowFake((value, peer) => {
      if (value.startRequest) peer.receive({ requestID: "secret-1", runHTTPRequest: { path: "/api/v4/projects", method: "DELETE" } })
      if (value.actionResponse) peer.receive(workflowCheckpoint("No access", "COMPLETED"))
    })
    const events = await collectGitLab(adapter(fake).stream(request()))
    expect(events.some((event) => event.type === "tool_call")).toBe(false)
    expect(fake.peers[0]!.peer.sent[1]).toMatchObject({ actionResponse: { plainTextResponse: { error: "Tool not advertised by this client" } } })
    expect(fake.calls).toHaveLength(2)
  })

  test("malformed, oversized, failed and disconnected streams fail without remote secrets", async () => {
    for (const send of [
      (peer: ReturnType<typeof workflowFake>["peers"][number]["peer"]) => peer.raw("bad JSON"),
      (peer: ReturnType<typeof workflowFake>["peers"][number]["peer"]) => peer.raw("x".repeat(4_000_001)),
      (peer: ReturnType<typeof workflowFake>["peers"][number]["peer"]) => peer.receive({ newCheckpoint: { status: "FAILED", content: GITLAB_TOKEN } }),
      (peer: ReturnType<typeof workflowFake>["peers"][number]["peer"]) => peer.drop(),
    ]) {
      const fake = workflowFake((value, peer) => { if (value.startRequest) send(peer) })
      const error = await collectGitLab(adapter(fake).stream(request())).then(() => undefined, (error: Error) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).not.toContain(GITLAB_TOKEN)
      expect(fake.peers[0]!.peer.readyState).toBe(3)
    }
    const fake = workflowFake()
    const provider = createApiProvider({ provider: gitlabResolved(), fetch: async () => { throw new Error(GITLAB_TOKEN) }, gitlabSocket: fake.socket })
    await expect(collectGitLab(provider.stream(request()))).rejects.toThrow("transport failed")
    expect(fake.peers).toHaveLength(0)
  })

  test("a silent stream times out and releases its socket", async () => {
    const fake = workflowFake(() => {})
    const provider = createApiProvider({ provider: gitlabResolved(), fetch: fake.fetch, gitlabSocket: fake.socket, idleTimeoutMs: 5 })
    await expect(collectGitLab(provider.stream(request()))).rejects.toThrow("timed out")
    expect(fake.peers[0]!.peer.readyState).toBe(3)
  })

  test("bulk reads return one DWS response and built-in commands keep argument boundaries", async () => {
    const fake = workflowFake((value, peer) => {
      if (value.startRequest) peer.receive({ requestID: "bulk-1", runReadFiles: { filepaths: ["a.ts", "b.ts"] } })
      if (value.actionResponse) peer.receive(workflowCheckpoint("Done", "COMPLETED"))
    })
    const provider = adapter(fake)
    const first = request()
    const events = await collectGitLab(provider.stream(first))
    const calls = events.flatMap((event) => event.type === "tool_call" ? [event.call] : [])
    const state = events.find((event) => event.type === "reasoning_state")
    if (state?.type !== "reasoning_state") throw new Error("No handoff")
    expect(calls.map((call) => call.callId)).toEqual(["bulk-1:0", "bulk-1:1"])
    const messages: ModelRequest["messages"] = [...first.messages, { role: "assistant", content: "", toolCalls: calls, reasoning: state.state }, ...calls.map((call) => ({ role: "tool" as const, callId: call.callId, name: call.name, output: String((call.args as { path: string }).path), isError: false }))]
    await collectGitLab(provider.stream({ ...first, messages }))
    expect(fake.peers[0]!.peer.sent[1]).toEqual({ actionResponse: { requestID: "bulk-1", plainTextResponse: { response: "a.ts\nb.ts", error: null } } })
    for (const [action, name, args] of [
      [{ runCommand: { program: "printf", arguments: ["$(touch x)", "a'b"] } }, "shell", { command: "'printf' '$(touch x)' 'a'\"'\"'b'" }],
      [{ runGitCommand: { command: "status", arguments: ["--short"] } }, "shell", { command: "'git' 'status' '--short'" }],
      [{ findFiles: { name_pattern: "src/**/*.ts" } }, "glob", { pattern: "src/**/*.ts" }],
      [{ grep: { pattern: "TODO", search_directory: "src", case_insensitive: true } }, "grep", { pattern: "TODO", path: "src", ignoreCase: true }],
    ] as const) {
      const stop = new AbortController()
      const peer = workflowFake((value, socket) => { if (value.startRequest) socket.receive({ requestID: "builtin-1", ...action }) })
      const events = await collectGitLab(adapter(peer).stream(request({ turnSignal: stop.signal, tools: [{ name, description: name, parameters: {} }] })))
      expect(events).toContainEqual({ type: "tool_call", call: { callId: "builtin-1", name, args } })
      stop.abort()
    }
  })

  test("native engine approval/denial stays authoritative and closes tool waits at turn end", async () => {
    for (const approve of [false, true]) {
      let writes = 0
      const fake = workflowFake((value, peer) => { if (value.startRequest) peer.receive({ requestID: "write-1", runWriteFile: { filepath: "a.ts", contents: "hello" } }); if (value.actionResponse) peer.receive(workflowCheckpoint("Written", "COMPLETED")) })
      const tool = defineTool({ name: "write", description: "Write", permission: "write", args: z.object({ path: z.string(), content: z.string() }), execute: async () => { writes++; return { output: "written", truncated: false, title: "Write", isError: false } } })
      const engine = createNativeEngine({ provider: adapter(fake, { models: [{ id: model }] }), tools: [tool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "Be brief", compactionPrompt: "Summarize" })
      const ids = createIdFactory()
      const asked: EngineRequest[] = [], events: EngineEvent[] = []
      const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "Write a.ts", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => { events.push(event) }, ask: async (question) => { asked.push(question); return approve ? { kind: "approve", scope: "once" } : { kind: "deny", reason: "No" } }, permissionMode: () => "ask", setPermissionMode() {} }
      await engine.runTurn(input)
      expect(asked).toMatchObject([{ kind: "approval", tool: "write" }])
      expect(writes).toBe(approve ? 1 : 0)
      expect(fake.peers[0]!.peer.readyState).toBe(3)
      expect(fake.peers[0]!.peer.sent.some((value) => value.actionResponse)).toBe(approve)
      expect(events.some((event) => event.type === "item.completed" && event.text === "Written")).toBe(approve)
    }
  })
})
