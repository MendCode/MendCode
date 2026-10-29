import type { PromptFrameModel, ViewModels } from "@mendcode/extension-api/views"
import type { QuestionInfo, RenderNode } from "@mendcode/protocol"
import type { Glyphs, Line } from "../ui/theme"
import { fit, lineWidth } from "./deck"
import { homeVisibleSessions, renderHome, type HomeInput } from "./home"
import { assistantRows, reasoningRows, userRows } from "./message-views"
import { compactionRows, toolRows, turnStatusRows } from "./transcript-views"
import { promptFrame, renderStatusRow, withoutMargin, type PromptFrame, type StatusRowInput } from "./prompt-chrome"
import { renderQueuePanel } from "./queue-panel"
import { approvalOptionRows, renderApprovalPanel, type ApprovalChoice, type PanelRows } from "./request-panel"
import { questionAnswerBlock, renderQuestionBatch, type QuestionCard, type QuestionDraft, type QuestionField } from "./question-batch"
import { renderSessionSidebar, SIDEBAR_WIDTH } from "./sidebar"
import { renderSlashMenu } from "./slash-menu"
import type { StatusInput } from "./status-page"
// Loaded on first use: the status page is a lazy page module and stays out of the startup graph (test/footprint.test.ts).
import { renderFileViewer, renderStatusPage } from "../ui/lazy-pages"
import { renderToast, renderToastRow } from "./toast"
import { renderToolCard, type ToolCardInput } from "./tool-card"
import { renderLimitBar, type UsageLimitView } from "./usage-limit"
import { renderTopbar, type TopbarInput } from "./topbar"
import { wrapSpans } from "./markdown"
import { textWidth } from "./wrap"
import type { ViewHit } from "./views"

/**
 * The built-in renderer of every view slot. Each one is a function of the slot's input model (`@mendcode/extension-api/views`),
 * the same data a custom view receives, plus `width`/`height`/`ascii`/`now` and `extra`: terminal-side values that are not
 * data (the legacy `renderTool` hook, extension footer rows) and never reach a custom view.
 */

export type BuiltinInput<S extends keyof ViewModels> = ViewModels[S] & { width: number; height: number; ascii: boolean; now: number; extra?: Record<string, unknown> }
export type BuiltinResult = Line[] | { lines: Line[]; hits?: ViewHit[] }
export type FrameParts = { top: Line[]; bottom: Line[]; left: Line; right: Line }

const rowHits = (hits: ReadonlyArray<{ row: number; index: number; from?: number; to?: number }>, action: string, width: number): ViewHit[] =>
  hits.map((hit) => ({ row: hit.row, from: hit.from ?? 0, to: hit.to ?? width, action, arg: hit.index }))

/**
 * The Agent View rows of the home are clickable: each listed session's first row opens it. The rows are found in the drawn
 * lines by the head of the session's title (the layout clips and centers rows, so there is no stable geometry to compute),
 * in the order the panel lists them, below its header.
 */
function homeHits(lines: Line[], sessions: BuiltinInput<"home">["sessions"]): ViewHit[] {
  const listed = homeVisibleSessions(sessions.map((session) => ({ ...session }) as never)).filter((session) => session.id)
  const texts = lines.map((line) => line.map((span) => span.text).join(""))
  let row = Math.max(0, texts.findIndex((text) => text.includes("Agent View")) + 1)
  const hits: ViewHit[] = []
  for (const session of listed) {
    const needle = session.title.slice(0, Math.min(8, session.title.length))
    const at = texts.findIndex((text, index) => index >= row && needle !== "" && text.includes(needle))
    if (at < 0) continue
    const from = Math.max(0, textWidth(texts[at]!.slice(0, texts[at]!.indexOf(needle))) - 2)
    hits.push({ row: at, from, to: lines[at] ? Math.max(from + 1, lineWidth(lines[at]!)) : from + 1, action: "open", arg: session.id! })
    row = at + 1
  }
  return hits
}

