import type { PermissionMode, SessionEvent } from "@mendcode/protocol"
import { DEFAULT_FOOTER, TIER_BASELINE_TOKENS, TIER_BUNDLES, type Tier } from "@mendcode/protocol/wire"
import type { Glyphs, Line } from "../ui/theme"
import { createTranscript } from "./transcript"
import { DEFAULT_TUI_PROFILE, type TuiProfile } from "./tui-profile"
import { renderFooter } from "./footer"
import { PLACEHOLDER_EXAMPLES, promptFrame, promptRow, renderStatusRow, withRightBlock } from "./prompt-chrome"
import { fit } from "./deck"
import { PLAN_TITLE, approvalOptions, renderApprovalPanel, type PanelRequest } from "./request-panel"
import { mendChatLines } from "./mend-sprite"
import { mascotRows } from "./mascot"
import { splitDiffAt } from "./tool-card"
import { textWidth } from "./wrap"

/**
 * The sample conversation the first-run page and the tutorial show. Every row comes from the real components (the
 * transcript for the chat, `renderApprovalPanel` for the card, `promptFrame` for the prompt, `renderFooter` for the status
 * row), so a preview cannot drift from the product. Nothing here starts a session, runs a tool or calls a model.
 */
export type SamplePart = "chat" | "approval" | "prompt" | "footer"
/** The profile keys the sample draws: tool cards, the diff, the prompt's chrome and the pet beside it. */
export type SampleLook = Partial<Pick<TuiProfile, "toolOutput" | "toolDensity" | "codeMapCard" | "diffView" | "promptChrome" | "pet">>
export type SampleInput = {
  tier: Tier
  permission: PermissionMode
  /** Model name for the footer row. */
  model: string
  width: number
  height: number
  glyphs: Glyphs
  now: number
  /** Which parts to draw; all of them by default. */
  parts?: readonly SamplePart[]
  /** Fill `height` with blank rows above the prompt (default). False returns only the rows the sample needs, at most `height`. */
  pad?: boolean
  look?: SampleLook
  /** The chat's real width: a diff splits by it, not by the sample's narrower one. */
  chatWidth?: number
}

const SESSION = "session_sample"
const COMMAND = "bun test"
const DIFF = ["@@ -12,3 +12,3 @@", " export function total(items: Item[]) {", "-  return items.length", "+  return items.reduce((sum, item) => sum + item.price, 0)", " }"].join("\n")

/** The sample turn, replayed through a real transcript at the tier's chat view. */
export function sampleChat({ tier, width, glyphs, now, look, chatWidth }: { tier: Tier; width: number; glyphs: Glyphs; now: number; look?: SampleLook; chatWidth?: number }): Line[] {
  const bundle = TIER_BUNDLES[tier]
  const diffView = look?.diffView ?? DEFAULT_TUI_PROFILE.diffView
  const transcript = createTranscript({ appearance: { ...DEFAULT_TUI_PROFILE, ...look, density: bundle.density }, mode: bundle.view, glyphs, now: () => now, frame: () => 0, ...(chatWidth ? { splitDiff: () => splitDiffAt(diffView, chatWidth) } : {}) })
  let seq = 0
  const emit = (event: Record<string, unknown>) => transcript.apply({ sessionId: SESSION, seq: ++seq, at: now, ...event } as unknown as SessionEvent)
  emit({ type: "turn.started", turnId: "turn_sample", queueId: "queue_sample" })
  const item = (itemId: string, kind: string, text: string, tool?: string) => {
    emit({ type: "item.started", turnId: "turn_sample", itemId, kind, ...(tool ? { meta: { tool } } : {}) })
    if (kind === "tool_call") { emit({ type: "item.delta", itemId, text }); emit({ type: "item.completed", itemId, status: "ok", text }) }
    else emit({ type: "item.completed", itemId, status: "ok", text })
  }
  item("item_user", "user_message", "Fix the total in src/cart.ts")
  item("item_read", "tool_call", "export function total(items: Item[]) {\n  return items.length\n}", "read: src/cart.ts")
  item("item_edit", "tool_call", DIFF, "edit: src/cart.ts")
  item("item_answer", "agent_message", "The total now adds the prices.")
  return transcript.viewport(width, 200, 0).map((line) => fit(line.spans, width))
}

const request = (permission: PermissionMode): PanelRequest => permission === "plan"
  ? { requestId: "request_sample", title: PLAN_TITLE, detail: "1. Run the tests\n2. Fix the failing case" }
  : { requestId: "request_sample", title: "Run command", detail: COMMAND, tool: "shell", permission: "execute", permissionContext: { name: "shell", patterns: [COMMAND], always: [COMMAND] } }

/** What the permission mode does to the sample command, as one dim line. */
export const PERMISSION_NOTES: Readonly<Record<string, string>> = {
  ask: "ask: every edit and command waits for you",
  smart: "smart: known-safe commands run, the rest ask",
  edits: "edits: file changes apply, commands still ask",
  full: "full: nothing asks, commands run at once",
  plan: "plan: it proposes, you approve before it changes anything",
}

