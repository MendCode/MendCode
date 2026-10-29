import type { SessionEvent } from "@mendcode/protocol"
import { DEFAULT_FOOTER } from "@mendcode/protocol/wire"
import type { Glyphs, Line } from "../ui/theme"
import { createTranscript, type PresentationMode } from "./transcript"
import { DEFAULT_TUI_PROFILE, type TuiProfile } from "./tui-profile"
import { renderFooter } from "./footer"
import { fit } from "./deck"
import { mascotRows } from "./mascot"
import type { SettingsValues } from "./settings-page"

/** Local demonstration only: no session, tool execution or provider request. */
export function settingsPreview(input: { values: SettingsValues; profile?: TuiProfile; pet?: Line[]; width: number; height: number; glyphs: Glyphs; now: number }): Line[] {
  const { values, width, height, glyphs, now } = input
  const profile = input.profile ?? DEFAULT_TUI_PROFILE
  const transcript = createTranscript({ appearance: profile, mode: values.view as PresentationMode, glyphs, now: () => now, frame: () => values.reducedMotion ? 0 : Math.floor(now / 120) })
  let seq = 0
  const emit = (event: Record<string, unknown>) => transcript.apply({ sessionId: "session_preview", seq: ++seq, at: now, ...event } as SessionEvent)
  emit({ type: "turn.started", turnId: "turn_preview", queueId: "queue_preview" })
  for (const [itemId, kind, text, meta] of [
    ["item_user", "user_message", "Explain this change", undefined],
    ["item_answer", "agent_message", "The patch keeps the prompt intact.", undefined],
    ["item_tool", "tool_call", "src/input.ts\nNo errors found", { tool: "read: src/input.ts" }],
  ] as const) {
    emit({ type: "item.started", turnId: "turn_preview", itemId, kind, ...(meta ? { meta } : {}) })
    if (kind === "tool_call") emit({ type: "item.delta", itemId, text })
    else emit({ type: "item.completed", itemId, status: "ok", text })
  }
  const body = transcript.viewport(width, 100, 0).map((line) => line.spans)
  const pet = profile.pet || values.settings.pet
  const art = pet === "mend" ? mascotRows("idle") : pet && pet !== "off" ? input.pet ?? [] : []
  const footer = renderFooter({ segments: values.settings.footer ?? DEFAULT_FOOTER, width, glyphs, stateLabel: "reading", state: "tool", dotOn: values.reducedMotion || Math.floor(now / 500) % 2 === 0, connection: "connected", permission: "ask", permissionLabel: "ask", context: { tokens: 12000, threshold: 200000 }, model: "sample-model", branch: "preview", quotas: [], now, notice: "" })
  const rows = body.slice(0, Math.max(0, height - 1))
  for (const line of art) if (rows.length < height - 1) rows.push(fit(line, width))
  while (rows.length < height - 1) rows.push([])
  return [...rows, footer].slice(0, height).map((line) => fit(line, width))
}