/** The minimal view's one-line approval: title, detail, and the keys in a row. */
function approvalInline(m: BuiltinInput<"approval">, g: Glyphs): Line[] {
  return [[{ text: `${g.ask} `, fg: "warning", bold: true }, { text: m.title, fg: "warning", bold: true }], ...m.detail.map((line) => [...line] as Line), ...approvalInlineKeys(m)]
}

/** The key row of the minimal view's approval: what each key does. Not clickable. */
function approvalInlineKeys(m: Pick<BuiltinInput<"approval">, "width" | "plan">): Line[] {
  const { width } = m
  return wrapSpans([
    { text: "  [a] ", fg: "primary", bold: true },
    { text: m.plan ? "approve & build   " : "approve   ", fg: "muted" },
    ...(m.plan ? [{ text: "[e] ", fg: "primary" as const, bold: true }, { text: "edit   ", fg: "muted" as const }, { text: "[c] ", fg: "primary" as const, bold: true }, { text: "comment   ", fg: "muted" as const }] : [{ text: "[s] ", fg: "primary" as const, bold: true }, { text: "for this session   ", fg: "muted" as const }]),
    { text: "[d] ", fg: "error", bold: true },
    { text: m.plan ? "reject   " : "deny   ", fg: "muted" },
    ...(m.plan ? [] : [{ text: "[?] ", fg: "primary" as const, bold: true }, { text: "explain   ", fg: "muted" as const }]),
    ...(width >= 84 ? [{ text: "or type what to do instead", fg: "muted" as const, dim: true }] : []),
  ], width)
}

/**
 * The part of an `approval` or `question` prompt the terminal always draws itself, even under a custom view: the real options with
 * their label, key and click action. A custom view restyles everything around it and may place it with a `{options}` row (docs/views.md).
 * A batch of questions is one interactive panel (tabs, answers, review), so the terminal owns all of it.
 */
export type HostBlock = { rows: Line[]; hits: ViewHit[] }
export const HOST_BLOCKS: { [S in "approval" | "question"]: (input: BuiltinInput<S>) => HostBlock } = {
  approval: (m) => {
    if (m.variant === "inline") return { rows: approvalInlineKeys(m), hits: [] }
    const options = approvalOptionRows({ width: m.width, choices: m.options as readonly ApprovalChoice[], choice: m.choice })
    return { rows: options.rows, hits: rowHits(options.hits, "choose", m.width) }
  },
  question: (m) => {
    // A batch is one panel the terminal draws whole; a single question's block is its answers (a custom view draws the rest).
    const { questions, draft, field } = questionInput(m)
    const card = m.variant === "batch" ? renderQuestionBatch({ width: m.width, height: m.height, questions, draft, field, ascii: m.ascii }) : questionAnswerBlock({ width: m.width, question: questions[0]!, draft, field, ascii: m.ascii })
    return { rows: card.rows, hits: questionHits(card, m.width) }
  },
}

/** The questions and the draft a `question` input stands for: a single question is a batch of one (its model may carry neither). */
function questionInput(m: BuiltinInput<"question">): { questions: readonly QuestionInfo[]; draft: QuestionDraft; field: QuestionField | undefined } {
  const questions = (m.questions ?? [{ header: m.title, question: m.detail.trim() || m.title, options: m.options, ...(m.multiple ? { multiple: true } : {}) }]) as unknown as readonly QuestionInfo[]
  // The draft is the terminal's own object (the review clamps its scroll), not a copy.
  const draft = (m.draft ?? { tab: 0, choice: m.choice, answers: [m.picked.flatMap((index) => (m.options[index] ? [m.options[index]!.label] : []))], custom: [], editing: m.typing, scroll: 0 }) as unknown as QuestionDraft
  return { questions, draft, field: m.extra?.field as QuestionField | undefined }
}

/** The card's click regions (`tab` for a tab, `choose` for an answer) and its caret as a `cursor` region the terminal reads back. */
function questionHits(card: QuestionCard, width: number): ViewHit[] {
  const hits: ViewHit[] = card.hits.map((hit) => ({ row: hit.row, from: hit.from ?? 0, to: hit.to ?? width, action: hit.index < 0 ? "tab" : "choose", arg: hit.index < 0 ? -hit.index - 1 : hit.index }))
  return card.cursor ? [...hits, { row: card.cursor.row, from: card.cursor.col, to: card.cursor.col, action: "cursor" }] : hits
}

