import { parseTokenCount } from "./token-count"

/** What `/context-window` was asked: a window (`null`: back to the model's own), and with `--always` for every session on the model. */
export type ContextWindowArgs = { tokens: number | null; always: boolean }

/** `200k`, `reset`, `500k --always`, `--always reset`; undefined when the count is not one (1k to 10m) or a word is unknown. */
export function parseContextWindowArgs(text: string): ContextWindowArgs | undefined {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const always = words.includes("--always")
  const rest = words.filter((word) => word !== "--always")
  if (rest.length !== 1) return undefined
  const tokens = rest[0] === "reset" || rest[0] === "default" ? null : parseTokenCount(rest[0]!)
  return tokens === undefined ? undefined : { tokens, always }
}

/** The daemon's ack of `session.context-window`. */
export type ContextWindowAck = { contextWindow?: number; requested?: number; maxContextWindow?: number; modelWindow?: number; clamped?: boolean; model?: string; saved?: "set" | "removed" }

const count = (tokens: number) => tokens.toLocaleString("en-US")

/** The reply line: the window now in force, where it applies, and why it differs from what was typed (or why the provider may refuse it). */
export function contextWindowReply(ack: ContextWindowAck, always: boolean): string {
  const scope = always && ack.model ? ` for every session on ${ack.model}` : ""
  if (ack.contextWindow === undefined) return always && ack.model ? `context window: ${ack.model} is back to the model list's window for every session (modelContext window removed)` : "context window: back to the model's own"
  const saved = always && ack.saved === "set" ? " (saved in the modelContext setting; /context-window reset --always removes it)" : ""
  const note = ack.clamped && ack.requested && ack.maxContextWindow ? ` · ${count(ack.requested)} is above the most this model serves (${count(ack.maxContextWindow)}), so it was lowered to that`
    : ack.maxContextWindow === undefined && (ack.modelWindow === undefined || ack.contextWindow > ack.modelWindow) ? ` · no known maximum for this model: the provider may refuse a window beyond what it serves` : ""
  return `context window: ${count(ack.contextWindow)} tokens${scope}${saved}${note}`
}
