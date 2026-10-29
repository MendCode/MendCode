import type { HistoryTurn, MessageRevision } from "@mendcode/protocol"
import { appHarness, conversation, ids, NOW, tempDir, type HarnessOptions } from "./session-ui-harness"

export function b87Harness(options: HarnessOptions = {}) {
  const sessionId = ids("session")
  const turnId = ids("turn")
  const userId = ids("item")
  const answerId = ids("item")
  const fileId = ids("item")
  const turns: HistoryTurn[] = [{
    turnId, seq: 1, at: NOW, preview: "Review the storage contract", outcome: "completed",
    items: [
      { itemId: userId, kind: "user_message", text: "Review the storage contract", status: "ok", attachments: ["notes.txt"] },
      { itemId: answerId, kind: "agent_message", text: "Obsolete response", status: "ok" },
    ],
  }]
  const h = appHarness({ ...options, sessionId, env: {}, dataDir: tempDir("b87-ui-data-"), directory: tempDir("b87-project-"), reply: (command) => {
    if (command.type === "session.history") return { ok: true, result: { turns: structuredClone(turns) } }
    if (command.type === "session.timeline") return { ok: true, result: { entries: turns.map((turn) => ({ turnId: turn.turnId, itemId: userId, at: turn.at, preview: turn.preview, reverted: false })) } }
    return options.reply?.(command) ?? { ok: true }
  } })
  const chat = conversation(sessionId, h.app.onEvent)
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userId, status: "ok", text: "Review the storage contract", attachments: [{ sha256: "a".repeat(64), bytes: 5, mime: "text/plain", name: "notes.txt" }] })
  chat.emit({ type: "item.started", turnId, itemId: answerId, kind: "agent_message" })
  chat.emit({ type: "item.completed", itemId: answerId, status: "ok", text: "Obsolete response" })
  chat.emit({ type: "turn.completed", turnId })
  const revise = (itemId: typeof userId, snapshot: MessageRevision["snapshot"], deleted = false, revision = 1) => {
    chat.emit({ type: "message.revised", itemId, turnId, revision, deleted, snapshot })
    const turn = turns[0]!
    const item = turn.items.find((item) => item.itemId === itemId)
    if (item) {
      if (item.kind === "user_message") turn.preview = deleted ? "" : snapshot.text ?? ""
      if (deleted) turn.items = turn.items.filter((item) => item.itemId !== itemId)
      else { item.text = snapshot.text ?? ""; delete item.attachments }
    }
    h.app.render()
  }
  return { ...h, turns, userId, answerId, fileId, revise }
}
