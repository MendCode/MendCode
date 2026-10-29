import type { Line, Span } from "../ui/theme"
import { subagentColor } from "./agent-color"
import { clip, lineWidth } from "./deck"
import { formatElapsed } from "./time"
import type { AgentThread } from "./transcript"
import { truncateEnd } from "./wrap"

/**
 * The head of a sub-agent's thread opened in the chat's place: its name in its own colour (the one its strip row and card wear),
 * where it sits among its siblings and the keys that move, then what it is and what it is doing, and a rule under both. Three
 * rows, each exactly `width` cells after `inset`.
 */
export function agentThreadHeader(input: { thread: AgentThread; index: number; count: number; now: number; width: number; inset: number; sep: string; rule: string }): Line[] {
  const { thread, sep } = input
  const room = Math.max(1, input.width - input.inset * 2)
  const pad: Span = { text: " ".repeat(input.inset) }
  const color = subagentColor(thread.description)
  const keys: Line = [{ text: [...(input.count > 1 ? [`${input.index + 1} of ${input.count}`, "←→"] : []), "↑ back"].join(` ${sep} `), fg: "muted" }]
  const nameRoom = Math.max(4, room - lineWidth(keys) - 4)
  const name: Line = [{ text: "◆ ", fg: thread.running ? color : "muted" }, { text: truncateEnd(thread.description, nameRoom - 2), fg: thread.running ? color : "text", bold: true }]
  const gap = Math.max(2, room - lineWidth(name) - lineWidth(keys))
  const first: Line = lineWidth(name) + 2 + lineWidth(keys) <= room ? [...name, { text: " ".repeat(gap) }, ...keys] : clip(name, room)
  const state: Span = thread.running ? { text: thread.last ?? "starting", fg: "text" } : thread.status === "ok" ? { text: "done", fg: "success" } : thread.status === "error" ? { text: "failed", fg: "error" } : { text: "interrupted", fg: "warning" }
  const elapsed = thread.startedAt !== undefined ? formatElapsed((thread.running ? input.now : thread.endedAt ?? input.now) - thread.startedAt) : undefined
  const facts: Span[] = [
    { text: thread.agent, fg: "muted" },
    // `claude-sonnet-4-5-20250929` reads as `claude-sonnet-4-5`: the snapshot date says nothing here.
    ...(thread.model ? [{ text: thread.model.replace(/-\d{8}$/, ""), fg: "muted" as const }] : []),
    { text: thread.background ? "bg" : "await", fg: thread.background ? "muted" : "accent" },
    ...(thread.tools ? [{ text: `${thread.tools} tool${thread.tools === 1 ? "" : "s"}`, fg: "muted" as const }] : []),
    ...(elapsed ? [{ text: elapsed, fg: "muted" as const }] : []),
    ...(!thread.running && thread.tokens ? [{ text: `${thread.tokens < 1000 ? thread.tokens : `${Math.round(thread.tokens / 1000)}k`} tokens`, fg: "muted" as const }] : []),
    // Last: what it is doing is the longest fact, and a narrow row cuts it rather than the time.
    state,
  ]
  const second: Line = [{ text: "  " }, ...facts.flatMap((fact, at): Span[] => (at ? [{ text: ` ${sep} `, fg: "muted" }, fact] : [fact]))]
  const full = (line: Line): Line => {
    const fitted = clip(line, room)
    return [pad, ...fitted, { text: " ".repeat(Math.max(0, room - lineWidth(fitted))) }]
  }
  return [full(first), full(second), full([{ text: input.rule.repeat(room), fg: "border" }])]
}
