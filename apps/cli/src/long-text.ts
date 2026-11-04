import type { BlobRef } from "@mendcode/protocol"
import { ATTACHMENT_PART_BYTES, MAX_ATTACHMENT_LABEL, MAX_DRAFT_CHARS } from "@mendcode/protocol/wire"

/** Room left under the message limit for what the daemon adds (comments, IDE context, a PR reference). */
const HEADROOM = 2_048
/** The most one prompt or one text file may be when it goes as an attachment (docs/attachments.md). */
export const LONG_TEXT_MAX_BYTES = 200 * 1024

/** What a caller needs to send: `attachment.put` answers with the stored attachment, or why the daemon refused. */
export type TextSend = (command: { type: "attachment.put"; name: string; data: string; part?: { upload: string; index: number; last: boolean } }) => Promise<{ ok: true; attachment?: BlobRef | undefined } | { ok: false; message: string }>

/** Stores `bytes` as a `text/plain` attachment named `name` (`.txt`), in pieces when one frame cannot carry them. */
export async function putTextAttachment(input: { send: TextSend; name: string; bytes: Uint8Array }): Promise<{ ok: true; ref: BlobRef } | { ok: false; message: string }> {
  const upload = crypto.randomUUID().replace(/-/g, "")
  const pieces = Math.max(1, Math.ceil(input.bytes.length / ATTACHMENT_PART_BYTES))
  let ref: BlobRef | undefined
  for (let index = 0; index < pieces; index++) {
    const data = Buffer.from(input.bytes.subarray(index * ATTACHMENT_PART_BYTES, (index + 1) * ATTACHMENT_PART_BYTES)).toString("base64")
    const reply = await input.send({ type: "attachment.put", name: input.name, data, ...(pieces > 1 ? { part: { upload, index, last: index === pieces - 1 } } : {}) })
    if (!reply.ok) return reply
    ref = reply.attachment
  }
  return ref ? { ok: true, ref } : { ok: false, message: "the daemon kept no copy" }
}

const size = (bytes: number) => bytes.toLocaleString("en-US")

type Piece = { name: string; text: string; kind: "prompt" | "file" }

function labelOf(piece: Piece): string {
  const label = `[${piece.name}]`
  return label.length <= MAX_ATTACHMENT_LABEL ? label : `[${piece.name.slice(0, MAX_ATTACHMENT_LABEL - 5)}…]`
}

/**
 * The text of a `run` or `session send` as it travels. Everything that fits a message (64 KiB less headroom) stays inline, exactly as
 * before. Otherwise the largest pieces (the typed prompt, or the content of a `--file`) go to the daemon once as `text/plain`
 * attachments, up to 200 KiB each, and the text keeps only their `[name]` label: the model reads the whole text where the label
 * stands, and nothing is stored twice. Fails with the field, its size and the limit when a piece is over 200 KiB.
 */
export async function composeLongText(input: { send: TextSend; prompt: string; files: ReadonlyArray<{ name: string; content: string }> }): Promise<{ ok: true; prompt: string; fileText: string; attachments: BlobRef[] } | { ok: false; message: string }> {
  const pieces: Piece[] = [{ name: "prompt.txt", text: input.prompt, kind: "prompt" }, ...input.files.map((file): Piece => ({ name: file.name, text: file.content, kind: "file" }))]
  const inline = (piece: Piece) => piece.kind === "prompt" ? piece.text : `\n\n[${piece.name}]\n${piece.text}`
  const moved = new Set<Piece>()
  const length = () => pieces.reduce((sum, piece) => sum + (moved.has(piece) ? labelOf(piece).length + 2 : inline(piece).length), 0)
  for (const piece of [...pieces].sort((a, b) => b.text.length - a.text.length)) {
    if (length() <= MAX_DRAFT_CHARS - HEADROOM) break
    moved.add(piece)
  }
  const attachments: BlobRef[] = []
  const parts: string[] = []
  for (const piece of pieces) {
    if (!moved.has(piece)) {
      parts.push(inline(piece))
      continue
    }
    const bytes = new TextEncoder().encode(piece.text)
    if (bytes.length > LONG_TEXT_MAX_BYTES) return { ok: false, message: piece.kind === "prompt"
      ? `the prompt is ${size(bytes.length)} bytes; the limit is ${size(LONG_TEXT_MAX_BYTES)} · put the text in --file files (up to 200 KiB each)`
      : `${piece.name} is ${size(bytes.length)} bytes; the limit for a text file is ${size(LONG_TEXT_MAX_BYTES)} · split it into smaller files` }
    const name = piece.name.endsWith(".txt") ? piece.name : `${piece.name}.txt`
    const stored = await putTextAttachment({ send: input.send, name, bytes })
    if (!stored.ok) return { ok: false, message: `${piece.kind === "prompt" ? "the prompt" : piece.name} could not be sent as an attachment: ${stored.message}` }
    const label = labelOf(piece)
    const part = piece.kind === "prompt" ? label : `\n\n${label}`
    parts.push(part)
    // No `at`: the label alone places it, which also holds when `commands.execute` joins the text on the daemon.
    attachments.push({ ...stored.ref, name, label })
  }
  return { ok: true, prompt: parts[0]!, fileText: parts.slice(1).join(""), attachments }
}
