import type { ModelsReport, PermissionGrant, PermissionMode, Settings, ModelRole, PermissionsHistoryReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { clip, fit, panelGrid, spread, type GridPanel } from "./deck"
import { relativeTime, truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"

/**
 * `/permissions`: the session's permission mode with what each mode does, the smart mode's rules in a few lines, the
 * permission reviewer's status and the tools approved "for this session" (`permissions.list`), which can be taken
 * back one at a time or all at once (`permissions.revoke`). The mode is set with 1-4; `/plan` owns plan mode.
 */

export type PermissionsPageState = { selected: number; confirmAll?: true; scroll?: number; historyView?: boolean; historySelected?: number; historyCount?: number }

export type PermissionsPageAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "mode"; mode: PermissionMode }
  | { type: "revoke"; grantId: string | "all" }
  /** The reviewer is a model role: `/model` sets it. */
  | { type: "model" }

/** Where the reviewer's role stands: `loading` until `models.list` answers, `error` when it failed. */
export type ReviewerStatus = { kind: "loading" } | { kind: "error"; message: string } | { kind: "off" } | { kind: "on"; model: string; effort?: string }

const NONE: PermissionsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])

/** The modes the keys 1-4 pick, in order; plan mode is entered with `/plan`. */
export const PICKABLE_MODES: readonly PermissionMode[] = ["ask", "edits", "full", "smart"]

const MODES: ReadonlyArray<{ mode: PermissionMode; label: string; write: string; execute: string; note: string }> = [
  { mode: "ask", label: "ask", write: "asks", execute: "asks", note: "every edit and command asks" },
  { mode: "edits", label: "edits", write: "runs", execute: "asks", note: "file edits run, commands ask" },
  { mode: "full", label: "full", write: "runs", execute: "runs", note: "nothing asks" },
  { mode: "smart", label: "smart", write: "low risk", execute: "low risk", note: "rules run low-risk calls, the rest asks" },
  { mode: "plan", label: "plan", write: "refused", execute: "refused", note: "read-only until a plan is approved (/plan)" },
]

/** What smart mode does, one row each (docs/permissions.md has the full table). */
const SMART_RULES: ReadonlyArray<{ head: string; tone: ColorName; text: string }> = [
  { head: "runs", tone: "success", text: "reads · edits inside the project · allow-listed commands (read-only, checks, permissionAllow)" },
  { head: "asks high", tone: "error", text: "destructive · secrets · .git · outside the project · network · loop/workflow/tell" },
  { head: "asks unsure", tone: "warning", text: "shell expansion · unlisted commands · unknown tools" },  { head: "grants", tone: "muted", text: "smart grants bind the exact action and user authority, never a high-risk one" },
]

export function createPermissionsPageState(): PermissionsPageState {
  return { selected: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

/** The reviewer row's state from a `models.list` report (the role has no fallback: unset means no reviewer). */
export function reviewerStatus(report: ModelsReport | undefined, error?: string, role: ModelRole = "permissionReviewer"): ReviewerStatus {
  if (error) return { kind: "error", message: error }
  if (!report) return { kind: "loading" }
  const choice = report.roles[role]
  return choice ? { kind: "on", model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) } : { kind: "off" }
}

/** Handles one raw key over the session's grants. Returns the same state object when nothing changed. */
export function permissionsPageKey(state: PermissionsPageState, key: string, grants: readonly PermissionGrant[]): { state: PermissionsPageState; action: PermissionsPageAction } {
  const { confirmAll, ...rest } = state
  if (confirmAll) return key === "R" || key === "y" ? { state: rest, action: { type: "revoke", grantId: "all" } } : { state: rest, action: NONE }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  const picked = PICKABLE_MODES[Number(key) - 1]
  if (/^[1-9]$/.test(key)) return picked ? { state, action: { type: "mode", mode: picked } } : { state, action: NONE }
  if (key === "m") return { state, action: { type: "model" } }
  if (key === "h") return { state: { ...state, historyView: !state.historyView, scroll: 0 }, action: NONE }
  if (key === "[" || key === "]") return { state: { ...state, scroll: Math.max(0, (state.scroll ?? 0) + (key === "]" ? 1 : -1)) }, action: NONE }
  if (key === "\x1b[6~" || key === "\x1b[5~") return { state: { ...state, scroll: Math.max(0, (state.scroll ?? 0) + (key === "\x1b[6~" ? 8 : -8)) }, action: NONE }
  if (state.historyView) {
    const selected = state.historySelected ?? 0
    if (UP.has(key) || DOWN.has(key)) return { state: { ...state, historySelected: clamp(selected + (UP.has(key) ? -1 : 1), state.historyCount ?? 0) }, action: NONE }
    return { state, action: NONE }
  }
  const selected = clamp(state.selected, grants.length)
  const move = (index: number) => {
    const next = clamp(index, grants.length)
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next }, action: NONE }
  }
  if (UP.has(key)) return move(selected - 1)
  if (DOWN.has(key)) return move(selected + 1)
  const target = grants[selected]
  if (key === "r" || key === "x") return target ? { state: { ...state, selected }, action: { type: "revoke", grantId: target.grantId } } : { state, action: NONE }
  if (key === "R") return grants.length > 0 ? { state: { ...state, selected, confirmAll: true }, action: NONE } : { state, action: NONE }
  return { state, action: NONE }
}

