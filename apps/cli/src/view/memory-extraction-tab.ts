import type { ExtractionJob, Settings } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { wrap } from "./wrap"

export type ExtractionData = { status?: { queue: number; lastRun: string; lastError: string } | undefined; jobs?: Omit<ExtractionJob, "text">[] | undefined; configured?: boolean | undefined; settings?: Settings | undefined; maintenance?: { policy: string; duplicates: Array<{ memoryId: string; canonicalId: string }> } | undefined }
export const EXTRACTION_HINTS = "↑↓ select · enter set · r retry/refresh · tab tabs · esc back"
export const EXTRACTION_OPTIONS = [
  ["memoryEnabled", "Enabled", true],
  ["memoryUse", "Use in prompts", false],
  ["memoryGenerate", "Generate after turns", false],
  ["memoryRequireApproval", "Require approval", true],
  ["memoryMaxPromptTokens", "Prompt token cap", 10000],
  ["memoryMaxEntries", "Entries", 50],
  ["memoryProjectMaxEntries", "Project entries", 3],
  ["memoryMaintenance", "Maintenance", "disabled"],
] as const
export type ExtractionState = { selected: number; editing?: string }
export type ExtractionAction = { type: "none" | "refreshExtraction" } | { type: "extractionRetry"; jobId: string } | { type: "memorySetting"; key: string; value: boolean | number | string }

export function extractionKey(state: ExtractionState, key: string, data: ExtractionData): { state: ExtractionState; action: ExtractionAction } {
  const none = (next = state) => ({ state: next, action: { type: "none" as const } })
  const option = EXTRACTION_OPTIONS[state.selected]
  if (state.editing !== undefined) {
    if (key === "\x1b") return none({ selected: state.selected })
    if (key === "\x7f") return none({ ...state, editing: state.editing.slice(0, -1) })
    if (key === "\r" && option) {
      const value = Number(state.editing)
      const max = option[0] === "memoryMaxPromptTokens" ? 32_000 : 10_000
      if (!Number.isInteger(value) || value < 1 || value > max) return none(state)
      return { state: { selected: state.selected }, action: { type: "memorySetting", key: option[0], value } }
    }
    return /^\d+$/.test(key) && state.editing.length + key.length <= 5 ? none({ ...state, editing: state.editing + key }) : none()
  }
  const length = EXTRACTION_OPTIONS.length + (data.jobs?.length ?? 0)
  if (key === "\x1b[A") return none({ selected: Math.max(0, state.selected - 1) })
  if (key === "\x1b[B") return none({ selected: Math.min(length - 1, state.selected + 1) })
  if (key === "\r" && option) {
    const value = data.settings?.[option[0]] ?? option[2]
    if (typeof value === "string") {
      const choices = ["disabled", "preview", "auto-consolidate"]
      return { state, action: { type: "memorySetting", key: option[0], value: choices[(choices.indexOf(value) + 1) % choices.length]! } }
    }
    if (typeof value === "boolean") return { state, action: { type: "memorySetting", key: option[0], value: !value } }
    return none({ ...state, editing: String(value) })
  }
  if (key === "r") {
    const job = data.jobs?.[state.selected - EXTRACTION_OPTIONS.length]
    return { state, action: job && ["failed", "skipped"].includes(job.state) ? { type: "extractionRetry", jobId: job.jobId } : { type: "refreshExtraction" } }
  }
  return none()
}

export function renderExtraction(data: ExtractionData, state: ExtractionState, width: number, height: number): Line[] {
  const row = (text: string): Line => [{ text, fg: "text" }]
  const settings = EXTRACTION_OPTIONS.map(([key, label, fallback], index): Line => {
    const value = data.settings?.[key] ?? fallback
    return [{ text: `${state.selected === index ? "›" : " "} ${label}  `, fg: state.selected === index ? "primary" : "text" }, { text: state.selected === index && state.editing !== undefined ? `${state.editing}▏` : typeof value === "boolean" ? value ? "on" : "off" : String(value), fg: "text" }]
  })
  const jobs = [...(data.jobs ?? [])].reverse()
  const list = (data.jobs ?? []).map((job, index): Line => [{ text: `${state.selected === index + EXTRACTION_OPTIONS.length ? "›" : " "} ${job.state} · ${job.attempts} attempts · ${job.proposed} proposals`, fg: job.state === "failed" ? "error" : "text" }])
  const selected = data.jobs?.[state.selected - EXTRACTION_OPTIONS.length] ?? jobs[0]
  const latest = [...jobs].filter((job) => job.attempts > 0).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const error = jobs.find((job) => job.state === "failed" || job.state === "queued" && !!job.reason)
  const summary = [row(`Extraction ${data.settings?.memoryEnabled !== false && data.settings?.memoryGenerate === true ? "enabled" : "off"} · ${data.configured ? "extractor configured" : "extractor not configured"}`), row(`Queue ${data.status?.queue ?? jobs.filter((job) => job.state === "queued" || job.state === "running").length} · Last run ${data.status?.lastRun ?? latest?.state ?? "never"}`), ...wrap(`Last error: ${data.status?.lastError ?? (error?.reason || "none")}`, Math.max(10, width - 8)).map(row)]
  const details = selected ? [row(selected.jobId), row(selected.directory), row(`${selected.state} · ${selected.proposed} proposals`), ...wrap(selected.reason, Math.max(10, width - 8)).map(row)] : []
  if (data.maintenance) details.push([], row(`Maintenance: ${data.maintenance.policy} · ${data.maintenance.duplicates.length} duplicate memories`), ...data.maintenance.duplicates.slice(0, 8).map((entry) => row(`${entry.memoryId} → ${entry.canonicalId}`)))
  const top = Math.min(height, Math.max(12, Math.floor(height * 0.5)))
  const compact = width < 68
  if (compact) {
    const focusedJob = state.selected >= EXTRACTION_OPTIONS.length
    return panelGrid({ width, padding: true, heights: [height], rows: [[focusedJob ? { title: "Extraction queue", body: [...summary, [], list[state.selected - EXTRACTION_OPTIONS.length] ?? [], [], ...details] } : { title: "Memory controls", body: [...summary, ...settings], scroll: Math.max(0, state.selected - height + 6) }]] })
  }
  return panelGrid({ width, padding: true, maxColumns: 2, heights: [top, Math.max(0, height - top - 1)], rows: [
    [{ title: "Memory controls", body: settings }, { title: "Extraction queue", body: [row(data.configured ? "Extractor configured" : "Extractor not configured"), [], ...list], scroll: Math.max(0, state.selected - EXTRACTION_OPTIONS.length - top + 6) }],
    [{ title: selected?.jobId ?? "Extraction", body: [...summary, [], ...details] }],
  ] })
}
