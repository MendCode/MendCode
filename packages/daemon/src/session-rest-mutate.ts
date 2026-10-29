import type { Command, ItemId, RestMessage, SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import type { Outcome } from "./session-history"

type Mutate = Extract<Command, { type: "session.rest.mutate" }>
type Native = Extract<Command, { type: "session.message.delete" | "session.part.delete" | "session.part.update" }>
type Part = RestMessage["parts"][number]
const fail = (code: "invalid_command" | "target_mismatch" | "unknown_session", message: string): Outcome<Record<string, unknown>> => ({ ok: false, code, message: `[DAEMON]: ${message}` })

/**
 * REST message/part edits (v1 `DELETE message`, `DELETE part`, `PATCH part`) on top of the native message revisions:
 * a REST message is one or more native items and a REST part is one item (or one attachment of a user item), so the REST ids
 * are resolved to those items and their current revisions here. The revisions keep their own safeguards (the setting,
 * an idle session, exact native history, no compacted or external history), and a refusal changes nothing.
 */
export function createRestMutations(input: {
  store: Store
  messages(sessionId: SessionId): RestMessage[]
  apply(command: Native): Outcome<Record<string, unknown>>
}) {
  const { store } = input
  const itemOf = (part: Part) => (part.type === "file" ? part.id.split(":")[0]! : part.id) as ItemId
  const revision = (sessionId: SessionId, itemId: ItemId) => {
    try {
      const item = store.messages.read(sessionId, itemId)
      return item && !item.deleted ? item : undefined
    } catch { return undefined }
  }

  function mutate(command: Mutate): Outcome<Record<string, unknown>> {
    const { sessionId, messageId } = command
    if (!store.hasSession(sessionId)) return fail("unknown_session", "unknown session")
    const message = input.messages(sessionId).find((entry) => entry.info.id === messageId)
    if (!message) return fail("target_mismatch", "unknown message")
    const base = { id: command.id, clientId: command.clientId, sessionId }
    const native = (type: Native["type"], itemId: ItemId, extra: Record<string, unknown> = {}) => {
      const item = revision(sessionId, itemId)
      if (!item) return fail("target_mismatch", "message unavailable")
      return input.apply({ ...base, type, messageId: itemId, expectedRevision: item.revision, ...extra } as Native)
    }

    if (command.operation === "delete-message") {
      if (message.partsMore) return fail("invalid_command", "message is too large to delete as one unit; delete its parts")
      const items = message.parts.filter((part) => part.type === "text" || part.type === "tool").map(itemOf)
      if (!items.length) return fail("invalid_command", "message has no revisable content")
      if (items.some((itemId) => !revision(sessionId, itemId))) return fail("target_mismatch", "message unavailable")
      for (const itemId of items) {
        const result = native("session.message.delete", itemId)
        if (!result.ok) return result
      }
      return { ok: true, result: { value: true } }
    }

    const part = message.parts.find((entry) => entry.id === command.partId)
    if (!part) return fail("target_mismatch", "unknown part")
    if (part.type === "reasoning" || part.type === "compaction" || part.type === "step-start" || part.type === "step-finish") return fail("invalid_command", "model reasoning, step and compaction parts cannot be revised")

    if (command.operation === "delete-part") {
      if (part.type === "file") {
        const sha = (part.blob as { sha256?: string } | undefined)?.sha256
        if (!sha) return fail("invalid_command", "attachment part unavailable")
        const result = native("session.part.delete", itemOf(part), { partId: `file:${sha}` })
        return result.ok ? { ok: true, result: { value: true } } : result
      }
      const itemId = itemOf(part)
      // A user message keeps its attachments when only its text goes: the text is cleared instead of the item removed.
      const attachments = message.parts.some((entry) => entry.type === "file" && itemOf(entry) === itemId)
      const result = attachments ? native("session.part.delete", itemId, { partId: "body" }) : native("session.message.delete", itemId)
      return result.ok ? { ok: true, result: { value: true } } : result
    }

    if (part.type !== "text") return fail("invalid_command", "only text parts can be updated")
    const text = command.text ?? ""
    const result = native("session.part.update", itemOf(part), { partId: "body", part: { id: "body", type: "text", text } })
    if (!result.ok) return result
    const applied = (result.result.part as { text?: string } | undefined)?.text ?? text
    return { ok: true, result: { value: { id: part.id, sessionID: sessionId, messageID: message.info.id, type: "text", text: applied } } }
  }
  return { mutate }
}
