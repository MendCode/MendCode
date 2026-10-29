import type { ModelMessage } from "./provider"
import type { RecalledTurn } from "@mendcode/tools"
import { SUMMARY_PREFIX } from "./compaction-policy"

/** `auto_recall`: how many packed-away turns one request brings back, and the characters they share. */
export const AUTO_RECALL_TURNS = 3
export const AUTO_RECALL_CHARS = 9_000
/** The call id of a request's recall; the history and the transcript mark it as the engine's, not the model's. */
export const AUTO_RECALL_PREFIX = "auto_recall_"

/** True once a compaction packed earlier turns of this history into a summary. */
export const packedAway = (messages: readonly ModelMessage[]) => messages.some((message) => message.role === "user" && (message.compaction !== undefined || message.content.startsWith(SUMMARY_PREFIX)))

/** The turns whose request is not still in the history (the compaction's kept tail), so nothing is brought back twice. */
export function notInHistory(turns: readonly RecalledTurn[], messages: readonly ModelMessage[]) {
  const present = messages.flatMap((message) => message.role === "user" || message.role === "assistant" ? [message.content] : []).join("\n")
  return turns.filter((turn) => !turn.user || !present.includes(turn.user.slice(0, 200)))
}

function age(at: number, now: number) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** The tool output the model reads: the turns verbatim, oldest first, each with its place in the session and its age. */
export function recalledText(turns: readonly RecalledTurn[], now: number) {
  const ordered = [...turns].sort((a, b) => a.turn - b.turn)
  return [
    "Earlier turns of this session that a compaction packed away and that match the new request, verbatim but bounded. They describe the past: the files or facts they mention may have changed since, so check before relying on them.",
    ...ordered.map((turn) => [`## Turn ${turn.turn} · ${age(turn.at, now)}`, turn.user ? `User: ${turn.user}` : "", turn.assistant ? `Assistant: ${turn.assistant}` : ""].filter(Boolean).join("\n")),
  ].join("\n\n")
}