/** The approval card the mode would show for the sample command, or the row it would show instead. */
export function sampleApproval({ permission, width, glyphs, now }: { permission: PermissionMode; width: number; glyphs: Glyphs; now: number }): Line[] {
  if (permission === "full") {
    const transcript = createTranscript({ appearance: DEFAULT_TUI_PROFILE, mode: "balanced", glyphs, now: () => now, frame: () => 0 })
    let seq = 0
    const emit = (event: Record<string, unknown>) => transcript.apply({ sessionId: SESSION, seq: ++seq, at: now, ...event } as unknown as SessionEvent)
    emit({ type: "turn.started", turnId: "turn_run", queueId: "queue_run" })
    emit({ type: "item.started", turnId: "turn_run", itemId: "item_run", kind: "tool_call", meta: { tool: `shell: ${COMMAND}` } })
    emit({ type: "item.completed", itemId: "item_run", status: "ok", text: "12 pass" })
    return transcript.viewport(width, 20, 0).map((line) => fit(line.spans, width))
  }
  const req = request(permission)
  const detail: Line[] = req.detail.split("\n").map((text) => [{ text: `  ${text}`, fg: "text" as const }])
  const choices = permission === "plan" ? undefined : approvalOptions(req.title).filter((option) => option.choice !== "note")
  return renderApprovalPanel({ width, request: req, detail, choice: 0, hint: "↑↓ choose · enter confirm", ...(choices ? { choices } : {}) }).rows.map((line) => fit(line, width))
}

/** The empty prompt in the chrome `promptChrome` names, with the chat's first example as its placeholder. */
export function samplePrompt({ width, glyphs, look }: { width: number; glyphs: Glyphs; look?: SampleLook }): Line[] {
  const frame = promptFrame({ preset: look?.promptChrome ?? DEFAULT_TUI_PROFILE.promptChrome, width, glyphs, rich: true })
  return [...frame.top, frame.row(promptRow({ text: "", first: true, rich: true, glyphs, placeholder: PLACEHOLDER_EXAMPLES[0]! })), ...frame.bottom].map((line) => fit(line, width))
}

/** The pet that stands on the prompt: Mend in half blocks, or its text art where glyphs are ASCII. Other pets are pictures the sample does not draw. */
function samplePet(look: SampleLook | undefined, glyphs: Glyphs): Line[] {
  if (look?.pet !== "mend") return []
  return glyphs.rule === "-" ? mascotRows("idle") : mendChatLines("idle")
}

/** The status row (where the model shows) and the footer (where the mode shows), as the chat draws them under the prompt. */
export function sampleBottom({ model, permission, width, glyphs, now }: { model: string; permission: PermissionMode; width: number; glyphs: Glyphs; now: number }): Line[] {
  const status = renderStatusRow({ width, model, loops: 0 })
  const footer = renderFooter({
    segments: DEFAULT_FOOTER, width, glyphs, stateLabel: permission === "plan" ? "planning" : "ready", state: "idle", dotOn: true, connection: "connected",
    permission, permissionLabel: permission, context: { tokens: 12_000, threshold: 200_000 }, model, branch: "main", quotas: [], now, notice: "",
  })
  return [status, footer].map((line) => fit(line, width))
}

/** The sample as `height` rows: chat on top (its newest rows when it must be cut), the card, then the prompt (with the pet on it) and footer. */
export function onboardingSample(input: SampleInput): Line[] {
  const { width, height, glyphs, now, look } = input
  const parts = new Set<SamplePart>(input.parts ?? ["chat", "approval", "prompt", "footer"])
  const prompt = parts.has("prompt") ? samplePrompt({ width, glyphs, ...(look ? { look } : {}) }) : []
  const bottom = [...prompt, ...(parts.has("footer") ? sampleBottom({ model: input.model, permission: input.permission, width, glyphs, now }) : [])]
  const card = parts.has("approval") ? sampleApproval({ permission: input.permission, width, glyphs, now }) : []
  const room = Math.max(0, height - bottom.length)
  const chat = parts.has("chat") ? sampleChat({ tier: input.tier, width, glyphs, now, ...(look ? { look } : {}), ...(input.chatWidth ? { chatWidth: input.chatWidth } : {}) }) : []
  const above = [...chat, ...card]
  const shown = card.length >= room ? card.slice(0, room) : above.slice(Math.max(0, above.length - room))
  const rows = [...shown]
  if (input.pad !== false) while (rows.length < room) rows.push(fit([], width))
  const pet = prompt.length ? samplePet(look, glyphs) : []
  while (rows.length < pet.length && rows.length + bottom.length < height) rows.unshift(fit([], width))
  // It stands on the prompt as in the chat, over the right end of the rows above; like the chat, it is left out where it does not fit whole.
  if (pet.length && rows.length >= pet.length) {
    const cols = Math.max(...pet.map((line) => textWidth(line.map((span) => span.text).join(""))))
    const first = rows.length - pet.length
    pet.forEach((line, i) => { rows[first + i] = fit(withRightBlock(rows[first + i]!, width, line, cols), width) })
  }
  return [...rows, ...bottom].slice(0, height)
}

/** One line on what a tier shows and what it costs in context, from the same numbers the tier test holds it to. */
export function tierLine(tier: Tier): string {
  const tokens = TIER_BASELINE_TOKENS[tier]
  const what = tier === "minimalist" ? "bare chat, small prompt" : tier === "balanced" ? "tool cards, code graph, sub-agents" : "everything: MCP, pets, voice, wide chat"
  return `${what} · ~${(Math.round(tokens / 100) / 10).toFixed(1)}k tokens of context per request`
}
