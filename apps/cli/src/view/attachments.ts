import type { BlobRef } from "@mendcode/protocol"

/**
 * Media waiting for submit (stored blobs), or a small text file or folder inlined at submit time. `label` is the token that stands for
 * it in the prompt text (`[Image #1]`, `[PDF design.pdf]`, `[notes.txt]`, `[codeconfig/]`); an attachment without one (the chip-row
 * setting, a draft from before tokens) is sent after the text.
 */
export type PendingAttachment =
  | { kind: "image"; ref: BlobRef; name: string; width?: number; height?: number; label?: string }
  | { kind: "document"; ref: BlobRef; name: string; label?: string }
  | { kind: "text"; name: string; content: string; directory?: boolean; label?: string }

/** 512 B / 1.5 KB / 240 KB / 12.4 MB — base 1024, a trailing ".0" dropped. Independent of the lazily-loaded storage page (P5): chips render on every keystroke, before /storage ever opens. */
export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1023.95 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`
}

const IMAGE_TOKEN = /^\[Image #(\d+)\]$/

/** "[Image #2 · 1440×900 · 240 KB]" (the token's number, else the index among only the image attachments; size omitted when unknown) for an image, "name · size" for a PDF, the file name for a text attachment. */
export function attachmentLabel(pending: readonly PendingAttachment[], index: number): string {
  const item = pending[index]!
  if (item.kind === "text") return item.name
  if (item.kind === "document") return `${item.name} · ${formatAttachmentBytes(item.ref.bytes)}`
  const imageIndex = Number(IMAGE_TOKEN.exec(item.label ?? "")?.[1]) || pending.slice(0, index + 1).filter((p) => p.kind === "image").length
  const size = item.width && item.height ? `${item.width}×${item.height} · ` : ""
  return `[Image #${imageIndex} · ${size}${formatAttachmentBytes(item.ref.bytes)}]`
}

/** Cells a file name may take inside a token; a longer one keeps its start and its end (the extension). */
const TOKEN_NAME_CELLS = 28

function tokenName(name: string): string {
  const clean = [...name.replace(/[\x00-\x1f\x7f\[\]]/g, " ").replace(/\s+/g, " ").trim()]
  const text = clean.length > TOKEN_NAME_CELLS ? `${clean.slice(0, TOKEN_NAME_CELLS - 11).join("")}…${clean.slice(-10).join("")}` : clean.join("")
  return text || "file"
}

/**
 * The token for an attachment about to join `pending`: `[Image #N]` with N one past the highest image number any pending attachment
 * holds or the session already sent (`sent`, from `sentImageNumber`; a token that was deleted may come back with undo, so its number is
 * not reused), `[PDF name.pdf]`, `[name.txt]` or `[folder/]`. Never the label of another pending attachment: a second `[PDF a.pdf]` is
 * `[PDF a.pdf #2]`.
 */
export function attachmentToken(pending: readonly PendingAttachment[], item: PendingAttachment, sent = 0): string {
  if (item.kind === "image") {
    const highest = pending.reduce((max, other) => Math.max(max, Number(IMAGE_TOKEN.exec(other.label ?? "")?.[1]) || 0), sent)
    return `[Image #${highest + 1}]`
  }
  const base = item.kind === "document" ? `PDF ${tokenName(item.name)}` : `${tokenName(item.name)}${item.directory ? "/" : ""}`
  const taken = new Set(pending.flatMap((other) => (other.label ? [other.label] : [])))
  let label = `[${base}]`
  for (let n = 2; taken.has(label); n++) label = `[${base} #${n}]`
  return label
}

/**
 * The highest image number the session's sent messages used: their `[Image #N]` labels, or their count of images when a message carried
 * images without labels. The next pasted image goes on from it instead of starting at #1 again.
 */
export function sentImageNumber(messages: Iterable<{ attachments?: ReadonlyArray<{ mime: string; label?: string | undefined }> | undefined }>): number {
  let highest = 0
  let count = 0
  for (const message of messages) for (const attachment of message.attachments ?? []) {
    if (!attachment.mime.startsWith("image/")) continue
    count++
    highest = Math.max(highest, Number(IMAGE_TOKEN.exec(attachment.label ?? "")?.[1]) || 0)
  }
  return Math.max(highest, count)
}

/** Every token label the pending attachments carry: what the prompt editor treats as one character. */
export const attachmentLabels = (pending: readonly PendingAttachment[]): string[] => pending.flatMap((item) => (item.label ? [item.label] : []))

/** How a token is drawn in the prompt and the transcript: the chip badge colors the transcript already gives an image, a PDF and a text file. */
export type TokenLook = { label: string; role: "accent" | "primary" | "secondary" }

export const tokenLooks = (pending: readonly PendingAttachment[]): TokenLook[] => pending.flatMap((item) => (item.label ? [{ label: item.label, role: item.kind === "image" ? "accent" as const : item.kind === "document" ? "primary" as const : "secondary" as const }] : []))

/**
 * The attachments that still belong to the prompt: one that has no token (the chip row, an older draft), and one whose token is
 * still in the text. A deleted token takes its attachment with it; undo brings both back, so the entry itself is kept until the
 * prompt is sent or cleared. Two entries with one label (queued prompts merged into one) need that many copies of it.
 */
