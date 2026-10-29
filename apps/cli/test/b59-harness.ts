import type { SessionEvent } from "@mendcode/protocol"
import type { TuiProfile } from "../src/view/tui-profile"
import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"

export const B59_MEMORY = "## Compacted memory\n\nImplemented the session actor follow-up and the terminal panel.\n\n- Keep additive wire commands\n- Preserve cancellation and queue order\n- Run local tests before delivery\n\n" + Array.from({ length: 30 }, (_, i) => `Memory ${i + 1}: checked local fixture ${i + 1}.`).join("\n\n")
type CompactionState = Extract<SessionEvent, { type: "compaction.updated" }>["state"]

export function b59Harness(width = 100, height = 30) {
  const events: SessionEvent[] = []
  let followUp = ""
  let turnId = ids("turn")
  let itemId = ids("item")
  let state: CompactionState = "writing"
  let chat!: ReturnType<typeof conversation>
  const dataDir = tempDir()
  const h = appHarness({ width, height, dataDir, directory: "/work/mendcode", reply: (command) => {
    if (command.type === "session.compaction.set") {
      if (command.turnId !== turnId || state !== "writing") return { ok: false, error: { code: "target_mismatch", message: "[ACTOR]: compaction is no longer active" } }
      followUp = command.text
      chat.emit({ type: "compaction.updated", turnId, reason: "manual", state, followUp })
    }
    if (command.type === "models.list") return { ok: true, result: { engine: "native", selectable: true, models: [], defaults: { model: "local-test" }, effective: { model: "local-test" }, roles: {} } }
    return { ok: true }
  } })
  chat = conversation(h.sessionId, (event) => { events.push(event); h.app.onEvent(event) })
  h.app.applySettings({ onboarded: true })
  /** Starts a compaction; `startedAt` back-dates its events and `meta` is what the compaction item reports (method, tail). */
  const begin = (options: { startedAt?: number; meta?: Record<string, string | number | boolean> } = {}) => {
    turnId = ids("turn")
    itemId = ids("item")
    followUp = ""
    state = "writing"
    const at = options.startedAt === undefined ? {} : { at: options.startedAt }
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue"), ...at })
    chat.emit({ type: "compaction.updated", turnId, reason: "manual", state, followUp, ...at })
    chat.emit({ type: "foreground.state", state: "compacting", turnId, ...at })
    chat.emit({ type: "item.started", turnId, itemId, kind: "compaction", ...(options.meta ? { meta: options.meta } : {}), ...at })
  }
  const finish = (next: CompactionState = "packed") => {
    state = next
    chat.emit({ type: "item.completed", itemId, status: next === "packed" ? "ok" : next === "cancelled" ? "cancelled" : "error", ...(next === "packed" ? { text: B59_MEMORY } : {}) })
    chat.emit({ type: "compaction.updated", turnId, reason: "manual", state, followUp, ...(next === "packed" && followUp.trim() ? { followUpQueueId: ids("queue") } : {}) })
    chat.emit({ type: next === "cancelled" ? "turn.cancelled" : "turn.completed", turnId, ...(next === "cancelled" ? { by: "user" } : {}) })
    chat.emit({ type: "foreground.state", state: "idle" })
  }
  const profile = (patch: Partial<Pick<TuiProfile, "compactionStyle" | "compactionPanel" | "compactionProgress" | "compactionScratchpad" | "presentation">>) => h.app.onGlobal({ type: "tui.changed", gseq: 0, at: NOW, profile: patch })
  return { ...h, dataDir, events, chat, begin, finish, profile }
}
