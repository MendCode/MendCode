import { estimateTokens } from "@mendcode/protocol/wire"
import { z } from "zod"
import type { ToolResult } from "@mendcode/tools"
import type { ModelMessage } from "./provider"

/** What replaces a snipped output; tool outputs that start with it are already gone. */
export const SNIPPED_PREFIX = "[Output snipped by the assistant"
const MAX_LISTED = 40
const MAX_IDS = 50
/** Results the model must keep: its own notes, loaded skills and the schemas discovered through tool_search. */
const PROTECTED = new Set(["snip", "skill", "tool_search"])

/**
 * `snip`: the model's own context hygiene. Stale tool output (a file it read and replaced, a long log it summarized)
 * is swapped for a one-line note in the history the model is shown from the next request on; the transcript the
 * person sees is unchanged. Handled by the engine because it needs the live history.
 */
export const SNIP_TOOL = {
  name: "snip",
  description:
    "Drop stale tool output from your own context to make room: with no ids it lists the tool results in context (call id, tool, size) so you can choose; with ids it replaces those outputs with a one-line note. " +
    "Snip only output you no longer need (a file you already edited, a log you summarized, a failed attempt); you cannot get it back except by rerunning the tool. The user's transcript is not changed.",
  args: z.object({
    ids: z.array(z.string().min(1).max(200)).max(MAX_IDS).optional().describe("Call ids from the listing; omit to list"),
    reason: z.string().min(1).max(200).optional().describe("Why they are stale, kept in the note"),
  }),
}

export type SnipArgs = z.infer<typeof SNIP_TOOL.args>

const tokens = (text: string) => estimateTokens(text.length)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

type ToolMessage = Extract<ModelMessage, { role: "tool" }>

const snipped = (message: ToolMessage) => message.output.startsWith(SNIPPED_PREFIX) || message.output.startsWith("[Old tool output pruned")
const isProtected = (message: ToolMessage) => PROTECTED.has(message.name) || message.discoveredTools !== undefined

/** What each tool call was, for the listing: the assistant message that made it names the call and its arguments. */
function labels(messages: readonly ModelMessage[], describe: (call: { name: string; args: unknown }) => string): Map<string, string> {
  const found = new Map<string, string>()
  for (const message of messages) if (message.role === "assistant") for (const call of message.toolCalls) found.set(call.callId, describe(call))
  return found
}

/**
 * Lists or snips tool results in `messages` (mutated in place; the engine saves the history afterwards). Never throws:
 * unknown, protected and already snipped ids are reported back so the model can correct itself.
 */
export function runSnip({ messages, args, describe }: { messages: ModelMessage[]; args: SnipArgs; describe: (call: { name: string; args: unknown }) => string }): ToolResult {
  const results = messages.filter((message): message is ToolMessage => message.role === "tool")
  const title = args.ids?.length ? `snip ${args.ids.length}` : "snip list"
  if (!args.ids?.length) {
    const live = results.filter((message) => !snipped(message) && !isProtected(message))
    const names = labels(messages, describe)
    const total = live.reduce((sum, message) => sum + tokens(message.output), 0)
    const shown = live.length > MAX_LISTED ? [...live].sort((a, b) => b.output.length - a.output.length).slice(0, MAX_LISTED).sort((a, b) => results.indexOf(a) - results.indexOf(b)) : live
    const lines = shown.map((message) => `${message.callId} | ${message.name} | ~${tokens(message.output)} tokens | ${clip(names.get(message.callId) ?? message.name, 100)}`)
    const output = live.length
      ? [`${live.length} tool results in context, about ${total} tokens${live.length > shown.length ? ` (the ${shown.length} largest shown)` : ""}. Oldest first:`, ...lines].join("\n")
      : "no tool results in context that can be snipped"
    return { output, truncated: false, title, isError: false, meta: { results: live.length, tokens: total } }
  }
  const note = `${SNIPPED_PREFIX}${args.reason ? `: ${args.reason.replace(/\s+/g, " ").trim()}` : ""}; rerun the tool if it is needed again.]`
  const done: string[] = []
  const problems: string[] = []
  let reclaimed = 0
  for (const id of new Set(args.ids)) {
    const index = messages.findIndex((message) => message.role === "tool" && message.callId === id)
    const message = messages[index]
    if (!message || message.role !== "tool") problems.push(`${id}: no such tool result in context`)
    else if (isProtected(message)) problems.push(`${id}: ${message.name} results are kept`)
    else if (snipped(message)) problems.push(`${id}: already dropped`)
    else {
      reclaimed += tokens(message.output) - tokens(note)
      const { loadedInstructions: _loaded, ...rest } = message
      messages[index] = { ...rest, output: note }
      done.push(id)
    }
  }
  const output = [done.length ? `Snipped ${done.length} tool result${done.length === 1 ? "" : "s"}, about ${Math.max(0, reclaimed)} tokens freed from the next request.` : "Nothing snipped.", ...problems.map((problem) => `- ${problem}`)].join("\n")
  return { output, truncated: false, title, isError: !done.length, meta: { snipped: done.length, tokens: Math.max(0, reclaimed) } }
}
