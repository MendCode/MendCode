import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { AsideThread } from "@mendcode/protocol"
import type { SessionEvent } from "@mendcode/protocol"

/** How much of the conversation a side question sees: the most recent part, in characters. */
export const ASIDE_CONTEXT_CHARS = 24_000
export const ASIDE_TIMEOUT_MS = 120_000

const LABEL: Record<string, string> = { user_message: "User", agent_message: "Assistant", tool_call: "Tool", reasoning: "Thinking" }

/**
 * The session as plain text from its event log, so it works for every engine: user and assistant messages, tool
 * titles with the start of their output, and what a running turn has produced so far. Keeps the most recent part.
 */
export function asideTranscript(events: SessionEvent[], maxChars = ASIDE_CONTEXT_CHARS): string {
  const items = new Map<string, { kind: string; tool?: string; text: string; done: boolean }>()
  const order: string[] = []
  for (const event of events) {
    if (event.type === "item.started") {
      if (!LABEL[event.kind] || event.kind === "reasoning") continue
      const tool = typeof event.meta?.tool === "string" ? event.meta.tool : undefined
      items.set(event.itemId, { kind: event.kind, ...(tool ? { tool } : {}), text: "", done: false })
      order.push(event.itemId)
    } else if (event.type === "item.delta") {
      const item = items.get(event.itemId)
      if (item) item.text += event.text
    } else if (event.type === "item.completed") {
      const item = items.get(event.itemId)
      if (!item) continue
      if (typeof event.text === "string") item.text = event.text
      item.done = true
    }
  }
  const blocks: string[] = []
  for (const itemId of order) {
    const item = items.get(itemId)!
    const text = item.text.trim()
    if (item.kind === "tool_call") blocks.push(`Tool: ${item.tool ?? "tool"}${text ? `\n${text.slice(0, 600)}${text.length > 600 ? "\n…" : ""}` : ""}`)
    else if (text) blocks.push(`${LABEL[item.kind]}${item.done ? "" : " (still writing)"}: ${text}`)
  }
  const transcript = blocks.join("\n\n")
  return transcript.length > maxChars ? `…\n${transcript.slice(-maxChars)}` : transcript
}

export function createAsideStore(dir: string) {
  const live = new Map<string, AsideThread>()
  const file = (id: string) => path.join(dir, "asides", `${id}.json`)
  function get(id: string): AsideThread {
    const cached = live.get(id)
    if (cached) return cached
    try {
      const { status: _status, ...saved } = AsideThread.parse(JSON.parse(readFileSync(file(id), "utf8")))
      const thread = { ...saved, busy: false, ...(saved.busy ? { error: "Side chat interrupted by daemon restart" } : {}) }
      live.set(id, thread)
      return thread
    } catch { return { messages: [], busy: false } }
  }
  function set(id: string, thread: AsideThread, persist = true) {
    live.set(id, thread)
    if (!persist) return
    mkdirSync(path.dirname(file(id)), { recursive: true })
    const temp = `${file(id)}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(thread) + "\n")
    renameSync(temp, file(id))
  }
  return { get, set }
}
