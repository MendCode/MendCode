/**
 * Comments on passages of the assistant's answer: the pure model behind the chips. A comment is a quoted passage plus the user's
 * words; several of them travel in ONE user message that stays one input in the TUI. This file owns the wire format the model
 * receives (`buildCommentMessage`, and `parseCommentMessage` for the transcript to fold it again), the form comments take inside the
 * saved draft (`buildCommentDraft`, `parseCommentDraft`: the same envelope with a few more attributes, so no protocol field is
 * needed and an older daemon or client stores and restores it as text), the walk over an answer's units for the keyboard-only reply
 * mode (`replyUnits`) and how a quote is found again in drawn rows (`locateQuote`), which keeps the gutter marks honest after a
 * resize and drops them after a compaction.
 */

/** Most comments held at once: the gutter mark and the chip number are one digit. The `commentMax` setting may only lower it. */
export const MAX_COMMENTS = 9
/** One quote is cut here (the wire says by how much); a longer passage is a selection that was not meant as a quote. */
export const MAX_QUOTE_CHARS = 2000
/** One comment's own words. */
export const MAX_COMMENT_CHARS = 2000
/** Room under the protocol's inline text limit (64 KiB) for the rest of the message; the same budget the review message keeps. */
export const MAX_MESSAGE_CHARS = 60_000
/** The most the envelope wording settings may hold (the profile validates the same bound). */
export const MAX_WORDING_CHARS = 1200

export type ReplyComment = {
  /** Stable while the comment lives: the chip number is its position, this is what survives a reorder. */
  id: number
  /** The passage as the terminal copies it today (`bodyText`): plain, wrapped lines rejoined. */
  quote: string
  text: string
  /** The assistant message the passage came from; absent once the message is gone (a compaction) and the quote is all that is left. */
  itemId?: string
  /** Added by code (an extension), about something that is not an answer (a diff hunk, a file): the wire says `context`, never `earlier answer`. */
  other?: true
}

export const TAG = "mendcode_comments"
export const PREFACE = "Comments on your answer. Each <comment> has a verbatim <quote> and my comment on it: answer each by number. A <note> is general."

/** The envelope and entry templates the built-in wording is made of. Placeholders are `{name}`; everything else is literal text. */
export const DEFAULT_ENVELOPE = `<${TAG} count="{count}">\n${PREFACE}\n\n{comments}\n{note}\n</${TAG}>`
export const DEFAULT_ENTRY = '<comment n="{n}" of="{of}">\n<quote{cut}>\n{quote}\n</quote>\n{text}\n</comment>'
/** What each placeholder is, for the settings page and the docs. */
export const ENVELOPE_PLACEHOLDERS = { count: "how many comments", comments: "every comment, one entry template each (required)", note: "the general text as a <note> block, or nothing", note_text: "the general text alone" } as const
export const ENTRY_PLACEHOLDERS = { n: "the comment's number", of: "last answer, earlier answer, or context (added by an extension)", quote: "the verbatim passage inside a fence no line of it can close (required)", cut: ' ` cut="N"` when the quote was cut, else nothing', text: "the user's words (required)" } as const

/** A fence for `text` that no line of it can close: backticks, one more than the longest run inside (three at least). */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  return "`".repeat(Math.max(3, longest + 1))
}

