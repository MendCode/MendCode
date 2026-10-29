import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"

export function compactionB23Harness(width = 100, height = 30, method = "incremental", fallbackReason?: string) {
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/mendcode" })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  const turnId = ids("turn"), itemId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue"), at: NOW - 1000 })
  chat.emit({ type: "foreground.state", state: "compacting", turnId, at: NOW - 1000 })
  chat.emit({ type: "compaction.updated", turnId, reason: "manual", state: "writing", followUp: "" })
  if (fallbackReason) {
    const failed = ids("item")
    chat.emit({ type: "item.started", turnId, itemId: failed, kind: "compaction", meta: { compactionMethod: "native", tailTurns: 2, tailTokens: 248 } })
    chat.emit({ type: "item.completed", itemId: failed, status: "error", text: "Native compaction failed" })
  }
  chat.emit({ type: "item.started", turnId, itemId, kind: "compaction", meta: { compactionMethod: method, tailTurns: 2, tailTokens: 248, ...(fallbackReason ? { fallbackReason } : {}) } })
  const finish = () => {
    chat.emit({ type: "item.completed", itemId, status: "ok", text: method === "native" ? "Native context checkpoint installed" : "## Current task\n\nKeep the latest constraint and continue local verification." })
    chat.emit({ type: "compaction.updated", turnId, reason: "manual", state: "packed", followUp: "" })
    chat.emit({ type: "turn.completed", turnId })
    chat.emit({ type: "foreground.state", state: "idle" })
  }
  return { ...h, chat, finish }
}
