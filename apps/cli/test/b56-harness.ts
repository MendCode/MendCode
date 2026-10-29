import type { CommandReply } from "@mendcode/client"
import type { HistoryReport, HistoryTurn, SessionId } from "@mendcode/protocol"
import { appHarness, conversation, ids, NOW, tempDir, type HarnessOptions } from "./session-ui-harness"

export function b56Harness(options: HarnessOptions = {}) {
  const sessionId = options.sessionId ?? ids("session")
  const forkId = ids("session")
  const directory = options.directory ?? tempDir("b56-project-")
  const turns: HistoryTurn[] = ["Inspect the export boundary", "Include the tool details"].map((prompt, i) => ({
    turnId: ids("turn"), at: NOW - (2 - i) * 60_000, seq: i * 10 + 1, preview: prompt, outcome: "completed",
    items: [
      { itemId: ids("item"), kind: "user_message", text: prompt, status: "ok" },
      { itemId: ids("item"), kind: "agent_message", text: i === 0 ? "Read the complete session through the daemon.\n\nCopy preserves **Markdown**." : "Export reasoning, tool input/output, timestamps and assistant metadata on request.\n\nThe terminal hands control to your editor and resumes after it exits.", status: "ok" },
    ],
  }))
  const exported = "# Transcript\n\n## User\nInspect the export boundary\n\n## Assistant\nRead the complete session through the daemon.\n"
  const h = appHarness({ ...options, directory, sessionId, dataDir: options.dataDir ?? tempDir("b56-data-"), env: options.env ?? {}, reply: (command) => {
    const override = options.reply?.(command)
    if (override) return override
    let result: Record<string, unknown> | undefined
    if (command.type === "session.history") result = { turns: command.turnId ? turns.filter((turn) => turn.turnId === command.turnId) : turns } satisfies HistoryReport
    else if (command.type === "session.timeline") result = { entries: turns.map((turn) => ({ turnId: turn.turnId, itemId: turn.items[0]!.itemId, at: turn.at, preview: turn.preview, reverted: false })) }
    else if (command.type === "session.export") result = { format: command.format, text: exported, turns: 2, truncated: false }
    else if (command.type === "session.undo") result = { turnIds: [turns[1]!.turnId], itemId: command.atItemId ?? turns[1]!.items[0]!.itemId, files: { restored: [], removed: [], skipped: [] }, history: { messages: 2, tracked: true }, shellUntracked: false, notes: [] }
    else if (command.type === "session.fork") result = { sessionId: forkId, copied: 4 }
    else if (command.type === "session.list") result = { sessions: [{ sessionId, title: "Transcript", directory, createdAt: NOW - 3600_000, updatedAt: NOW, state: "idle" }, { sessionId: forkId, title: "fork: Transcript", directory, createdAt: NOW, updatedAt: NOW, state: "idle" }] }
    return { ok: true, ...(result ? { result } : {}) } as CommandReply
  } })
  const chat = conversation(sessionId, (event) => h.app.onEvent(event))
  h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId, directory, title: "Transcript", state: "idle", updatedAt: NOW })
  for (const turn of turns) {
    chat.emit({ type: "turn.started", turnId: turn.turnId, queueId: ids("queue") })
    for (const item of turn.items) {
      chat.emit({ type: "item.started", turnId: turn.turnId, itemId: item.itemId, kind: item.kind })
      chat.emit({ type: "item.completed", itemId: item.itemId, status: "ok", text: item.text })
    }
    chat.emit({ type: "turn.completed", turnId: turn.turnId })
  }
  return { ...h, turns, exported, directory, forkId, sessionId: sessionId as SessionId }
}
