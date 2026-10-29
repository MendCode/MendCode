import type { AssistantMessageModel, ReasoningModel, UserMessageModel } from "@mendcode/extension-api/views"
import type { Glyphs, Line } from "../ui/theme"
import { messageRows, outsideText, reasoningBlock, shellUserBlock, truncateMessage, userBlock, type Attachment } from "./chat-blocks"
import { renderMarkdown, wrapSpans, type MarkdownStyle } from "./markdown"
import { fit } from "./deck"
import { carryMeta } from "./line-meta"
import { textWidth } from "./wrap"
import { sentRows } from "./reply-comments-sent"

/**
 * The built-in renderers of `message.user`, `message.assistant` and `message.reasoning` as pure functions of their input
 * model (docs/views.md). The transcript builds the model from a block and draws it through the view host, so a custom view
 * and the default look receive exactly the same data.
 */

const INDENT = "  "
type Sized<M> = M & { width: number }

/** `› ` / `• ` lead and the text rows of a quiet message; the first row carries the lead, the rest are aligned under it. */
function quietRows(role: "user" | "assistant", style: UserMessageModel["style"], width: number, text: string, rows: (room: number) => Line[]): Line[] {
  const prefix = [style.icon, style.lead, style.label].filter(Boolean).join(" ")
  const lead = prefix ? `${prefix} ` : ""
  const body = rows(Math.max(1, width - textWidth(lead)))
  while (body.length && !body.at(-1)!.some((span) => span.text.trim())) body.pop()
  if (!body.length) body.push([])
  return body.map((row, i): Line => {
    const spans: Line = carryMeta(row, [{ text: i === 0 ? lead : " ".repeat(textWidth(lead)), fg: role === "user" ? "primary" : "muted" }, ...row], textWidth(lead))
    return style.tint ? carryMeta(spans, fit(spans, width).map((span) => ({ ...span, bg: span.bg ?? "promptBg" }))) : spans
  })
}

export function userRows(m: Sized<UserMessageModel>, g: Glyphs): Line[] {
  const { width, style } = m
  if (m.variant === "notice") {
    // The first line says what happened; the output tail it carries is for the agent, shown only in full view.
    const [head = "", ...rest] = m.text.split("\n")
    const lines = wrapSpans([{ text: head, fg: "muted" }], width, [{ text: `${g.tool} `, fg: "muted" }])
    if (m.mode === "full") for (const line of rest) lines.push(...wrapSpans([{ text: line, fg: "muted", dim: true }], width, [{ text: INDENT }]))
    return lines
  }
  if (m.variant === "shell") {
    if (m.mode === "minimal") return wrapSpans([{ text: `$ ${m.text}`, fg: "primary", bold: true }, ...(m.local ? [{ text: "  local", fg: "muted" as const }] : [])], width, [{ text: INDENT }])
    return shellUserBlock({ command: m.text, time: m.time, width, ...(m.local ? { local: true } : {}) })
  }
  // A set of comments on an answer: the typed message, then the numbered quote and comment pairs; ctrl+o opens the quotes (docs/editor.md).
  if (m.comments) return sentRows({ parsed: m.comments, width, style, expanded: m.expanded }, g)
  if (style.layout !== "classic") {
    const shortened = m.expanded ? { text: m.text, hiddenChars: 0 } : truncateMessage(m.text)
    const attachments: Attachment[] = m.attachments ? [...m.attachments] : []
    const rows = quietRows("user", style, width, shortened.text, (room) => attachments.some((file) => file.label) || shortened.text.includes("\n\n[attached file: ") ? messageRows(shortened.text, attachments, room, []) : shortened.text.split("\n").flatMap((line) => wrapSpans([{ text: line, fg: "text" }], room)))
    if (shortened.hiddenChars) rows.push([{ text: `  ▸ ${shortened.hiddenChars} more characters · ctrl-o`, fg: "muted" }])
    for (const file of outsideText(attachments, shortened.text)) rows.push([{ text: `  ■ ${file.name ?? file.mime}`, fg: "muted" }])
    return m.time ? [[{ text: m.time, fg: "muted" }], ...rows] : rows
  }
  if (m.mode === "minimal") {
    const lines = wrapSpans([{ text: m.text, fg: "text", bold: true }], width, [{ text: `${g.user} `, fg: "primary", bold: true }])
    if (m.images) lines.push([{ text: INDENT }, { text: `■ ${m.images} image${m.images === 1 ? "" : "s"}`, fg: "muted" }])
    return lines
  }
  const attachments: Attachment[] = m.attachments ? [...m.attachments] : Array.from({ length: m.images }, (): Attachment => ({ mime: "image/*" }))
  const rows = userBlock({ header: [{ text: INDENT }, { text: [style.icon, style.lead].filter(Boolean).join(" "), fg: "primary" }, ...(style.label ? [{ text: ` ${style.label}`, fg: "muted" as const }] : [])], text: m.text, time: m.time, username: m.username, attachments, width, expanded: m.expanded, glyphs: g })
  return style.tint ? rows.map((row) => fit(row, width).map((span) => ({ ...span, bg: span.bg ?? "promptBg" }))) : rows
}

/** The message text as rows `room` cells wide: Markdown (as the renderer allows), or the plain text wrapped. No lead, no time. */
export function assistantBody(m: AssistantMessageModel, room: number): Line[] {
  if (m.renderer === "plain") return m.text.split("\n").flatMap((line) => wrapSpans([{ text: line, fg: "text" }], room))
  const source = m.renderer === "markdown" ? m.text.replace(/^```mermaid\s*$/gm, "```text") : m.text
  // A block the reader folded or opened on its own keeps that state; ctrl+o opens the rest.
  return renderMarkdown(source, room, "body", { detailsOpen: (ordinal: number) => m.details[ordinal] ?? (m.detailsAll ? true : undefined), style: m.markdown as MarkdownStyle })
}

export function assistantRows(m: Sized<AssistantMessageModel>): Line[] {
  const { width, style } = m
  const markdown = m.renderer !== "plain"
  const source = m.renderer === "markdown" ? m.text.replace(/^```mermaid\s*$/gm, "```text") : m.text
  if (style.layout !== "classic") {
    const rows = quietRows("assistant", style, width, m.text, (room) => assistantBody(m, room))
    return m.time ? [[{ text: m.time, fg: "muted" }], ...rows] : rows
  }
  // v1's assistant text sits one column right of its reasoning rail (paddingLeft 3 vs 2).
  const header = [style.icon, style.lead, style.label].filter(Boolean).join(" ")
  const pad = m.mode === "minimal" ? INDENT : `${INDENT} `
  const rows = (markdown ? renderMarkdown(source, width - pad.length, "body", { style: m.markdown as MarkdownStyle }) : m.text.split("\n").flatMap((line) => wrapSpans([{ text: line, fg: "text" }], width - pad.length))).map((line) => carryMeta(line, [{ text: pad }, ...line], pad.length))
  if (header) rows.unshift([{ text: `${pad}${header}`, fg: "muted" }])
  return m.time ? [[{ text: pad }, { text: m.time, fg: "muted" }], ...rows] : rows
}

export function reasoningRows(m: Sized<ReasoningModel>, g: Glyphs): Line[] {
  if (m.hidden) return []
  return reasoningBlock({ text: m.text, running: m.running, ...(m.ms !== undefined ? { ms: m.ms } : {}), width: m.width, rows: m.rows, glyphs: g, oneLine: m.oneLine })
}
