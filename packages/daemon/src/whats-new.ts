import { readFileSync } from "node:fs"
import systemFile from "../prompts/whats-new.md" with { type: "file" }
import type { MemoryEntry, Settings } from "@mendcode/protocol"
import { whatsNewPrompt } from "@mendcode/protocol/changelog"
import { estimateTokens, redactSecrets } from "@mendcode/protocol/wire"
import { redactSettings, settingsDiff } from "./settings-tool"

/**
 * `/whatsnew` (docs/whats-new.md): the request of its one model call and the reading of its answer. The context is this machine's
 * own: saved memories of the project, the settings in effect (secrets hidden, as `mendcode_settings get` shows them) and the
 * titles of the project's recent sessions. It goes only to the model the call runs on; nothing is stored.
 */

export const WHATS_NEW_TIMEOUT_MS = 90_000
const MAX_MEMORIES = 40
const MAX_MEMORY_CHARS = 300
const MAX_SESSIONS = 20
const MAX_SETTINGS_CHARS = 6_000
const MAX_SUGGESTIONS = 5
/** Room the answer is given in the estimate: five short lines. */
const ANSWER_TOKENS = 400

export type WhatsNewContext = { memories: string[]; settings: string; sessions: string[] }
export type WhatsNewSuggestion = {
  text: string
  /** A validated `settings.set` patch and its `before → after` lines; the user previews and confirms it before it is saved. */
  patch?: Record<string, unknown>
  diff?: string[]
  /** A slash command to try; the terminal puts it in the prompt, it never runs by itself. */
  command?: string
  /** Why the model's settings change was dropped (invalid, or nothing would change). */
  dropped?: string
}

const squash = (text: string, max: number) => {
  const flat = redactSecrets(text.replace(/\s+/g, " ").trim()).text
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function whatsNewContext(input: { memories: readonly MemoryEntry[]; settings: Settings; sessions: ReadonlyArray<{ title: string }> }): WhatsNewContext {
  const memories = input.memories.filter((entry) => entry.status === "saved").slice(0, MAX_MEMORIES).map((entry) => `${entry.category ? `[${entry.category}] ` : ""}${squash(entry.text, MAX_MEMORY_CHARS)}`)
  const json = JSON.stringify(redactSettings(input.settings))
  const sessions = input.sessions.map((session) => session.title.trim()).filter((title) => title && !/^(loop|workflow) · /.test(title)).slice(0, MAX_SESSIONS).map((title) => squash(title, 120))
  return { memories, settings: json.length > MAX_SETTINGS_CHARS ? `${json.slice(0, MAX_SETTINGS_CHARS)}…` : json, sessions }
}

const block = (name: string, lines: readonly string[], none: string) => `<${name}>\n${lines.length ? lines.join("\n") : none}\n</${name}>`

/** The system text, the request (the copyable prompt, then the changes and the context) and its estimated tokens in and out. */
export function whatsNewRequest(input: { version: string; changes: string; context: WhatsNewContext }): { system: string; prompt: string; estimate: number } {
  const system = readFileSync(systemFile, "utf8").trim()
  const prompt = [
    whatsNewPrompt({ version: input.version, changes: "below" }),
    block("changes", [input.changes.trim()], "(none)"),
    block("memories", input.context.memories.map((line) => `- ${line}`), "(no saved memories)"),
    block("settings", [input.context.settings], "{}"),
    block("recent_sessions", input.context.sessions.map((line) => `- ${line}`), "(none)"),
  ].join("\n\n")
  return { system, prompt, estimate: estimateTokens(system.length + prompt.length) + ANSWER_TOKENS }
}

/** The picks of an answer: `- ` lines, each with an optional ` => settings {…}` or ` => command /…` action. */
export function parseWhatsNew(text: string): WhatsNewSuggestion[] {
  const out: WhatsNewSuggestion[] = []
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const bullet = /^[-*•]\s+/.exec(trimmed)
    const line = bullet ? trimmed.slice(bullet[0].length) : trimmed
    // A wrapped line belongs to the pick above it.
    if (!bullet && out.length) { out[out.length - 1]!.text += ` ${line}`; continue }
    if (out.length === MAX_SUGGESTIONS) break
    const action = /\s*=>\s*(settings|command)\s+(.+)$/.exec(line)
    const shown = (action ? line.slice(0, action.index) : line).trim()
    if (!shown) continue
    const pick: WhatsNewSuggestion = { text: shown }
    if (action?.[1] === "command" && /^\/[a-z][\w-]*(\s.*)?$/i.test(action[2]!.trim())) pick.command = action[2]!.trim().slice(0, 200)
    if (action?.[1] === "settings") {
      try {
        const patch = JSON.parse(action[2]!) as unknown
        if (patch && typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).length) pick.patch = patch as Record<string, unknown>
        else pick.dropped = "not a settings patch"
      } catch { pick.dropped = "not a settings patch" }
    }
    out.push(pick)
  }
  return out
}

/**
 * Each settings change checked the way `mendcode_settings propose` checks one before asking: validated as `settings.set` would,
 * spend limits left alone, and shown as `before → after`. A change that fails keeps its text and loses its action.
 */
export function checkSuggestions(picks: WhatsNewSuggestion[], input: { settings: Settings; check(patch: Record<string, unknown>): Settings }): WhatsNewSuggestion[] {
  return picks.map((pick) => {
    if (!pick.patch) return pick
    const { patch, ...rest } = pick
    if ("budgets" in patch) return { ...rest, dropped: "spend limits change only when you ask" }
    let after: Settings
    try { after = input.check(patch) } catch { return { ...rest, dropped: "invalid settings" } }
    const diff = settingsDiff(input.settings as Record<string, unknown>, after as Record<string, unknown>, Object.keys(patch))
    return diff.length ? { ...rest, patch, diff } : { ...rest, dropped: "already set" }
  })
}
