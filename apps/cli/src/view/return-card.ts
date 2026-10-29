import type { InfoCard } from "./rewind-card"

/**
 * What the terminal asks or shows when you come back to a session: where to continue a session that ran in another
 * directory, whether to compact a very large one, whether to send into a session that went cold, and a recap of what
 * happened while you were away. The first three are dialogs that own the keys; the recap is a card that esc closes.
 */
export type ReturnPrompt =
  | { kind: "cwd"; sessionDirectory: string; launchDirectory: string }
  | { kind: "huge"; tokens: number; limit: number }
  | { kind: "idle"; idleMs: number; tokens: number }
  | { kind: "recap"; text: string; awayMs: number }

/** Dialogs take every key until answered; the recap lets typing go on underneath. */
export const isReturnDialog = (prompt: ReturnPrompt) => prompt.kind !== "recap"

const tokens = (value: number) => (value < 1_000 ? String(Math.max(0, Math.round(value))) : value < 1e6 ? `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0).replace(/\.0$/, "")}k` : `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}m`)

/** The length of an absence in the largest useful unit: 45m, 3h, 2d. */
export function awayLabel(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function returnPromptCard(prompt: ReturnPrompt): InfoCard {
  if (prompt.kind === "cwd") {
    return {
      title: "This session ran in another directory",
      body: [
        { label: "session", text: prompt.sessionDirectory, fg: "text" },
        { label: "here", text: prompt.launchDirectory, fg: "muted" },
        { text: "Its files, git branch and project settings follow the directory it is in.", fg: "muted" },
      ],
      hint: "y continue there · m move the session here · esc continue there",
    }
  }
  if (prompt.kind === "huge") {
    const percent = Math.min(999, Math.round((prompt.tokens / Math.max(1, prompt.limit)) * 100))
    return {
      title: "This session is large",
      body: [
        { label: "context", text: `${tokens(prompt.tokens)} tokens · ${percent}% of the ${tokens(prompt.limit)} compaction threshold`, fg: "text" },
        { text: "Compacting now summarizes the history, so the next answer is faster and cheaper. Nothing is deleted from the transcript.", fg: "muted" },
      ],
      hint: "y compact now · n keep it as is · esc keep it as is",
    }
  }
  if (prompt.kind === "idle") {
    return {
      title: `Idle for ${awayLabel(prompt.idleMs)}`,
      body: [
        { label: "context", text: `${tokens(prompt.tokens)} tokens`, fg: "text" },
        { text: "The provider's cache of this conversation has likely expired, so sending now re-reads all of it. Compacting first makes that smaller.", fg: "muted" },
      ],
      hint: "enter send as is · c compact then send · esc back to the prompt",
    }
  }
  return {
    title: `While you were away · ${awayLabel(prompt.awayMs)}`,
    body: prompt.text.split("\n").filter((line) => line.trim()).map((line) => ({ text: line.replace(/^\s*[-*]\s+/, "• "), fg: "text" as const })),
    hint: "esc close · /recap for the full page",
  }
}
