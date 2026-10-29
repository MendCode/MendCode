import { afterAll, expect, test } from "bun:test"
import { b87Harness } from "./b87-harness"
import { cleanTemps, ids } from "./session-ui-harness"
import { createTranscript } from "../src/view/transcript"
import { glyphs } from "../src/ui/theme"
import type { SessionEvent } from "@mendcode/protocol"

afterAll(cleanTemps)

test("live revisions replace a cached answer, clear attachment chips and remove a deleted message immediately", () => {
  const h = b87Harness()
  h.revise(h.answerId, { status: "ok", text: "Corrected response" })
  expect(h.text().join("\n")).toContain("Corrected response")
  expect(h.text().join("\n")).not.toContain("Obsolete response")
  h.revise(h.userId, { status: "ok", text: "Revised question", attachments: [] })
  expect(h.text().join("\n")).toContain("Revised question")
  expect(h.text().join("\n")).not.toContain("notes.txt")
  h.revise(h.answerId, { status: "ok", text: "" }, true, 2)
  expect(h.text().join("\n")).not.toContain("Corrected response")
})

test("history reader refreshes an already-loaded message and removes its obsolete body", async () => {
  const h = b87Harness()
  await h.type("/history\r\r")
  h.revise(h.answerId, { status: "ok", text: "Revised history response" })
  expect(h.text().join("\n")).toContain("Revised history response")
  expect(h.text().join("\n")).not.toContain("Obsolete response")
  h.revise(h.answerId, { status: "ok", text: "" }, true, 2)
  expect(h.text().join("\n")).not.toContain("Revised history response")
})

test("paging an earlier item after receiving its tombstone never resurrects it", () => {
  const transcript = createTranscript({ glyphs: glyphs({}) })
  const sessionId = ids("session")
  const turnId = ids("turn")
  const itemId = ids("item")
  const event = (seq: number, fields: Record<string, unknown>) => ({ sessionId, seq, at: seq, ...fields }) as SessionEvent
  transcript.apply(event(10, { type: "message.revised", turnId, itemId, revision: 1, deleted: true, snapshot: { status: "ok", text: "" } }))
  transcript.prepend([
    event(1, { type: "item.started", turnId, itemId, kind: "agent_message" }),
    event(2, { type: "item.completed", itemId, status: "ok", text: "deleted old response" }),
  ])
  expect(transcript.blocks().some((block) => block.itemId === itemId)).toBe(false)
})