const PERMISSION_TONE: Record<PermissionGrant["permission"], ColorName> = { read: "muted", write: "warning", execute: "error" }

function modeRows(current: PermissionMode, width: number, glyphs: Glyphs): Line[] {
  const rows: Line[] = []
  for (const entry of MODES) {
    const on = entry.mode === current
    const pick = PICKABLE_MODES.indexOf(entry.mode)
    const marker: Span = on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
    const note = width < 62 ? ({ ask: "edits and commands ask", edits: "edits run, commands ask", full: "runs unless denied by rule", smart: "low risk runs; rest asks", plan: "read-only (/plan)" })[entry.mode] : entry.mode === "full" ? "runs unless denied by rule" : entry.note
    rows.push(clip([marker, { text: entry.label.padEnd(6), fg: on ? "primary" : "text", bold: on }, { text: pick >= 0 ? `${pick + 1} ` : "  ", fg: "muted", dim: true }, { text: note, fg: on ? "body" : "muted" }], width))
  }
  return rows
}

function ruleRows(width: number): Line[] {
  const rows: Line[] = []
  for (const rule of SMART_RULES) {
    const head = rule.head.padEnd(13)
    const lines = wrap(rule.text, Math.max(8, width - head.length))
    lines.forEach((text, index) => rows.push(clip([{ text: index === 0 ? head : " ".repeat(head.length), fg: rule.tone }, { text, fg: "body" }], width)))
  }
  return rows
}

function reviewerRows(status: ReviewerStatus, mode: PermissionMode, width: number, role = "permissionReviewer"): Line[] {
  const value: Span[] =
    status.kind === "loading"
      ? [{ text: "checking…", fg: "muted" }]
      : status.kind === "error"
        ? [{ text: truncateEnd(status.message, Math.max(8, width - 12)), fg: "warning" }]
        : status.kind === "off"
          ? [{ text: "off", fg: "muted" }, { text: " · no model set, no reviewer runs", fg: "muted", dim: true }]
          : [{ text: "on", fg: "success", bold: true }, { text: ` · ${status.model}${status.effort ? ` ${status.effort}` : ""}`, fg: "text" }]
  const rows: Line[] = [clip([{ text: "reviewer  ", fg: "muted" }, ...value], width)]
  const note = status.kind === "on" ? (mode === "smart" ? "judges what the rules did not settle; unsure = ask" : "only consulted in smart mode") : `set the ${role} role in /model (m)`
  rows.push(...wrap(note, Math.max(8, width - 2)).map((text): Line => clip([{ text: `  ${text}`, fg: "muted", dim: true }], width)))
  return rows
}

function grantRows(input: { grants: readonly PermissionGrant[]; state: PermissionsPageState; width: number; now: number; glyphs: Glyphs }): { rows: Line[]; focus: number } {
  const { grants, state, width, now, glyphs } = input
  if (grants.length === 0) return { rows: [[{ text: "none yet", fg: "muted" }]], focus: 0 }
  const selected = clamp(state.selected, grants.length)
  let focus = 0
  const rows = grants.flatMap((grant, index): Line[] => {
    const on = index === selected
    const age = relativeTime(now, grant.grantedAt)
    const tool = truncateEnd(grant.pattern ? `${grant.tool} · ${grant.rulePermission}` : grant.tool, Math.max(6, width - 2 - 9 - age.length - 2))
    const used = 2 + textWidth(tool) + 1
    const gap = Math.max(1, width - used - 9 - age.length - 1)
    const row = clip(
      [
        on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
        { text: tool, fg: on ? "primary" : "text", bold: on },
        { text: " ".repeat(gap) },
        { text: grant.permission.padEnd(8), fg: PERMISSION_TONE[grant.permission] },
        { text: ` ${age}`, fg: "muted" },
      ],
      width,
    )
    return [row, ...(grant.pattern ? [[{ text: `  ${grant.pattern}`, fg: on ? "primary" : "muted" } as Span]] : [])]
  })
  focus = grants.slice(0, selected).reduce((sum, grant) => sum + (grant.pattern ? 2 : 1), 0)
  return { rows, focus }
}

