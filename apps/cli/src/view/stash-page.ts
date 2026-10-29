import type { Line } from "../ui/theme"
import type { StashEntry } from "../ui/prompt-stash"
import { panelGrid, clip } from "./deck"
import { pickerFrame } from "./picker-frame"
import { renderMarkdown } from "./markdown"
import { readablePreview } from "./reply-comments"
import { attachmentsLabel, draftSizeLabel } from "./session-label"

export type DraftsState = { selected: number; deleting?: string }
export type DraftRow = { sessionId: string; title: string; chars: number; attachments: number; images?: number; preview: string; updatedAt: number }

const ago = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h ago` : `${Math.floor(ms / 86_400_000)}d ago`)

/** The unsent drafts of this project's other sessions: size, age and the start of the text; the preview panel shows the preview with its session. */
export function renderDraftsPage(drafts: readonly DraftRow[], state: DraftsState, now: number, width: number, height: number): Line[] {
  const selected = drafts[state.selected]
  const panels = [{ title: "Unsent drafts", active: true, scroll: Math.max(0, state.selected - height + 10), body: (w: number): Line[] => drafts.length ? drafts.map((draft, index) => clip([{ text: index === state.selected ? "› " : "  ", fg: "primary" }, { text: `${draftSizeLabel({ chars: draft.chars, attachments: draft.attachments, images: draft.images ?? 0 })} · ${ago(now - draft.updatedAt)}  `, fg: "muted" }, { text: readablePreview(draft.preview), fg: "text" }], w)) : [[{ text: "No unsent drafts", fg: "muted" }]] }]
  if (width >= 70) panels.push({ title: "Preview", active: false, scroll: 0, body: (w: number): Line[] => selected ? [...(selected.title ? [[{ text: selected.title, fg: "heading" }] as Line] : []), ...renderMarkdown(readablePreview(selected.preview), w), ...(selected.attachments ? [[{ text: `${attachmentsLabel({ attachments: selected.attachments, images: selected.images ?? 0 })} attached`, fg: "muted" }] as Line] : [])] : [] })
  return pickerFrame("Drafts", state.deleting === undefined ? "↑↓ select · enter restore · ctrl-d delete · esc back" : "ctrl-d confirm delete · esc cancel", width, height, panelGrid({ width, padding: true, compact: false, maxColumns: width < 70 ? 1 : 2, heights: [height - 2], rows: [panels] }))
}

export type StashState = { selected: number; deleting?: number }
export function renderStashPage(entries: readonly StashEntry[], state: StashState, width: number, height: number): Line[] {
  const list = [...entries].reverse()
  const selected = list[state.selected]
  const panels = [{ title: "Stashed prompts", active: true, scroll: Math.max(0, state.selected - height + 10), body: (w: number): Line[] => list.length ? list.map((entry, index) => clip([{ text: index === state.selected ? "› " : "  ", fg: "primary" }, { text: entry.text.split("\n")[0] || "Attachments", fg: "text" }, { text: entry.attachments?.length ? ` · ${entry.attachments.length} files` : "", fg: "muted" }], w)) : [[{ text: "No stashed prompts", fg: "muted" }]] }]
  if (width >= 70) panels.push({ title: "Preview", active: false, scroll: 0, body: (w: number): Line[] => selected ? [...renderMarkdown(selected.text, w), ...(selected.attachments ?? []).map((item): Line => [{ text: item.name, fg: "muted" }])] : [] })
  return pickerFrame("Stash", state.deleting === undefined ? "↑↓ select · enter restore · ctrl-d delete · esc back" : "ctrl-d confirm delete · esc cancel", width, height, panelGrid({ width, padding: true, compact: false, maxColumns: width < 70 ? 1 : 2, heights: [height - 2], rows: [panels] }))
}