const FORMAT_TAGS = ["comment", "note", "quote", TAG]
const tagPattern = (names: readonly string[]) => new RegExp(`<(/?)(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "gi")
const FORMAT_PATTERN = tagPattern(FORMAT_TAGS)
const UNESCAPE_PATTERN = /<(\/?)\\(comment|note|quote|mendcode_comments)(?![\w-])/gi

/** The tag names a template writes, so words typed by the user cannot close any of them either. */
export const tagsOf = (...templates: readonly string[]): string[] => [...new Set(templates.flatMap((template) => [...template.matchAll(/<\/?([A-Za-z][\w:-]*)/g)].map((match) => match[1]!.toLowerCase())))]

/**
 * The user's own words with every tag of the format defused (`</comment>` becomes `</\comment>`), so nothing typed can close a block
 * early. `extra` adds the tags of a custom wording; matching ignores case.
 */
export function escapeTags(text: string, extra: readonly string[] = []): string {
  const names = [...new Set([...FORMAT_TAGS, ...extra.map((name) => name.toLowerCase())])]
  return text.replace(names.length === FORMAT_TAGS.length ? FORMAT_PATTERN : tagPattern(names), (_all, slash: string, name: string) => `<${slash}\\${name}`)
}
const unescapeTags = (text: string) => text.replace(UNESCAPE_PATTERN, "<$1$2")

const clean = (text: string) => text.replace(/\r\n?/g, "\n").trim()

/** `quote` cut to the limit, and how many characters that dropped. */
export function cutQuote(quote: string): { text: string; cut: number } {
  const text = clean(quote)
  return text.length > MAX_QUOTE_CHARS ? { text: text.slice(0, MAX_QUOTE_CHARS).trimEnd(), cut: text.length - MAX_QUOTE_CHARS } : { text, cut: 0 }
}

/** The words a comment may hold: a bound, and control characters other than a line break dropped. */
export const commentText = (text: string) => clean(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, MAX_COMMENT_CHARS)

/** The wording a user may replace. Empty or undefined is the built-in one. */
export type CommentWording = { envelope?: string | undefined; entry?: string | undefined }

/** A setting holds one line: `\n` in it is a line break in the template. */
export const expandBreaks = (template: string) => template.replace(/\\n/g, "\n")

/** What is wrong with a wording, in the words of the settings page; empty when it can be used. */
export function wordingProblems({ envelope, entry }: CommentWording): string[] {
  const problems: string[] = []
  const check = (name: string, template: string | undefined, required: readonly string[]) => {
    if (!template) return
    if (template.length > MAX_WORDING_CHARS) problems.push(`${name}: at most ${MAX_WORDING_CHARS} characters`)
    if (/[\x00-\x08\x0b-\x1f\x7f\x1b]/.test(template)) problems.push(`${name}: no control characters`)
    for (const token of required) if (!template.includes(`{${token}}`)) problems.push(`${name}: needs {${token}}`)
  }
  check("template", envelope, ["comments"])
  check("entry", entry, ["quote", "text"])
  return problems
}

/** The built-in wording where a custom one is missing or unusable. */
export function usableWording(wording: CommentWording | undefined): { envelope: string; entry: string } {
  const problems = wording ? wordingProblems(wording) : []
  const envelope = wording?.envelope && !problems.some((problem) => problem.startsWith("template")) ? expandBreaks(wording.envelope) : DEFAULT_ENVELOPE
  const entry = wording?.entry && !problems.some((problem) => problem.startsWith("entry")) ? expandBreaks(wording.entry) : DEFAULT_ENTRY
  return { envelope, entry }
}

/** One pass over `template`: each `{name}` is replaced by its value, and a value is never read again, so nothing typed can add a placeholder. */
const fill = (template: string, values: Readonly<Record<string, string>>) => template.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all)

/** The entry the saved draft uses: the wire's, plus the message the comment is on. */
const DRAFT_ENTRY = DEFAULT_ENTRY.replace('of="{of}">', 'of="{of}"{item}>')

type Built = { quote: string; cut: number; text: string; of: string; item?: string | undefined }

function entryText(template: string, tags: readonly string[], n: number, comment: Built): string {
  const fence = fenceFor(comment.quote)
  return fill(template, { n: String(n), of: comment.of, quote: `${fence}\n${comment.quote}\n${fence}`, cut: comment.cut ? ` cut="${comment.cut}"` : "", text: escapeTags(comment.text, tags), item: comment.item ? ` item="${comment.item.replace(/[^\w.:-]/g, "")}"` : "" })
}

export const CONTEXT_OF = "context"
const ofOf = (comment: ReplyComment, lastItemId: string | undefined) => (comment.other ? CONTEXT_OF : comment.itemId !== undefined && comment.itemId === lastItemId ? "last answer" : "earlier answer")

function prepared(comment: ReplyComment, lastItemId: string | undefined): Built {
  const quote = cutQuote(comment.quote)
  // A comment with no message left (a compaction took it) is certainly not on the newest answer.
  return { quote: quote.text, cut: quote.cut, text: commentText(comment.text), of: ofOf(comment, lastItemId), ...(comment.itemId !== undefined ? { item: comment.itemId } : {}) }
}

/**
 * The one message a send produces: every comment as its own block (a verbatim quote inside a fence longer than anything in it, then the
 * comment), the general text last. `lastItemId` is the newest assistant message: a comment on an older one says so, since a model that
 * is shown "your answer" would otherwise look for the passage in the wrong place. `wording` replaces the built-in envelope or entry
 * template (an unusable one is ignored). Empty when there is nothing to send.
 */
export function buildCommentMessage({ comments, general = "", lastItemId, wording }: { comments: readonly ReplyComment[]; general?: string; lastItemId?: string | undefined; wording?: CommentWording | undefined }): string {
  const note = clean(general)
  if (comments.length === 0) return note
  const { envelope, entry } = usableWording(wording)
  const tags = tagsOf(envelope, entry)
  const body = comments.map((comment, index) => entryText(entry, tags, index + 1, prepared(comment, lastItemId))).join("\n")
  const escaped = escapeTags(note, tags)
  // A placeholder line with nothing to say leaves no empty line behind.
  const shown = envelope.split("\n").filter((line) => note || !/^\{(note|note_text)\}$/.test(line.trim())).join("\n")
  return fill(shown, { count: String(comments.length), comments: body, note: note ? `<note>\n${escaped}\n</note>` : "", note_text: escaped })
}

/**
 * The comments and the draft as the saved draft keeps them: the wire format with `draft="1"` on the envelope, each comment's message
 * (`item`) and, when they were set aside with ctrl+c, `parked="1"`. Fixed wording, whatever the settings say. The note is cut first when
 * the whole would not fit the draft's limit, so the closing tags always survive.
 */
export function buildCommentDraft({ comments, draft, parked, lastItemId, limit }: { comments: readonly ReplyComment[]; draft: string; parked: boolean; lastItemId?: string | undefined; limit: number }): string {
  if (comments.length === 0) return draft
  const blocks = comments.map((comment, index) => entryText(DRAFT_ENTRY, FORMAT_TAGS, index + 1, prepared(comment, lastItemId)))
  const open = `<${TAG} count="${comments.length}" draft="1"${parked ? ' parked="1"' : ""}>`
  const close = `</${TAG}>`
  const fixed = [open, ...blocks, close].join("\n").length + "\n<note>\n\n</note>".length
  const assemble = (room: number) => [open, ...blocks, ...(draft.trim() ? ["<note>", escapeTags(draft.slice(0, room)), "</note>"] : []), close].join("\n")
  let room = Math.max(0, limit - fixed)
  let out = assemble(room)
  // Escaping adds a backslash per defused tag: cut a little more until the whole fits.
  for (let pass = 0; pass < 3 && out.length > limit; pass++) {
    room = Math.max(0, room - (out.length - limit))
    out = assemble(room)
  }
  return out
}

export type ParsedComment = { n: number; of: string; quote: string; cut: number; text: string; item?: string }
export type ParsedComments = { comments: ParsedComment[]; note: string; /** Text before and after the envelope in the same message (an editor selection, a pasted file): shown as it is. */ head?: string; tail?: string; /** Only a draft: the comments were set aside with ctrl+c. */ parked?: boolean; draft?: boolean }

/** How the built-in draws a sent set (the `commentSentLayout` and `commentCollapse` settings), carried on the view model with the parts. */
export type SentLook = { layout: "stack" | "rail" | "inline"; collapse: number }

/** The envelope's parts in the form a view model carries them (readonly), or nothing when `text` is not one. */
export const commentsOf = (text: string, look?: SentLook): { comments?: ParsedComments & Partial<SentLook> } => {
  const comments = parseCommentMessage(text)
  return comments ? { comments: look ? { ...comments, ...look } : comments } : {}
}

/** The inverse of `buildCommentMessage`; undefined for any text that is not one (the transcript then draws it as an ordinary message). */
export function parseCommentMessage(message: string): ParsedComments | undefined {
  const all = message.replace(/\r\n?/g, "\n").split("\n")
  const start = all.findIndex((line) => /^<mendcode_comments(?: [^<>\n]*)?>$/.test(line))
  if (start < 0) return undefined
  const lines = all.slice(start)
  const comments: ParsedComments["comments"] = []
  let note = ""
  let at = 1
  let finish = -1
  while (at < lines.length) {
    const line = lines[at]!
    if (line === `</${TAG}>`) {
      finish = at
      break
    }
    const head = /^<comment n="(\d+)" of="([^"]*)"(?: item="([^"]*)")?>$/.exec(line)
    if (head) {
      const open = /^<quote(?: cut="(\d+)")?>$/.exec(lines[at + 1] ?? "")
      const fence = lines[at + 2]
      if (!open || !fence || !/^`{3,}$/.test(fence)) return undefined
      let close = at + 3
      while (close < lines.length && lines[close] !== fence) close++
      if (lines[close + 1] !== "</quote>") return undefined
      let end = close + 2
      while (end < lines.length && lines[end] !== "</comment>") end++
      if (end >= lines.length) return undefined
      comments.push({ n: Number(head[1]), of: head[2]!, quote: lines.slice(at + 3, close).join("\n"), cut: Number(open[1] ?? 0), text: unescapeTags(lines.slice(close + 2, end).join("\n")), ...(head[3] ? { item: head[3] } : {}) })
      at = end + 1
    } else if (line === "<note>") {
      const end = lines.indexOf("</note>", at)
      if (end < 0) return undefined
      note = unescapeTags(lines.slice(at + 1, end).join("\n"))
      at = end + 1
    } else at++
  }
  if (finish < 0 || (!comments.length && !note)) return undefined
  const header = lines[0]!
  const head = all.slice(0, start).join("\n").trim()
  const tail = lines.slice(finish + 1).join("\n").trim()
  return { comments, note, ...(head ? { head } : {}), ...(tail ? { tail } : {}), ...(header.includes(' parked="1"') ? { parked: true } : {}), ...(header.includes(' draft="1"') ? { draft: true } : {}) }
}

