import type { SessionNotesInput, SessionRecallReadInput, SessionRecallSearchInput } from "@mendcode/protocol"
import type { Tool } from "../../../packages/tools/src/tool"
import { SESSION_RECALL_TOOLS } from "../../../packages/engine-native/src/session-recall-tools"
import { recallFixture } from "../../../packages/daemon/test/session-recall-fixture"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, conversation, ids, NOW, tempDir, type HarnessOptions } from "./session-ui-harness"

export async function b28Harness(name: "session_search" | "session_read" | "session_notes", input: SessionRecallReadInput | SessionRecallSearchInput | SessionNotesInput, options: HarnessOptions & { disabled?: boolean; child?: boolean; empty?: boolean; long?: boolean } = {}) {
  const history = recallFixture()
  history.enabled(!options.disabled)
  const childId = history.session(history.sessionId)
  const recalled = history.message(options.long ? "Decision: preserve the explicit recall boundary.\n".repeat(100) : "Keep recall scoped to the current session and its linked children.", { sessionId: options.child ? childId : history.sessionId })
  if (!options.disabled) history.port.notes({ action: "write", version: 0, text: options.long ? "Verify tests before changing the release state.\n".repeat(120) : "Decision: preserve the project boundary.\nNext: verify the daemon and client." })
  const dataDir = options.dataDir ?? tempDir("b28-cli-")
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, toolOutput: "expanded", pet: "off" })
  const harness = appHarness({ ...options, sessionId: history.sessionId, dataDir, directory: history.dir, env: {}, reply: (command) => {
    const override = options.reply?.(command)
    if (override) return override
    return command.type === "session.list" ? { ok: true, result: { sessions: [{ sessionId: history.sessionId, directory: history.dir, title: "Recall", createdAt: NOW - 3600_000, updatedAt: NOW, state: "idle" }] } } : { ok: true }
  } })
  const query = name === "session_read" && !options.empty ? { ...input, message_id: recalled.itemId, ...(options.child ? { session_id: childId } : {}) } : input
  const context = { cwd: history.dir, signal: new AbortController().signal, recall: history.port }
  const tool: Tool = SESSION_RECALL_TOOLS.find((tool) => tool.name === name)!
  const result = await tool.execute(query, context)
  const chat = conversation(harness.sessionId, (event) => harness.app.onEvent(event))
  harness.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: harness.sessionId, directory: history.dir, title: "Recall", state: "idle", updatedAt: NOW })
  const turnId = ids("turn")
  const itemId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  const userId = ids("item")
  chat.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userId, status: "ok", text: name === "session_notes" ? "Review the working notes" : "Recall the earlier decision" })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: name } })
  chat.emit({ type: "item.completed", itemId, status: result.isError ? "error" : "ok", text: result.output, toolInput: JSON.stringify(query) })
  chat.emit({ type: "turn.completed", turnId })
  harness.app.render()
  return { ...harness, result, history }
}
