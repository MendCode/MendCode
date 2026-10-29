import type { SessionDraft, SessionSummary } from "@mendcode/protocol"
import type { ColorName, Span } from "../ui/theme"
import { textWidth, truncateEnd } from "./wrap"

/**
 * How a session is named in a list. A session with a title shows it; one with no title but an unsent draft is a draft
 * (`Draft · fix the retry loop`, or `Draft · 1 image` when only attachments are in it); one with neither keeps the screen's own
 * placeholder. The daemon sends the draft's head with `session.list` and `session.activity` (`SessionDraft`), so every terminal
 * reads the same facts. Tokens (`[Image #1]`) are never part of the words: attachments are counted beside them.
 */
export type SessionLabel = { marker?: string; text: string; placeholder: boolean }

type Labelled = { title: string; draft?: SessionDraft | undefined }

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
  if (!label.marker) return [{ text: truncateEnd(label.text, width), ...style }]
  const lead = `${label.marker} · `
  if (textWidth(lead) >= width) return [{ text: truncateEnd(label.marker, width), fg: "muted", ...bold }]
  return [{ text: lead, fg: "muted", ...bold }, { text: truncateEnd(label.text, width - textWidth(lead)), ...style }]
}

/** The label as one string, for the places that cannot style the marker (the top bar, the terminal title, the palette). */
export const labelString = (label: SessionLabel): string => (label.marker ? `${label.marker} · ${label.text}` : label.text)

/** When the session last had something happen: a draft typed after the last turn is the latest thing in it. */
export const sessionActivityAt = (session: { updatedAt: number; draft?: SessionDraft | undefined }): number => Math.max(session.updatedAt, session.draft?.updatedAt ?? 0)

/** A `session.activity` push says the draft appeared or changed (an object) or went (null); a push without the field leaves it as it was. */
export function withPushedDraft(session: SessionSummary, pushed: SessionDraft | null | undefined): SessionSummary {
  if (pushed === undefined) return session
  const { draft: _old, ...rest } = session
  return pushed === null ? rest : { ...rest, draft: pushed }
}
