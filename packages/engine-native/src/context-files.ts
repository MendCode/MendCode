import type { ModelMessage } from "./provider"

export type ContextFile = { path: string; reads: number; edits: number; tokens: number }

const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit"])
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
const MAX_FILES = 100

/**
 * The files the history still holds: every path a read, edit, write or patch tool call of a successful result touched,
 * with how many times and how many tokens its results take. Biggest first, at most 100.
 */
export function contextFiles(input: { messages: readonly ModelMessage[]; tokensOf(message: ModelMessage): number }): ContextFile[] {
  const calls = new Map<string, { kind: "read" | "edit"; paths: string[] }>()
  for (const message of input.messages) {
    if (message.role !== "assistant") continue
    for (const call of message.toolCalls) {
      const args = (call.args ?? {}) as { path?: unknown; patch?: unknown; input?: unknown }
      if (call.name === "read" && typeof args.path === "string") calls.set(call.callId, { kind: "read", paths: [args.path] })
      else if (EDIT_TOOLS.has(call.name) && typeof args.path === "string") calls.set(call.callId, { kind: "edit", paths: [args.path] })
      else if (call.name === "apply_patch") {
        const text = typeof args.patch === "string" ? args.patch : typeof args.input === "string" ? args.input : ""
        const paths = [...text.matchAll(PATCH_FILE)].map((match) => match[1]!.trim())
        if (paths.length) calls.set(call.callId, { kind: "edit", paths })
      }
    }
  }
  const files = new Map<string, ContextFile>()
  for (const message of input.messages) {
    if (message.role !== "tool" || message.isError) continue
    const call = calls.get(message.callId)
    if (!call) continue
    const share = Math.round(input.tokensOf(message) / call.paths.length)
    for (const path of call.paths) {
      const entry = files.get(path) ?? { path, reads: 0, edits: 0, tokens: 0 }
      if (call.kind === "read") entry.reads++
      else entry.edits++
      entry.tokens += share
      files.set(path, entry)
    }
  }
  return [...files.values()].sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path)).slice(0, MAX_FILES)
}
