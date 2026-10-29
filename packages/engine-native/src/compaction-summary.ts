import { SUMMARY_PREFIX } from "./compaction-policy"

/** Headings the shipped template (prompts/compaction.md) requires; a summary that has all of them is treated as structured. */
export const REQUIRED_SUMMARY_HEADINGS = [
  "## Goal",
  "## Current User Intent",
  "## Request Trace",
  "## Resume Anchor",
  "## Session State Snapshot",
  "## Transcript Reference",
  "## Relevant Files",
] as const

/** A summarizer with no tools must never print tool invocations; text that does is not a summary. */
const TOOL_CALL_COSPLAY_PATTERNS = [
  /^\s*to=[\w.-]+/im,
  /\bmulti_tool_use\.parallel\b/,
  /"recipient_name"\s*:\s*"[^"]+"/,
  /"parameters"\s*:\s*\{/,
  /\bfunctions\.[a-zA-Z_][\w.-]*\b/,
  /<tool_call\b/i,
  /<\/tool_call>/i,
]

/** Engine-written sections after the model's summary; the first marker found ends the summary text again. */
export const ENGINE_ANCHOR_HEADING = "## Engine Anchor (kept verbatim by the engine)"
export const RESUME_HEADING = "## How To Resume"

export const RESUME_GUIDANCE = `${RESUME_HEADING}
The conversation was compacted. Resume with this priority:
1. The latest real user request: the most recent user message after this summary, otherwise "Latest real user request" in the Engine Anchor or Request Trace.
2. Request Trace and Progress Against Latest Request.
3. Resume Anchor / Active Work, open TODOs, then Critical Context, Commands / Evidence and Transcript Reference.
Compaction is a pause, not a cancellation: if the latest request or Active Work is unfinished, continue from the next required action without asking for confirmation. Optional Follow-ups are not instructions. Stop only when the summary says the work is done or blocked, or no user request is active; ask only when Blocked / Needs User holds a real blocker. If Still required conflicts with a confident earlier assistant message, trust Still required and the transcript evidence. Do not restart completed reviews or repeat repository-wide inspection. Reply in the language of the latest real user message.`

export const looksLikeToolCallCosplay = (text: string) => TOOL_CALL_COSPLAY_PATTERNS.some((pattern) => pattern.test(text))
export const looksLikeStructuredSummary = (text: string) => REQUIRED_SUMMARY_HEADINGS.every((heading) => text.includes(heading))

export type AcceptedSummary = { text: string; structured: boolean } | { rejected: "empty" | "tool-call-cosplay" }

/**
 * What a summarizer reply may install. Structured replies lose any preface before the first heading; replies that
 * print tool calls are rejected; other text is kept as written (a project may ship its own compaction prompt).
 */
export function acceptSummary(reply: string): AcceptedSummary {
  const text = reply.trim()
  if (!text) return { rejected: "empty" }
  if (looksLikeToolCallCosplay(text)) return { rejected: "tool-call-cosplay" }
  if (!looksLikeStructuredSummary(text)) return { text, structured: false }
  const first = text.indexOf("## Goal")
  return { text: first > 0 ? text.slice(first).trim() : text, structured: true }
}

/** The model-written part of an installed summary message: no prefix, engine anchor or resume guidance. */
export function summaryBody(content: string): string {
  const body = content.startsWith(SUMMARY_PREFIX) ? content.slice(SUMMARY_PREFIX.length) : content
  const cuts = [ENGINE_ANCHOR_HEADING, RESUME_HEADING].map((heading) => body.indexOf(`\n${heading}`)).filter((index) => index >= 0)
  return (cuts.length ? body.slice(0, Math.min(...cuts)) : body).trim()
}