export function liveAttachments(pending: readonly PendingAttachment[], text: string): PendingAttachment[] {
  if (!pending.some((item) => item.label)) return pending as PendingAttachment[]
  const seen = new Map<string, number>()
  return pending.filter((item) => {
    if (!item.label) return true
    const used = (seen.get(item.label) ?? 0) + 1
    seen.set(item.label, used)
    return occurrences(text, item.label) >= used
  })
}

function occurrences(text: string, label: string): number {
  let count = 0
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + label.length)) count++
  return count
}

/** What the row over the prompt draws, by the `attachmentChips` setting: `inline` only the attachments that have no token in the text, `above` and `both` every one. */
export const chipRowAttachments = (live: readonly PendingAttachment[], mode: "inline" | "above" | "both"): PendingAttachment[] =>
  mode === "inline" ? live.filter((item) => !item.label) : [...live]

/** The refs of attachments as drafts, the queue and the wire keep them: with the name and the token they stand for. */
export const refOf = (item: PendingAttachment & { kind: "image" | "document" }): BlobRef => ({ ...item.ref, ...(item.name ? { name: item.name.slice(0, 255) } : {}), ...(item.label ? { label: item.label } : {}) })

/** The media refs a saved draft keeps for the prompt as it is now (a text file or folder is not part of a draft). */
export const draftRefs = (pending: readonly PendingAttachment[], text: string): BlobRef[] => liveAttachments(pending, text).flatMap((item) => (item.kind !== "text" ? [refOf(item)] : []))

/**
 * Refs from a draft, the queue or an earlier message as pending attachments. A ref that carries its token keeps it (the restored
 * text holds the token too); one that does not, from before tokens, is sent after the text like any chip.
 */
export function pendingFromRefs(refs: readonly BlobRef[]): PendingAttachment[] {
  return refs.map((full): PendingAttachment => {
    const { label, at: _at, ...ref } = full
    const pdf = ref.mime === "application/pdf"
    return { kind: pdf ? "document" : "image", ref, name: ref.name ?? (pdf ? "document.pdf" : "image"), ...(label ? { label } : {}) }
  })
}

/**
 * Splits user.submit: image/PDF refs go to attachments; text files are fenced and put in the text. An attachment whose token is in
 * `text` is placed there: its ref carries the token and the offset right after it (`prefix` is what the caller puts before the text
 * afterwards), and a text file's block follows its token, so the model reads the sentence in the order it was written. An attachment
 * without a token, or whose token the text no longer holds, goes after the text as it always has. `text` is the final text before
 * `prefix`; the offsets are computed on what is returned.
 */
export function composeSubmission(text: string, pending: readonly PendingAttachment[], prefix = ""): { text: string; attachments: BlobRef[] } {
  const claimed = new Set<number>()
  const placed: Array<{ item: PendingAttachment; start: number; end: number }> = []
  const loose: PendingAttachment[] = []
  for (const item of pending) {
    let start = -1
    if (item.label) {
      for (let at = text.indexOf(item.label); at >= 0; at = text.indexOf(item.label, at + item.label.length)) {
        if (!claimed.has(at)) {
          start = at
          break
        }
      }
    }
    if (start < 0) loose.push(item)
    else (claimed.add(start), placed.push({ item, start, end: start + item.label!.length }))
  }
  placed.sort((a, b) => a.start - b.start)

  const block = (item: PendingAttachment & { kind: "text" }) => `[attached file: ${item.name}]\n\`\`\`\n${item.content}\n\`\`\``
  const refs = new Map<PendingAttachment, BlobRef>()
  let body = ""
  let cursor = 0
  let afterBlock = false
  for (const { item, end } of placed) {
    // Spaces after a block would indent the sentence that resumes under it.
    const chunk = text.slice(cursor, end)
    body += afterBlock ? chunk.replace(/^[ \t]+/, "") : chunk
    afterBlock = false
    cursor = end
    if (item.kind === "text") {
      body += `\n\n${block(item)}\n\n`
      afterBlock = true
    } else refs.set(item, { ...refOf(item), at: prefix.length + body.length })
  }
  const tail = text.slice(cursor)
  body += afterBlock ? tail.replace(/^[ \t]+/, "") : tail
  if (afterBlock && !tail.trim()) body = body.replace(/\n+$/, "")

  const blocks: string[] = []
  for (const item of loose) {
    // The name rides along for display in the transcript; the hash stays the identity.
    if (item.kind !== "text") refs.set(item, item.name ? { ...item.ref, name: item.name.slice(0, 255) } : item.ref)
    else blocks.push(block(item))
  }
  return { text: [body, ...blocks].filter(Boolean).join("\n\n"), attachments: pending.flatMap((item) => (refs.has(item) ? [refs.get(item)!] : [])) }
}

/** A single line that looks like one local path: a quoted path (may contain spaces), or an unquoted `file://`, `~/` or absolute path with escaped spaces. */
const PATH_LINE = /^(?:"[^"]+"|'[^']+'|(?:file:\/\/|~\/|\/)(?:\\.|\S)*)$/

/**
 * When every non-empty line of a bracketed paste looks like a local path, returns them in order so the
 * caller can resolve and attach each one instead of inserting the paste as text. `undefined` for any
 * other paste (plain text, a mix of prose and paths, or an empty paste).
 */
export function pastedPaths(text: string): string[] | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0 || !lines.every((line) => PATH_LINE.test(line))) return undefined
  return lines
}