/** A saved draft's comments, when its text is the draft envelope; undefined for ordinary text (the text is then the whole draft). */
export function parseCommentDraft(text: string): { comments: ReplyComment[]; draft: string; parked: boolean } | undefined {
  const parsed = parseCommentMessage(text)
  if (!parsed?.draft || !parsed.comments.length) return undefined
  return { comments: parsed.comments.map((comment, index): ReplyComment => ({ id: index + 1, quote: comment.quote, text: comment.text, ...(comment.item ? { itemId: comment.item } : {}), ...(comment.of === CONTEXT_OF ? { other: true as const } : {}) })), draft: parsed.note, parked: parsed.parked === true }
}

/** A message that may be an envelope as plain readable lines (history, a search hit, a draft preview); other text is returned unchanged. */
export function readableMessage(text: string, { quotes = true }: { quotes?: boolean } = {}): string {
  const parsed = parseCommentMessage(text)
  if (!parsed) return text
  const count = parsed.comments.length
  return [
    ...(count ? [`${count} ${count === 1 ? "comment" : "comments"}`] : []),
    ...parsed.comments.flatMap((comment) => [...(quotes ? [`> ${comment.quote.replace(/\s+/g, " ").trim()}`] : []), comment.text]),
    ...(parsed.note ? [count ? `note: ${parsed.note}` : parsed.note] : []),
  ].join("\n")
}

