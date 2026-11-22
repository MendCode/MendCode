import { expect, test } from "bun:test"
import type { SessionEvent } from "@mendcode/protocol"
import { createTranscript } from "../src/view/transcript"
import { stepPhase } from "../src/view/working-row"

/** The activity status of an open sub-agent thread says what that agent does now, from its own items, not its last call's title. */

const sessionId = "ses_01M7C3T9P0JHRKM1"
const turnId = "trn_01M7C3T9P0JHRKM1"
const call = "itm_01M7C3T9P0JHRKM0"

function scene() {
  const transcript = createTranscript()
  let seq = 0
  const ev = (patch: Record<string, unknown>, at: number) => transcript.apply({ sessionId, seq: ++seq, at, ...patch } as SessionEvent)
  ev({ type: "turn.started", turnId, queueId: "que_01M7C3T9P0JHRKM1" }, 1_000)
  ev({ type: "item.started", turnId, itemId: call, kind: "tool_call", meta: { tool: "agent Approvals", subagent: true, agent: "general-purpose" } }, 1_000)
  const child = (n: number) => `itm_01M7C3T9P0JHRKN${n}`
  const thread = () => transcript.agentThreads()[0]!
  return { ev, child, thread }
}

test("a sub-agent running a command reads as what the command does, and its steps count", () => {
  const { ev, child, thread } = scene()
  ev({ type: "item.started", turnId, itemId: child(1), kind: "reasoning", meta: { agentParent: call } }, 2_000)
  ev({ type: "item.completed", itemId: child(1), status: "ok", text: "plan" }, 2_100)
  ev({ type: "item.started", turnId, itemId: child(2), kind: "tool_call", meta: { agentParent: call, tool: "shell: cd /repo/lane && node --test core/checks/decide.test.mjs" } }, 3_000)
  expect(stepPhase(thread().current, thread().steps)).toBe("Running tests...")
  expect(thread().steps).toBe(1)
  expect(thread().stepAt).toBe(3_000)
})

test("after its last call a sub-agent is thinking, then writing, never its finished command again", () => {
  const { ev, child, thread } = scene()
  ev({ type: "item.started", turnId, itemId: child(1), kind: "tool_call", meta: { agentParent: call, tool: "shell: cd /repo && node build.mjs claude && git commit -m x" } }, 2_000)
  ev({ type: "item.completed", itemId: child(1), status: "ok", text: "ok" }, 2_500)
  expect(thread().current).toBeUndefined()
  expect(stepPhase(thread().current, thread().steps)).toBe("Thinking...")
  expect(thread().stepAt).toBe(2_500)
  ev({ type: "item.started", turnId, itemId: child(2), kind: "agent_message", meta: { agentParent: call } }, 9_000)
  expect(stepPhase(thread().current, thread().steps)).toBe("Writing...")
  // The end of the agent is not a step of its own.
  ev({ type: "item.completed", itemId: child(2), status: "ok", text: "done", meta: { agentParent: call, agentEnd: true, toolCalls: 1, tokens: 10, durationMs: 8_000 } }, 9_100)
  expect(thread().steps).toBe(1)
  expect(thread().status).toBe("running")
})

test("a sub-agent's call in the chat shows what it was asked bright, like a command, with the verb as its label", () => {
  const transcript = createTranscript()
  let seq = 0
  const ev = (patch: Record<string, unknown>) => transcript.apply({ sessionId, seq: ++seq, at: 1_000, ...patch } as SessionEvent)
  ev({ type: "turn.started", turnId, queueId: "que_01M7C3T9P0JHRKM1" })
  ev({ type: "item.started", turnId, itemId: call, kind: "tool_call", meta: { tool: "agent Fable audits the repo", subagent: true, agent: "general-purpose", background: true } })
  ev({ type: "item.completed", itemId: call, status: "ok", text: "running in the background", meta: { subagent: true, background: true, tool: "agent Fable audits the repo" } })
  const row = transcript.viewport(100, 40).find((line) => line.text.includes("Fable audits the repo"))!
  const asked = row.spans.find((span) => span.text.includes("Fable audits the repo"))!
  expect(asked.fg).toBe("text")
  expect(asked.bold).toBe(true)
  expect(row.spans.find((span) => span.text === "agent")?.fg).not.toBe("text")
})
