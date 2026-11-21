import type { SessionDraft, SessionSummary } from "@mendcode/protocol"
import { WORKFLOW_SESSION_PREFIX } from "@mendcode/protocol/wire"
import type { ColorName, Span } from "../ui/theme"
import { textWidth, truncateEnd } from "./wrap"

/**
 * How a session is named in a list. A session with a title shows it; one with no title but an unsent draft is a draft
 * (`Draft · fix the retry loop`, or `Draft · 1 image` when only attachments are in it); one with neither keeps the screen's own
 * placeholder. The daemon sends the draft's head with `session.list` and `session.activity` (`SessionDraft`), so every terminal
 * reads the same facts. Tokens (`[Image #1]`) are never part of the words: attachments are counted beside them.
 */
export type SessionLabel = { marker?: string; text: string; placeholder: boolean; glyph?: string }

type Labelled = { title: string; draft?: SessionDraft | undefined }

/** The footer's mark for workflows (`◇ 1 workflow`), also on a workflow's row in the sessions list. */
export const WORKFLOW_MARK = "◇"

/**
 * A workflow's own session, known by the title the daemon gives it: `root` is the run itself (an empty chat that only holds its
 * tasks), the others are its tasks and audits. A title the user gave the session wins: it is a session like any other then.
 */
export function workflowOf(session: { title: string; named?: boolean | undefined }): { name: string; root: boolean } | undefined {
  if (session.named || !session.title.startsWith(WORKFLOW_SESSION_PREFIX)) return undefined
  const name = session.title.slice(WORKFLOW_SESSION_PREFIX.length)
  return name ? { name, root: !name.includes(" · ") } : undefined
}

/** A sessions-list row's label: a workflow's session reads `◇ mend-council` (its run's name after the footer's mark); any other as `sessionLabel`. */
export function rowLabel(session: Labelled & { named?: boolean | undefined }, options: { untitled: string; marker: string; ascii?: boolean | undefined }): SessionLabel {
  const workflow = workflowOf(session)
  return workflow ? { glyph: options.ascii ? "*" : WORKFLOW_MARK, text: workflow.name, placeholder: false } : sessionLabel(session, options)
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** `1 image`, `2 images`; `2 attachments` when they are not all images. */
export function attachmentsLabel({ attachments, images }: Pick<SessionDraft, "attachments" | "images">): string {
  return attachments === images ? plural(images, "image") : plural(attachments, "attachment")
}

/** `41 chars`, `1.2k chars`, with what came along: `41 chars, 1 image`; only attachments: `1 image`. */
export function draftSizeLabel({ chars, attachments, images }: Pick<SessionDraft, "chars" | "attachments" | "images">): string {
  const typed = chars >= 1000 ? `${(chars / 1000).toFixed(1).replace(/\.0$/, "")}k chars` : `${chars} chars`
  if (attachments === 0) return typed
  return chars === 0 ? attachmentsLabel({ attachments, images }) : `${typed}, ${attachmentsLabel({ attachments, images })}`
}

/** What the draft says in a list row: its first line, else what it holds. */
export const draftText = (draft: SessionDraft): string => draft.preview || attachmentsLabel(draft)

/** `marker` is how the screen writes it (`Draft` where the placeholder is `Untitled session`, `draft` where it is `untitled`). */
export function sessionLabel(session: Labelled, options: { untitled: string; marker: string }): SessionLabel {
  if (session.title.trim()) return { text: session.title, placeholder: false }
  if (session.draft) return { marker: options.marker, text: draftText(session.draft), placeholder: false }
  return { text: options.untitled, placeholder: true }
}

/** The label as spans fitting `width` cells: a muted marker (`Draft · `), then the words in `style`; the words give way first. */
export function labelSpans(label: SessionLabel, width: number, style: { fg: ColorName; bold?: boolean }): Span[] {
  const bold = style.bold ? { bold: true } : {}
  if (label.glyph) {
    const lead = `${label.glyph} `
    if (textWidth(lead) >= width) return [{ text: truncateEnd(label.text, width), ...style }]
    return [{ text: lead, fg: "secondary" }, { text: truncateEnd(label.text, width - textWidth(lead)), ...style }]
  }
  if (!label.marker) return [{ text: truncateEnd(label.text, width), ...style }]
  const lead = `${label.marker} · `
  if (textWidth(lead) >= width) return [{ text: truncateEnd(label.marker, width), fg: "muted", ...bold }]
  return [{ text: lead, fg: "muted", ...bold }, { text: truncateEnd(label.text, width - textWidth(lead)), ...style }]
}

/** The label as one string, for the places that cannot style the marker (the top bar, the terminal title, the palette). */
export const labelString = (label: SessionLabel): string => (label.marker ? `${label.marker} · ${label.text}` : label.text)

/**
 * When the session last had conversation: the age every list shows and orders by. An unsent draft is not activity (saving one on
 * leaving a chat, or typing in the one just opened, must not lift it up the list), the same way t3code orders threads by the latest
 * message, never by what is being typed.
 */
export const sessionActivityAt = (session: { updatedAt: number }): number => session.updatedAt

/** A `session.activity` push says the draft appeared or changed (an object) or went (null); a push without the field leaves it as it was. */
export function withPushedDraft(session: SessionSummary, pushed: SessionDraft | null | undefined): SessionSummary {
  if (pushed === undefined) return session
  const { draft: _old, ...rest } = session
  return pushed === null ? rest : { ...rest, draft: pushed }
}
