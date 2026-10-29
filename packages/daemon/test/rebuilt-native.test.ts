import { afterEach, expect, test } from "bun:test"
import type { SessionTranscriptItem, SessionTranscriptTurn } from "@mendcode/protocol"
import { rebuildHistory } from "../src/rebuilt-history"
import { boot, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const running: NativeHarness[] = []
afterEach(async () => { for (const h of running.splice(0).reverse()) await h.cleanup() })

let n = 0
const item = (kind: SessionTranscriptItem["kind"], text: string, extra: Partial<SessionTranscriptItem> = {}): SessionTranscriptItem => ({ itemId: `itm_${n++}`, kind, text, ...extra })
const turn = (...items: SessionTranscriptItem[]): SessionTranscriptTurn => ({ turnId: `trn_${n++}`, items, outcome: "completed" }) as SessionTranscriptTurn

test("the native engine continues from a rebuilt history and its own /compact packs it", async () => {
  const h = await boot({ steps: [stop("continuing"), stop("summary of the Claude Code work"), stop("after the summary")] })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.setCompactionConfig({ auto: false, tail_turns: 1 })
  const rebuilt = rebuildHistory({
    turns: [
      turn(item("user_message", "fix the build"), item("tool_call", "3 pass\n0 fail", { tool: "Bash", input: '{"command":"bun test"}' }), item("agent_message", "Fixed.")),
      turn(item("user_message", "now the docs"), item("agent_message", "Docs updated.")),
    ],
    skipped: 0, budgetTokens: 10_000, fromStart: true, from: "Claude Code", to: "faux", sessionId,
  })!
  h.store.engineMessages.save(sessionId, "native", rebuilt.messages)
  await say(h, sessionId, "what did we do?")
  const sent = h.requests[0]!.messages.map((message) => ("content" in message ? message.content : "tool"))
  expect(sent[0]).toContain("ran on Claude Code until now")
  expect(sent[1]).toContain("[ran Bash")
  expect(sent.slice(-1)).toEqual(["what did we do?"])
  await h.client.send({ type: "session.compact", sessionId })
  await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state !== "writing"))
  expect(h.events.find((event) => event.type === "compaction.updated" && event.state !== "writing")).toMatchObject({ state: "packed" })
  const packed = h.store.engineMessages.load(sessionId, "native") as Array<{ role: string; content: string }>
  expect(packed[0]!.content).toContain("summary of the Claude Code work")
  expect(JSON.stringify(packed)).not.toContain("[ran Bash")
}, 15_000)