/** A one-line preview (the daemon's, cut at 160 characters) of a saved draft, whatever it holds: tags never show. */
export function readablePreview(preview: string): string {
  const count = /^<mendcode_comments count="(\d+)"/.exec(preview)
  if (!count) return preview
  const first = /<\/quote> ?(.*?) ?(?:<\/comment>|$)/.exec(preview)?.[1]?.trim()
  // The explanation line before the comments mentions `<note>` too: only the one after a closed comment is the note.
  const note = /<\/comment> ?<note> ?(.*?) ?(?:<\/note>|$)/.exec(preview)?.[1]?.trim()
  const n = Number(count[1])
  return [`${n} ${n === 1 ? "comment" : "comments"}`, note || first].filter(Boolean).join(" · ")
}

/**
 * Any stored text (a full message, or a preview the daemon cut) that may be an envelope, as lines a person can read; other text is
 * returned unchanged. The one entry point for history, search hits, the drafts list and the session list.
 */
export function readableText(text: string, options: { quotes?: boolean } = {}): string {
  if (!text.includes("<mendcode_comments")) return text
  return parseCommentMessage(text) ? readableMessage(text, options) : readablePreview(text)
}

/** A passage of the answer the keyboard walk can stop on. `number` is the option's own number in a numbered list. */
export type ReplyUnit = { kind: "paragraph" | "item" | "option" | "code"; text: string; number?: number }

