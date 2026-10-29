import type { SessionEvent, TurnId } from "@mendcode/protocol"
import { IDLE_COMPACT_NOTE } from "@mendcode/protocol/wire"
import type { Line } from "../ui/theme"
import type { TuiProfile } from "./tui-profile"
import { panelGrid, spread, fit } from "./deck"
import { wrapSpans } from "./markdown"
import { textWidth } from "./wrap"

export type Compaction = Pick<Extract<SessionEvent, { type: "compaction.updated" }>, "turnId" | "reason" | "idle" | "state" | "followUp" | "followUpQueueId"> & { summary: string; itemId?: string; method?: string; tailTurns?: number; tailTokens?: number; fallbackReason?: string; /** The summary request repeated the session's last request, which the provider reads from its prompt cache. */ cachedPrefix?: true }

export function compactionFacts(meta: Record<string, string | number | boolean> | undefined) {
  return { ...(typeof meta?.compactionMethod === "string" ? { method: meta.compactionMethod } : {}), ...(typeof meta?.tailTurns === "number" ? { tailTurns: meta.tailTurns } : {}), ...(typeof meta?.tailTokens === "number" ? { tailTokens: meta.tailTokens } : {}), ...(typeof meta?.fallbackReason === "string" ? { fallbackReason: meta.fallbackReason } : {}), ...(meta?.cachedPrefix === true ? { cachedPrefix: true as const } : {}) }
}

export function compactionStyle(profile: TuiProfile) {
  if (profile.compactionStyle !== "auto") return profile.compactionStyle
  return profile.presentation === "raw" ? "quiet" : profile.presentation === "minimal" ? "minimal" : "cockpit"
}

export function compactionHeading(state: Compaction["state"]) {
  return state === "writing" ? "Packing context" : state === "packed" ? "Context packed" : state === "skipped" ? "Compaction skipped" : `Compaction ${state}`
}

export function compactionStages(data: Compaction): Line[] {
  const packed = data.state === "packed"
  return [
    [{ text: "● Capture transcript", fg: "primary" }],
    [{ text: `${packed ? "●" : data.state === "writing" ? "◐" : "○"} ${data.method === "native" ? "Native checkpoint" : data.method ? `Memory · ${data.method}` : "Write memory"}`, fg: packed ? "primary" : "text" }],
    ...(data.cachedPrefix ? [[{ text: "  repeats the cached prefix", fg: "muted" as const }]] : []),
    [{ text: `${packed && (data.tailTokens ?? 0) > 0 ? "●" : "○"} Preserve tail${data.tailTokens === undefined ? "" : data.tailTokens === 0 ? " · off" : ` · ${data.tailTurns ?? 0} turns`}`, fg: (data.tailTokens ?? 0) > 0 ? "text" : "muted" }],
    ...((data.tailTokens ?? 0) > 0 ? [[{ text: `  ~${data.tailTokens} tokens`, fg: "muted" as const }]] : []),
    ...(data.fallbackReason ? [[{ text: `Portable fallback · ${data.fallbackReason}`, fg: "warning" as const }]] : []),
    [{ text: `${data.followUpQueueId ? "●" : "○"} Continue${data.followUpQueueId ? " · queued" : data.followUp.trim() ? " · follow-up saved" : " · no follow-up"}`, fg: data.followUpQueueId ? "primary" : "muted" }],
  ]
}

const isWriting = (data: Compaction) => data.state === "writing"

/** The muted line under a compaction's heading: who started it. One that ran while idle says why it ran at all. */
export const compactionReason = (data: Pick<Compaction, "reason" | "idle" | "state">) => data.idle ? (data.state === "packed" ? IDLE_COMPACT_NOTE : "idle") : data.reason

export function renderCompactionPanel(input: { data: Compaction; profile: TuiProfile; width: number; expanded: boolean; summaryRows: Line[] }): Line[] {
  const { data, profile, width } = input
  const heading = compactionHeading(data.state)
  const style = compactionStyle(profile)
  const tone = data.state === "failed" ? "error" : data.state === "cancelled" || data.state === "interrupted" ? "warning" : "primary"
  // While the memory is being written the panel above the prompt (`compactionPanel`) shows the progress; the transcript only marks the place.
  if (style === "quiet" || isWriting(data)) {
    const side = Math.max(0, Math.floor((width - textWidth(heading) - 2) / 2))
    const rule = fit([{ text: "─".repeat(side), fg: "border" }, { text: ` ${heading} `, fg: tone }, { text: "─".repeat(Math.max(0, width - side - textWidth(heading) - 2)), fg: "border" }], width)
    // The quiet style has no body: a compaction nobody asked for still says, in one muted line, why it ran.
    return data.idle && data.state === "packed" ? [rule, fit([{ text: IDLE_COMPACT_NOTE, fg: "muted" }], width)] : [rule]
  }
  const memory: Line[] = input.expanded ? input.summaryRows : []
  const reason = compactionReason(data)
  if (style === "minimal") return panelGrid({ rows: [[{ title: heading, body: memory.length ? [...(data.idle ? [[{ text: reason, fg: "muted" as const }]] : []), ...memory] : [[{ text: reason, fg: "muted" }]] }]], width, compact: false, padding: true })
  const body: Line[] = [
    spread([{ text: reason, fg: "muted" }], [{ text: "/compaction open", fg: "muted" }], width - 4),
    ...(profile.compactionProgress && data.state === "writing" ? [[], ...compactionStages(data)] : []),
    [],
    [{ text: `${input.expanded ? "▾" : "▸"} Compacted memory · ${data.state === "writing" ? "packing" : data.state}`, fg: "text" }],
    ...memory,
    ...(profile.compactionScratchpad && (data.state === "writing" || data.followUp) ? [[], [{ text: data.state === "writing" ? "Scratchpad · /compaction to edit" : "Follow-up", fg: "primary" as const }], ...data.followUp.split("\n").flatMap((line) => wrapSpans([{ text: line, fg: "text" as const }], Math.max(1, width - 4))).slice(0, 3)] : []),
  ]
  return panelGrid({ rows: [[{ title: heading, body }]], width, compact: false, padding: true })
}

export const legacyCompaction = (turnId: TurnId, summary: string, status?: string): Compaction => ({ turnId, reason: "manual", state: status === "running" ? "writing" : status === "ok" ? "packed" : "failed", followUp: "", summary })