/** Renders exactly `height` lines of at most `width` cells. `grants` is undefined while they load. */
export function renderPermissionsPage(input: {
  mode: PermissionMode
  grants: readonly PermissionGrant[] | undefined
  history?: PermissionsHistoryReport
  historyError?: string
  grantsError?: string
  reviewer: ReviewerStatus
  settings?: Settings
  state: PermissionsPageState
  width: number
  height: number
  now: number
  glyphs?: Glyphs
}): Line[] {
  const { mode, state, width, height, now } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const grants = input.grants ?? []
  const settings = input.settings ?? {}
  const compact = width < 70
  if (state.historyView) return renderPermissionHistory(input)
  const hints = state.confirmAll ? "R/y confirm · any key cancels" : compact ? "↑↓ r · h history · ] scroll · esc" : "↑↓ r/R grants · h history · 1-4 mode · m model · [/] · esc"
  const header = spread([{ text: "Permissions", fg: "primary", bold: true }, { text: ` · ${mode}`, fg: mode === "full" ? "warning" : "text" }], [{ text: hints, fg: "muted" }], width)
  const room = Math.max(0, height - 2)
  const listed = (w: number) => input.grants === undefined && !input.grantsError ? [[{ text: "loading grants…", fg: "muted" } as Span]] : input.grantsError ? [[{ text: input.grantsError, fg: "warning" } as Span]] : grantRows({ grants, state, width: w, now, glyphs }).rows
  const grantHeight = compact ? Math.min(8, Math.max(4, grants.length + 3)) : 9
  const grantPanel: GridPanel = { title: "Session grants", body: (w) => {
    const confirm: Line[] = state.confirmAll ? [[{ text: `revoke all ${grants.length} grants? R or y confirms`, fg: "warning" }]] : []
    return [[{ text: `${grants.length} grant${grants.length === 1 ? "" : "s"}`, fg: "muted" }], ...confirm, ...windowRows(listed(w), input.grants ? grantRows({ grants, state, width: w, now, glyphs }).focus : 0, Math.max(1, grantHeight - (compact ? 3 : 5) - confirm.length))]
  } }
  const modePanel: GridPanel = { title: "Mode", body: (w) => modeRows(mode, w, glyphs), weight: 1.2 }
  const policyRows = (w: number): Line[] => {
    const rows: Line[] = [
      [{ text: `Default ${settings.defaultPermission ?? "ask"} · continue on deny ${settings.experimental?.continue_loop_on_deny === true ? "on" : "off"}`, fg: "body" }],
      [{ text: `Primary only: ${settings.experimental?.primary_tools?.join(", ") || "none"}`, fg: "body" }],
    ]
    const config = settings.permission
    const entries = typeof config === "string" ? [["*", config] as const] : Object.entries(config ?? {})
    for (const [permission, rule] of entries) {
      for (const [pattern, action] of typeof rule === "string" ? [["*", rule]] : Object.entries(rule)) rows.push(...wrap(`${permission} ${pattern}: ${action}`, w).map((text): Line => [{ text, fg: action === "deny" ? "error" : action === "allow" ? "success" : "warning" }]))
    }
    for (const [tool, enabled] of Object.entries(settings.tools ?? {})) rows.push([{ text: `tools.${tool}: ${enabled ? "allow" : "deny"}`, fg: enabled ? "success" : "error" }])
    if (!entries.length && !Object.keys(settings.tools ?? {}).length) rows.push([{ text: "No configured tool/path rules", fg: "muted" }])
    return rows
  }
  const rows: GridPanel[][] = compact ? [[grantPanel], [modePanel], [{ title: "Reviewer", body: (w) => reviewerRows(input.reviewer, mode, w, settings.permissionReviewerRole) }], [{ title: "Tool/path policy", body: policyRows }], [{ title: "Smart rules", body: ruleRows }]] : [
    [modePanel, grantPanel],
    [{ title: "Reviewer", body: (w) => reviewerRows(input.reviewer, mode, w, settings.permissionReviewerRole) }, { title: "Tool/path policy", body: policyRows, scroll: state.scroll ?? 0 }],
    [{ title: "Smart rules", body: ruleRows, scroll: state.scroll ?? 0 }],
  ]
  const heights = compact ? undefined : [grantHeight, Math.max(7, Math.floor((room - grantHeight - 2) * 0.5)), Math.max(5, room - grantHeight - Math.max(7, Math.floor((room - grantHeight - 2) * 0.5)) - 2)]
  const body = panelGrid({ rows, width, compact, padding: !compact, ...(heights ? { heights } : {}) })
  const start = compact ? Math.min(state.scroll ?? 0, Math.max(0, body.length - room)) : 0
  return [fit(header, width), fit([{ text: mode === "full" ? "Full access · deny rules still apply" : state.confirmAll ? "Confirm grant revocation" : "─".repeat(width), fg: mode === "full" ? "warning" : "border" }], width), ...Array.from({ length: room }, (_, row) => fit(body[start + row] ?? [], width))]

}

