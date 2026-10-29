import { defineTool, fail } from "@mendcode/tools"
import { z } from "zod"
import { MAX_PEER_SESSIONS } from "./peers"

/**
 * Session-to-session tools (v1's `sessions` and `tell`). `sessions` lists descriptors only, never transcripts;
 * `tell` queues a plain-text message whose answer returns on its own, so the model never polls.
 */
export const sessionsTool = defineTool({
  name: "sessions",
  description: [
    "List this project's other MendCode sessions: id, title, state and last update. It never shows their transcripts, files or reasoning.",
    "stats=<session id> (or self) returns that session's figures instead: how long it worked (each turn's start, end and duration, per day and per hour), tokens per model, sub-agents, tools and approval waits. Use it for \"how long did it work\" or \"what did it spend\"; never estimate those from an export.",
    "This is a list of recent conversations, not of agents working right now: idle does not mean the session is open, and titles or recency do not mean a session owns a file.",
    "Use an exact id with tell only when you have a concrete reason to ask that session something.",
  ].join(" "),
  permission: "read",
  args: z.object({
    limit: z.number().int().min(1).max(MAX_PEER_SESSIONS).optional().describe(`How many to list, at most ${MAX_PEER_SESSIONS}`),
    stats: z.string().min(4).max(64).optional().describe("A session id from this project, or self: return its time and token figures instead of the list"),
  }),
  async execute({ limit, stats }, context) {
    if (!context.peers) return fail({ title: "sessions", message: "sessions are not available here" })
    if (stats) {
      const report = context.peers.stats?.(stats) ?? { ok: false as const, message: "session figures are not available here" }
      if (!report.ok) return fail({ title: `Session stats ${stats}`, message: report.message })
      return { output: report.output, truncated: false, title: `Session stats ${stats}`, isError: false, meta: { stats: true } }
    }
    const sessions = context.peers.list(limit)
    const output = sessions.length
      ? sessions.map((session) => `sessionId=${session.sessionId} title=${JSON.stringify(session.title)} state=${session.state} updatedAt=${new Date(session.updatedAt).toISOString()}`).join("\n")
      : "No other sessions in this project."
    return { output, truncated: false, title: `Sessions (${sessions.length})`, isError: false, meta: { count: sessions.length } }
  },
})

export const tellTool = defineTool({
  name: "tell",
  description: [
    "Send a plain-text message to one other session of this project, by its exact id from sessions.",
    "Nothing else is shared: no history, files, reasoning or permissions, so make the message self-contained.",
    "If the session is busy, the message waits for its turn to end, or with mode steer joins its running turn after the next tool result; it never interrupts.",
    "Its final answer comes back to you as a notice on its own. Do not poll, and do not use tell to answer a message you received: your answer goes back automatically.",
  ].join(" "),
  permission: "write",
  args: z.object({
    sessionId: z.string().min(1).describe("Exact session id from sessions; never guess one from a title"),
    text: z.string().min(1).max(8_000).describe("The message; self-contained"),
    mode: z.enum(["auto", "queue", "steer"]).optional().describe("auto (default) and queue wait for the session's turn to end; steer hands it to the session's running turn after its next tool result. Never interrupts"),
    clientRequestId: z.string().min(1).max(128).optional().describe("Reuse the same id when retrying so the message is not sent twice"),
  }),
  async preview({ sessionId, text, mode }) {
    return `To ${sessionId}${mode === "steer" ? " (steer)" : ""}:\n${text}`
  },
  async execute({ sessionId, text, mode, clientRequestId }, context) {
    if (!context.peers) return fail({ title: "tell", message: "sessions are not available here" })
    const sent = await context.peers.tell(sessionId, text, { ...(mode ? { mode } : {}), ...(clientRequestId ? { clientRequestId } : {}) })
    if (!sent.ok) return fail({ title: `tell ${sessionId}`, message: sent.message })
    return {
      output: `Message queued for ${sessionId}. ${sent.waiting ? mode === "steer" ? "That session is busy; its running turn reads the message after its next tool result, or when the turn ends if its engine cannot take it sooner." : "That session is busy; it reads the message when its turn ends." : "That session is answering now."} Its answer arrives here as a notice; do not poll.`,
      truncated: false,
      title: `Message → ${sessionId}`,
      isError: false,
      meta: { target: sessionId },
    }
  },
})
