import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type ItemKind, type SessionId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createSessionRecall } from "../src/session-recall"

export function recallFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-recall-"))
  const store = openStore({ dir })
  const ids = createIdFactory()
  const session = (parentId?: SessionId, directory = dir) => {
    const id = ids("session")
    store.createSession({ id, directory, title: "Recall", ...(parentId ? { parentId } : {}) })
    return id
  }
  const sessionId = session()
  const recall = createSessionRecall(store)
  const enabled = (value = true) => store.settings.set({ experimental: { session_recall: value } })
  const message = (text: string, options: { sessionId?: SessionId; kind?: ItemKind; status?: "ok" | "error" | "cancelled"; deltas?: string[]; final?: boolean; notice?: boolean } = {}) => {
    const target = options.sessionId ?? sessionId
    const turnId = ids("turn")
    const itemId = ids("item")
    const kind = options.kind ?? "agent_message"
    store.sessionSink.append({ type: "turn.started", sessionId: target, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId: target, turnId, itemId, kind, meta: { ...(kind === "tool_call" ? { tool: "read" } : {}), ...(options.notice ? { notice: true } : {}) } })
    for (const delta of options.deltas ?? [text]) store.sessionSink.append({ type: "item.delta", sessionId: target, itemId, text: delta })
    store.sessionSink.append({ type: "item.completed", sessionId: target, itemId, status: options.status ?? "ok", ...(options.final === false ? {} : { text }) })
    store.sessionSink.append({ type: "turn.completed", sessionId: target, turnId })
    return { itemId, turnId }
  }
  return { dir, store, ids, sessionId, session, message, enabled, recall, port: recall.port(sessionId) }
}