const panel =(rows: PanelRows, action: string, width: number): BuiltinResult => ({ lines: rows.rows, hits: rowHits(rows.hits, action, width) })

export const BUILTIN_VIEWS: { [S in Exclude<keyof ViewModels, "prompt.frame">]: (input: BuiltinInput<S>, glyphs: Glyphs) => BuiltinResult } = {
  "message.user": (m, g) => userRows(m, g),
  "message.assistant": (m) => assistantRows(m),
  "message.reasoning": (m, g) => reasoningRows(m, g),
  "tool.card": (m) => renderToolCard({
    title: m.title,
    text: m.text,
    status: m.status,
    width: m.width,
    expanded: m.expanded,
    level: m.level,
    page: m.page,
    counts: m.counts,
    frame: m.frame,
    tailLines: m.tailLines,
    ...(m.pattern ? { pattern: m.pattern } : {}),
    ...(m.agent ? { agent: m.agent } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.written ? { written: m.written } : {}),
    ...(m.meta ? { meta: m.meta } : {}),
    ...(m.compact ? { compact: true } : {}),
    ...(m.density ? { density: m.density } : {}),
    ...(m.summary ? { summary: m.summary } : {}),
    ...(m.render ? { render: m.render as unknown as RenderNode, ...(m.mapDetail ? { mapDetail: m.mapDetail } : {}) } : {}),
    ...(m.elapsedMs !== undefined ? { elapsedMs: m.elapsedMs } : {}),
    ...(m.exitCode !== undefined ? { exitCode: m.exitCode } : {}),
    ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
    ...(m.run?.length ? { run: m.run as import("../ui/theme").Span[] } : {}),
    ...(m.awaiting ? { awaiting: true } : {}),
    ...(m.extra?.custom ? { custom: m.extra.custom as NonNullable<ToolCardInput["custom"]> } : {}),
    ...(m.extra?.imageWait ? { imageWait: m.extra.imageWait as NonNullable<ToolCardInput["imageWait"]> } : {}),
    ...(m.extra?.splitDiff === true ? { splitDiff: true } : {}),
  }),
  "tool.row": (m, g) => toolRows(m, g),
  "compaction.card": (m) => compactionRows(m),
  "turn.status": (m, g) => turnStatusRows(m, g),
  approval: (m, g) => {
    if (m.variant === "inline") return approvalInline(m, g)
    const request = { requestId: m.requestId, title: m.title, detail: m.subject, ...(m.tool ? { tool: m.tool } : {}), ...(m.permission ? { permission: m.permission } : {}) }
    return panel(renderApprovalPanel({ width: m.width, request, detail: m.detail.map((line) => [...line] as Line), choice: m.choice, hint: m.hint, choices: m.options as readonly ApprovalChoice[], ...(m.explain ? { explain: m.explain.map((line) => [...line] as Line) } : {}) }), "choose", m.width)
  },
  question: (m) => {
    const { questions, draft, field } = questionInput(m)
    const card = renderQuestionBatch({ width: m.width, height: m.height, questions, draft, field, ascii: m.ascii })
    return { lines: card.rows, hits: questionHits(card, m.width) }
  },
  topbar: (m) => [renderTopbar({ ...(m as unknown as TopbarInput), width: m.width })],
  "sessions.sidebar": (m) => {
    const side = renderSessionSidebar({ sessions: m.sessions as never, current: m.current, ...(m.selected ? { selected: m.selected } : {}), focused: m.focused, height: m.height, now: m.now, ...(m.extra?.header === false ? { header: false } : {}) })
    return { lines: side.rows, hits: side.hits.map((hit) => ({ row: hit.row, from: 0, to: SIDEBAR_WIDTH, action: "open", arg: hit.sessionId })) }
  },
  notice: (m, g) => {
    if (m.kind === "toast" && m.inline) return [renderToastRow({ variant: m.variant, ...(m.title ? { title: m.title } : {}), message: m.message, ...(m.hint ? { hint: m.hint } : {}) }, m.width, 2)]
    if (m.kind === "toast") return renderToast({ variant: m.variant, ...(m.title ? { title: m.title } : {}), message: m.message, ...(m.hint ? { hint: m.hint } : {}) }, m.width)
    if (m.kind === "limit") {
      const bar = renderLimitBar({ width: m.width, view: m.view as UsageLimitView, now: m.now, glyphs: g })
      return { lines: bar.rows, hits: bar.chips.map((chip) => ({ row: chip.row, from: chip.from, to: chip.to, action: chip.action })) }
    }
    const queue = renderQueuePanel({ width: m.width, previews: m.previews, delivery: m.delivery, held: m.held, paused: m.paused, ...(m.mode ? { mode: m.mode as never } : {}), shell: new Set(m.shell), notices: new Set(m.notices ?? []) })
    return { lines: queue.rows, hits: queue.sendChip ? [{ row: queue.sendChip.row, from: queue.sendChip.from, to: queue.sendChip.to, action: "send" }] : [] }
  },
  footer: (m) => {
    const { extraRows, ...first } = m
    const ext = m.extra?.ext as StatusRowInput["ext"]
    const rowExt = (m.extra?.rows ?? []) as Array<StatusRowInput["ext"]>
    const head = renderStatusRow({ ...(first as unknown as StatusRowInput), width: m.width, ...(ext ? { ext } : {}) })
    const rest = extraRows.map((row, index) => renderStatusRow({ width: m.width, loops: 0, ...(m.separator !== undefined ? { separator: m.separator } : {}), scriptLeftRow: row.scriptLeftRow, scriptRightRow: row.scriptRightRow, ...(rowExt[index] ? { ext: rowExt[index] } : {}) }))
    return [head, ...rest]
  },
  home: (m) => {
    const lines = renderHome({ ...(m as unknown as HomeInput), width: m.width, height: m.height, now: m.now, ...(m.extra?.below ? { below: m.extra.below as Line[] } : {}), ...(m.extra?.mascot ? { mascot: m.extra.mascot as NonNullable<HomeInput["mascot"]> } : {}) })
    return { lines, hits: homeHits(lines, m.sessions) }
  },
  "panel.widget": (m) => m.body.map((line) => [...line] as Line),
  // The viewer module is loaded when a file is opened (it cannot be drawn before), so the startup graph never holds it.
  "file.viewer": (m) => renderFileViewer(m),
  page: (m) => m.body.map((line) => [...line] as Line),
  overlay: (m) => m.rows.map((line) => [...line] as Line),
  bar: (m) => m.rows.map((line) => [...line] as Line),
  "slash.menu": (m) => renderSlashMenu({ ...m, width: m.width, height: m.height, ascii: m.ascii }),
  "page.status": (m) => renderStatusPage({ ...(m as unknown as StatusInput), state: (m.extra?.state ?? { scroll: m.scroll }) as StatusInput["state"], width: m.width, height: m.height }),
}

/** Prompt frame: the preset's rules or box, or the parts a custom view returned. */
export const builtinFrame = {
  builtin(model: PromptFrameModel & { rich: boolean }, at: { width: number; glyphs: Glyphs }): PromptFrame {
    return promptFrame({ preset: model.preset, width: at.width, glyphs: at.glyphs, rich: model.rich, lead: model.lead, border: model.border, borders: model.borders })
  },
  /** A custom frame: its rows above and below, and the cells around each prompt row (the row's own margin is replaced by `left`). */
  fromParts(parts: FrameParts, at: { width: number; lead: string; rich: boolean }): PromptFrame {
    const room = Math.max(0, at.width - lineWidth(parts.left) - lineWidth(parts.right))
    return {
      top: parts.top,
      bottom: parts.bottom,
      row: (line) => [...parts.left, ...fit(withoutMargin(line), room), ...parts.right],
      inset: lineWidth(parts.left) + textWidth(at.lead) + 1,
    }
  },
}
