import { asideTranscript } from "./aside"
import type { SessionEvent } from "@mendcode/protocol"

export const RECAP_TIMEOUT_MS = 90_000
export const RECAP_MAX_CHARS = 4_000

export const RECAP_SYSTEM = [
  "You write a recap of a coding session for the developer who is coming back to it, from the read-only transcript below.",
  "You cannot run tools or read files. Use only what the transcript shows; do not invent results.",
  "Format: one line with the goal, then a short bullet list of what was done (files and commands named), then one line with what is unfinished or the likely next step.",
  "Plain text, no headings, at most 12 lines. Answer in the language the developer used.",
].join(" ")

/** The recap request for the most recent part of the session as plain text; undefined when the session holds no conversation yet. */
export function recapPrompt(events: SessionEvent[]) {
  const transcript = asideTranscript(events)
  return transcript ? `<session>\n${transcript}\n</session>\n\nWrite the recap.` : undefined
}

/** The model's text, trimmed and bounded. */
export function recapText(text: string) {
  return text.trim().slice(0, RECAP_MAX_CHARS)
}