/** The units of an answer's Markdown, in reading order: paragraphs, list items, numbered options (with their numbers) and code blocks. */
export function replyUnits(markdown: string): ReplyUnit[] {
  const units: ReplyUnit[] = []
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) units.push({ kind: "paragraph", text: paragraph.join(" ").replace(/\s+/g, " ").trim() })
    paragraph = []
  }
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      for (at++; at < lines.length && !lines[at]!.trimStart().startsWith(fence[1]!); at++) body.push(lines[at]!)
      if (body.length) units.push({ kind: "code", text: body.join("\n") })
      continue
    }
    const option = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    const item = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (option || item) {
      flush()
      const parts = [(option?.[2] ?? item?.[1])!]
      while (at + 1 < lines.length && /^\s{2,}\S/.test(lines[at + 1]!) && !/^\s*(\d+[.)]|[-*+])\s/.test(lines[at + 1]!)) parts.push(lines[++at]!.trim())
      units.push(option ? { kind: "option", text: parts.join(" "), number: Number(option[1]) } : { kind: "item", text: parts.join(" ") })
    } else if (!line.trim()) flush()
    else paragraph.push(line.trim())
  }
  flush()
  return units
}

const squeeze = (text: string) => text.replace(/\s+/g, "")

/**
 * The drawn rows `[from, to]` that show `quote`, searched with every space and line break ignored, so a wrapped paragraph, a list
 * marker or a code block's bar does not matter. `after` skips rows already taken by an earlier hit. Undefined when the passage is not
 * on screen (scrolled away, folded, or gone after a compaction): the comment keeps its quote and loses only its mark.
 */
export function locateQuote({ rows, quote, after = 0 }: { rows: readonly string[]; quote: string; after?: number }): { from: number; to: number } | undefined {
  const needle = squeeze(quote)
  if (!needle) return undefined
  let hay = ""
  const owner: number[] = []
  rows.forEach((row, index) => {
    if (index < after) return
    // A code block's bar is part of the drawing, not of the quote.
    for (const char of squeeze(row.replace(/^\s*[│┃]/, ""))) {
      hay += char
      owner.push(index)
    }
  })
  const start = hay.indexOf(needle)
  return start < 0 ? undefined : { from: owner[start]!, to: owner[start + needle.length - 1]! }
}
