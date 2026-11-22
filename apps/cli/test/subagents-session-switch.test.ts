import { expect, test } from "bun:test"
import type { SessionId } from "@mendcode/protocol"
import { createSubagents } from "../src/ui/app/subagents"
import type { AppContext } from "../src/ui/app/context"

/** A click or key on an engine's agent whose call is above the history shown: the older pages load, and the reader may leave meanwhile. */

const first = "ses_01M7C3T9P0JHRKM1" as SessionId
const second = "ses_01M7C3T9P0JHRKM2" as SessionId

function scene() {
  let frames = 0
  const state: Record<string, unknown> = {
    sessionId: first,
    agentShells: [{ id: "bg_1", status: "running", sessionId: first, kind: "agent", command: "Review the diff" }, { id: "bg_2", status: "running", sessionId: second, kind: "command", command: "sleep 9" }],
    transcript: { agentThreads: () => [], agentTranscript: () => undefined, blocks: () => [] },
    paging: { more: true, firstSeq: 5 },
  }
  const ctx = { state, input: { send: async () => ({ ok: true, result: { session: { sessionId: first } } }) }, fail: () => {}, requestFrame: () => { frames++ }, view: { get: () => ({ offset: 0, follow: true, unseen: 0 }) }, editor: { text: "", replaceAll: () => {} } } as unknown as AppContext
  // Loading the older page takes long enough for the reader to switch session first.
  const loadEarlier = async () => { state.sessionId = second }
  const subagents = createSubagents(ctx, { switchSession: async () => {}, loadPage: async () => {}, loadWorkflows: async () => {}, loadEarlier })
  return { state, subagents, frames: () => frames }
}

test("a click on a strip row stops when the session changed while older history loaded", async () => {
  const { state, subagents, frames } = scene()
  await subagents.open("bg_1")
  expect(state.psCard).toBeUndefined()
  expect(state.notice).toBeUndefined()
  expect(frames()).toBe(0)
})

test("the keyboard path to an engine's working agent stops when the session changed while older history loaded", async () => {
  const { state, subagents } = scene()
  state.agentShells = [{ id: "bg_1", status: "running", sessionId: first, kind: "agent", command: "Review the diff" }]
  // The session the reader lands in has a thread of its own, which the stale key press must not open.
  state.transcript = { agentThreads: () => [{ itemId: "itm_01M7C3T9P0JHRKM3", running: true }], agentTranscript: () => ({}), blocks: () => [] }
  expect(await subagents.navigate("session.child.first")).toBe(false)
  expect(state.sessionId).toBe(second)
  expect(state.agentView).toBeUndefined()
})

test("a click on a command row of the session it was made in still opens its card", async () => {
  const { state, subagents } = scene()
  state.sessionId = second
  await subagents.open("bg_2")
  expect(state.psCard).toEqual({ selected: 0 })
})