function renderPermissionHistory(input: Parameters<typeof renderPermissionsPage>[0]): Line[] {
  const { width, height, state } = input
  const compact = width < 70
  const reviews = input.history?.reviews ?? []
  const grants = input.history?.grants ?? []
  const selected = clamp(state.historySelected ?? 0, reviews.length)
  const review = reviews[selected]
  const header = spread([{ text: "Permissions · History", fg: "primary", bold: true }], [{ text: compact ? "↑↓ · h grants · ] · esc" : "↑↓ review · h grants · [/] scroll · esc", fg: "muted" }], width)
  const room = Math.max(0, height - 2)
  const tone = (status: string): ColorName => status === "allowed" || status === "active" ? "success" : status === "denied" || status === "revoked" ? "error" : "muted"
  const lines = (text: string, w: number, fg: ColorName = "body"): Line[] => wrap(text, w).map((text) => [{ text, fg }])
  const list: GridPanel = { title: `Reviews · ${reviews.length}`, weight: 0.8, body: (w) => {
    if (input.historyError) return lines(input.historyError, w, "warning")
    if (!input.history) return lines("loading history…", w, "muted")
    if (!reviews.length) return lines("No reviews", w, "muted")
    return windowRows(reviews.map((entry, index) => clip([{ text: index === selected ? "❯ " : "  ", fg: "primary" }, { text: `${entry.status} · ${entry.tool} · ${entry.source}`, fg: tone(entry.status) }], w)), selected, Math.max(1, Math.floor(room * 0.6) - 4))
  } }
  const causal: GridPanel = { title: "Causal authority", weight: 1.2, scroll: compact ? 0 : state.scroll ?? 0, body: (w) => {
    if (!review) return lines(input.historyError || "No review selected", w, "muted")
    const { authority, action, turnId } = review.provenance
    return [
      ...lines(`${review.status} · ${review.source} · ${relativeTime(input.now, review.updatedAt)}`, w, tone(review.status)),
      ...lines(review.reason, w),
      ...lines(`User ${authority.sourceUserIds.join(", ") || "missing"}`, w),
      ...lines(`Turn ${turnId}`, w, "muted"),
      ...lines(`Epoch ${authority.objectiveEpoch} · revision ${authority.contextRevision}`, w, "muted"),
      ...lines(`Authority ${authority.fingerprint.slice(0, 16)} · ${authority.complete ? "complete" : "incomplete"}`, w),
      ...lines(`Action ${action.fingerprint.slice(0, 16)} · ${action.complete ? "complete" : "incomplete"}`, w),
      ...lines(`Cwd ${action.cwd}`, w),
      ...(action.environmentDigest ? lines(`Frozen env ${action.environmentDigest.slice(0, 16)}`, w) : []),
      ...lines([...authority.unknownReasons, ...action.unknownReasons].join(" · "), w, "warning"),
    ]
  } }
  const history: GridPanel = { title: `Grant history · ${grants.length}`, scroll: compact ? 0 : state.scroll ?? 0, body: (w) => grants.length ? grants.flatMap((entry): Line[] => {
    const status = entry.revokedAt !== undefined ? "revoked" : entry.active ? "active" : "inactive"
    return [
      ...lines(`${entry.grant.tool} · ${status} · ${relativeTime(input.now, entry.revokedAt ?? entry.grant.grantedAt)}`, w, tone(status)),
      ...lines(entry.grant.pattern ?? (entry.grant.provenance ? `action ${entry.grant.provenance.action.fingerprint.slice(0, 16)}` : "session scope"), w, "muted"),
    ]
  }) : lines("No grants recorded", w, "muted") }
  const execution: GridPanel = { title: "Execution identity", scroll: compact ? 0 : state.scroll ?? 0, body: (w) => review ? review.provenance.action.executableIdentities.flatMap((text) => lines(text, w)) : lines("No execution selected", w, "muted") }
  const top = Math.max(12, Math.floor((room - 1) * 0.65))
  const body = panelGrid({ rows: compact ? [[list], [causal], [history], [execution]] : [[list, causal], [history, execution]], width, compact: false, padding: true, ...(!compact ? { heights: [top, Math.max(4, room - top - 1)] } : {}) })
  const start = compact ? Math.min(state.scroll ?? 0, Math.max(0, body.length - room)) : 0
  return [fit(header, width), fit([{ text: "─".repeat(width), fg: "border" }], width), ...Array.from({ length: room }, (_, row) => fit(body[start + row] ?? [], width))]
}

/** `count` rows of `rows` that include `focus`, scrolled only as far as needed. */
function windowRows(rows: Line[], focus: number, count: number): Line[] {
  if (rows.length <= count) return rows
  const start = Math.min(Math.max(0, focus - count + 1), rows.length - count)
  return rows.slice(start, start + count)
}
