import type { Command, ItemId, MessageRevision, SessionEvent, SessionId } from "@mendcode/protocol"
import { historyMark, type Store } from "@mendcode/store"
import type { ModelMessage } from "@mendcode/engine-native"
import type { Outcome } from "./session-history"
import { statSync } from "node:fs"

type Mutation = Extract<Command, { type: "session.message.delete" | "session.part.delete" | "session.part.update" }>
type Snapshot = MessageRevision["snapshot"]
const fail = (code: "forbidden" | "busy" | "target_mismatch" | "unknown_session" | "invalid_command", message: string) => ({ ok: false as const, code, message: `[DAEMON]: ${message}` })

export function createMessageMutations(deps: {
  store: Store
  busy(sessionId: SessionId): boolean
  capture(sessionId: SessionId, text: string): { text: string } | { ok: false; code: import("@mendcode/protocol").ErrorCode; message: string }
  publish(event: SessionEvent): void
}) {
  const { store } = deps

  /** Resolve exact native history only; compaction, mentions, clipped output and ambiguous matches are never guessed. */
  function historyPlan(sessionId: SessionId, itemId: ItemId, before: Snapshot, after: Snapshot, deleted: boolean) {
    if (store.engineBindings.list(sessionId).length || Object.keys(store.turns.messageCounts(sessionId)).some((engine) => engine !== "native")) throw new Error("external engine history cannot be revised")
    const messages = store.engineMessages.load(sessionId, "native") as ModelMessage[]
    if (!messages.length) return undefined
    const target = store.messages.read(sessionId, itemId)!
    const turns = store.turns.list(sessionId)
    const turnIndex = turns.findIndex((turn) => turn.turnId === target.start.turnId)
    const turn = turns[turnIndex]
    const start = turn ? historyMark(turn, "native") : undefined
    const following = turns[turnIndex + 1]
    const end = following ? historyMark(following, "native") : messages.length
    if (typeof start !== "number" || typeof end !== "number" || turn?.compacted || turn?.shell) throw new Error("history was compacted, shell-composed or has no exact turn boundary")
    if (target.start.kind === "reasoning") throw new Error("opaque model reasoning cannot be revised")
    const candidates: number[] = []
    for (let i = start; i < end; i++) {
      const message = messages[i]!
      if (target.start.kind === "user_message" && message.role === "user" && message.content === before.text) candidates.push(i)
      if (target.start.kind === "agent_message" && message.role === "assistant" && message.content === before.text) candidates.push(i)
      if (target.start.kind === "tool_call" && message.role === "tool" && message.output === before.text) candidates.push(i)
    }
    if (candidates.length !== 1) throw new Error("message has no unique exact native history match")
    const index = candidates[0]!
    const message = messages[index]!
    const removed: number[] = []
    if (message.role === "user") {
      if (deleted) removed.push(index)
      else messages[index] = { ...message, content: after.text ?? "", attachments: after.attachments ?? [] }
    } else if (message.role === "assistant") {
      if (deleted && !message.toolCalls.length) removed.push(index)
      else {
        const updated = { ...message, content: deleted ? "" : after.text ?? "" }
        delete updated.reasoning
        messages[index] = updated
      }
      if (JSON.stringify(before.attachments ?? []) !== JSON.stringify(after.attachments ?? [])) throw new Error("assistant media history cannot be revised")
    } else {
      if (deleted && before.attachments?.length) throw new Error("tool media history cannot be revised")
      if (JSON.stringify(before.attachments ?? []) !== JSON.stringify(after.attachments ?? [])) throw new Error("tool media history cannot be revised")
      if (deleted) {
        removed.push(index)
        for (let i = start; i < index; i++) if (messages[i]!.role === "assistant") {
          const assistant = messages[i] as Extract<ModelMessage, { role: "assistant" }>
          if (assistant.toolCalls.some((call) => call.callId === message.callId)) {
            const updated = { ...assistant, toolCalls: assistant.toolCalls.filter((call) => call.callId !== message.callId) }
            delete updated.reasoning
            messages[i] = updated
          }
        }
      } else messages[index] = { ...message, output: after.text ?? "" }
    }
    return { messages: messages.filter((_, i) => !removed.includes(i)), removed }
  }

  function apply(command: Mutation): Outcome<{ messageId: ItemId; revision: number; deleted: boolean; part?: import("@mendcode/protocol").MessagePart }> {
    const { sessionId, messageId } = command
    if (!store.hasSession(sessionId)) return fail("unknown_session", "unknown session")
    if (!store.settings.get().allowMessageEdits) return fail("forbidden", "message edits are disabled; enable allowMessageEdits explicitly")
    if (deps.busy(sessionId) || store.queueOf(sessionId).length) return fail("busy", "session is running or queued")
    let target: ReturnType<Store["messages"]["read"]>
    try { target = store.messages.read(sessionId, messageId) } catch { return fail("target_mismatch", "message exceeds revision limits") }
    if (!target || target.deleted || store.turns.get(sessionId, target.start.turnId)?.reverted) return fail("target_mismatch", "message unavailable")
    if (target.revision !== command.expectedRevision) return fail("target_mismatch", `message revision is ${target.revision}; reload before editing`)
    const snapshot: Snapshot = { ...target.snapshot }
    const deleted = command.type === "session.message.delete"
    let part: import("@mendcode/protocol").MessagePart | undefined
    if (!deleted && "partId" in command) {
      if (command.type === "session.part.update" && (command.part.id !== command.partId || command.part.type === "file" && command.part.id !== `file:${command.part.attachment.sha256}`)) return fail("target_mismatch", "part identity mismatch")
      if (command.partId === "body") {
        if (command.type === "session.part.update" && command.part.type !== "text") return fail("invalid_command", "body requires text")
        const text = command.type === "session.part.update" && command.part.type === "text" ? command.part.text : ""
        const captured = deps.capture(sessionId, text)
        if ("ok" in captured) return captured
        snapshot.text = captured.text
        delete snapshot.render
        delete snapshot.blob
        // Original authority remains immutable, independent of revised display/model text.
        part = { id: "body", type: "text", text: captured.text }
      } else {
        const sha = command.partId.slice(5)
        if (!snapshot.attachments?.some((ref) => ref.sha256 === sha)) return fail("target_mismatch", "attachment part unavailable")
        if (command.type === "session.part.delete") snapshot.attachments = snapshot.attachments.filter((ref) => ref.sha256 !== sha)
        else if (command.part.type === "file") {
          const old = snapshot.attachments.find((ref) => ref.sha256 === sha)!
          let bytes: number
          try { bytes = store.readBlob(sha).length } catch { return fail("target_mismatch", "attachment blob unavailable") }
          if (command.part.attachment.bytes !== bytes || command.part.attachment.mime !== old.mime) return fail("target_mismatch", "attachment bytes and MIME are immutable")
          const name = command.part.attachment.name ? deps.capture(sessionId, command.part.attachment.name) : undefined
          if (name && "ok" in name) return name
          const attachment = { ...command.part.attachment, ...(name ? { name: name.text } : {}) }
          snapshot.attachments = snapshot.attachments.map((old) => old.sha256 === sha ? attachment : old)
          part = { id: command.partId, type: "file", attachment }
        }
      }
    }
    let history: ReturnType<typeof historyPlan>
    try { history = historyPlan(sessionId, messageId, target.snapshot, snapshot, deleted) } catch (error) { return fail("target_mismatch", (error as Error).message) }
    if (deleted) { snapshot.text = ""; snapshot.attachments = []; delete snapshot.render; delete snapshot.blob; delete snapshot.toolInput; delete snapshot.authorityText; delete snapshot.meta }
    if (JSON.stringify(snapshot).length > 78 * 1024) return fail("invalid_command", "revision snapshot exceeds event limit")
    const event = store.reviseMessage({ type: "message.revised", sessionId, itemId: messageId, turnId: target.start.turnId, revision: target.revision + 1, deleted, snapshot, byClientId: command.clientId }, history)
    deps.publish(event)
    return { ok: true, result: { messageId, revision: event.revision, deleted, ...(part ? { part } : {}) } }
  }
  return { apply }
}
