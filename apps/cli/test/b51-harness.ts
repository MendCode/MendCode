import type { Settings } from "@mendcode/protocol"
import { appHarness, conversation, ids, NOW } from "./session-ui-harness"

export function b51Harness(width = 100, height = 30, mode: NonNullable<Settings["queue"]>["mode"] = "after-response", held = false) {
  let settings: Settings = { onboarded: true, reducedMotion: true, queue: { mode } }
  const h = appHarness({ width, height, directory: "/work/queue", reply: (command) => {
    if (command.type === "settings.set") {
      settings = { ...settings, ...command.patch } as Settings
      return { ok: true, result: { settings } }
    }
    if (command.type === "settings.get") return { ok: true, result: { settings } }
  } })
  h.app.applySettings(settings)
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Review the queue policy", "I will check the tool iteration and preserve queued work.")
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  const itemId = ids("item")
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "read" } })
  const first = ids("queue"), second = ids("queue"), last = ids("queue")
  chat.emit({ type: "queue.added", queueId: last, text: "git status", attachments: [], shell: true })
  chat.emit({ type: "queue.changed", queue: [
    { queueId: first, preview: "Also check cancellation before sending the next prompt", attachments: 0 },
    { queueId: second, preview: "Keep the changes local and run the focused tests", attachments: 0 },
    { queueId: last, preview: "git status", attachments: 0 },
  ] })
  chat.emit({ type: "foreground.state", state: held ? "queued" : mode === "immediate" ? "cancelling" : "tool", ...(held ? {} : { turnId }) })
  h.app.onGlobal({ type: "settings.changed", gseq: 1, at: NOW, settings })
  return { ...h, chat, first, last, turnId }
}
