import type { Line } from "../ui/theme"
import { fit } from "./deck"
import { formatDuration } from "./exit-summary"

/** A command or agent running in the background of the open session: a shell the model started, or an engine's own task (Claude Code's). */
export type BackgroundItem = { command: string; kind?: "agent" | "command" | undefined; startedAt: number }

/** Rows the full view lists before it folds the rest into `+N more`. */
export const BACKGROUND_FULL_ROWS = 3

const MARK = "◇"
const label = (count: number, kind: "agent" | "command") => `${count} background ${kind}${count === 1 ? "" : "s"}`
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim()

/** A background item's name on one line within `max` characters, for the working row that waits on it. */
export function backgroundName(command: string, max: number): string {
  const line = oneLine(command)
  return !line ? "background work" : line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * What runs in the background of this session, right over the prompt, so nobody has to ask. Compact (minimal and balanced, as Codex
 * and Claude Code show it): one muted row, the single item named or the counts by kind, and where to see them. Full (as opencode and
 * grok-cli list them): one row per item with its run time, up to `BACKGROUND_FULL_ROWS`, then `+N more`. Nothing when nothing runs.
 */
export function backgroundRows(input: { items: readonly BackgroundItem[]; full: boolean; width: number; now: number; inset: number; ascii?: boolean }): Line[] {
  const { items, width, now } = input
  if (!items.length || width < 12) return []
  const pad = { text: " ".repeat(input.inset) }
  const mark = input.ascii ? "*" : MARK
  const since = (item: BackgroundItem) => formatDuration(Math.max(0, now - item.startedAt))
  const kindOf = (item: BackgroundItem) => item.kind ?? "command"
  if (input.full) {
    const shown = items.slice(0, BACKGROUND_FULL_ROWS).map((item, index): Line => fit([
      pad,
      { text: `${mark} `, fg: "secondary" },
      { text: oneLine(item.command) || `background ${kindOf(item)}`, fg: "muted" },
      { text: `  ${kindOf(item)} · ${since(item)}${index === 0 ? " · /ps" : ""}`, fg: "muted", dim: true },
    ], width))
    const rest = items.length - shown.length
    return [...shown, ...(rest > 0 ? [fit([pad, { text: `  +${rest} more · /ps`, fg: "muted", dim: true }], width)] : [])]
  }
  const only = items.length === 1 ? items[0]! : undefined
  const agents = items.filter((item) => kindOf(item) === "agent").length
  const commands = items.length - agents
  const summary = only
    ? `background ${kindOf(only)} · ${oneLine(only.command) || "running"} · ${since(only)}`
    : [commands ? label(commands, "command") : "", agents ? label(agents, "agent") : ""].filter(Boolean).join(" · ")
  return [fit([pad, { text: `${mark} `, fg: "secondary" }, { text: summary, fg: "muted" }, { text: " · /ps", fg: "muted", dim: true }], width)]
}
