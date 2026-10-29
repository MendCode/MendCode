import { ATTACHMENT_PART_BYTES, MAX_DRAFT_CHARS, TEXT_PUT_MAX_BYTES } from "@mendcode/protocol/wire"
import type { BlobRef } from "@mendcode/protocol"
import type { PendingAttachment } from "../../view/attachments"
import { expandPastes, livePastes, type PendingPaste } from "../../view/paste-placeholders"
import type { AppContext } from "./context"

/** Room left under the message limit for what the daemon adds (comments, IDE context, a PR reference). */
const HEADROOM = 2_048

/**
 * A prompt whose pastes make it longer than a message may be: the largest pastes go to the daemon as text attachments (in pieces
 * when one frame cannot carry them) until the rest fits. Each keeps its label in the prompt, where the model reads the text, and
 * becomes an attachment of the message; the others still expand into the text. Undefined when nothing had to move, else the
 * attachments to send and the pastes still to expand, or why it could not.
 */
export async function moveLongPastes(input: { send: AppContext["input"]["send"]; text: string; pastes: readonly PendingPaste[] }): Promise<{ attachments: PendingAttachment[]; pastes: PendingPaste[] } | { error: string } | undefined> {
  let pastes = livePastes(input.pastes, input.text)
  const length = () => expandPastes(input.text, pastes).trim().length
  if (length() <= MAX_DRAFT_CHARS) return undefined
  const attachments: PendingAttachment[] = []
  for (const paste of [...pastes].sort((a, b) => b.text.length - a.text.length)) {
    if (length() <= MAX_DRAFT_CHARS - HEADROOM) break
    const bytes = new TextEncoder().encode(paste.text)
    if (bytes.length > TEXT_PUT_MAX_BYTES) return { error: `a paste of ${Math.ceil(bytes.length / 1_048_576)} MB is over the ${TEXT_PUT_MAX_BYTES / 1_048_576} MB limit · save it to a file and mention it with @` }
    const name = `paste-${attachments.length + 1}.txt`
    const upload = crypto.randomUUID().replace(/-/g, "")
    const pieces = Math.max(1, Math.ceil(bytes.length / ATTACHMENT_PART_BYTES))
    let ref: BlobRef | undefined
    for (let index = 0; index < pieces; index++) {
      const data = Buffer.from(bytes.subarray(index * ATTACHMENT_PART_BYTES, (index + 1) * ATTACHMENT_PART_BYTES)).toString("base64")
      const reply = await input.send({ type: "attachment.put", name, data, ...(pieces > 1 ? { part: { upload, index, last: index === pieces - 1 } } : {}) })
      if (!reply.ok) return { error: `the long paste could not be sent: ${reply.error.message.replace(/^\[[A-Z]+\]: /, "")}` }
      ref = (reply.result as { attachment?: BlobRef } | undefined)?.attachment
    }
    if (!ref) return { error: "the long paste could not be sent: the daemon kept no copy" }
    attachments.push({ kind: "document", ref, name, label: paste.label })
    pastes = pastes.filter((each) => each !== paste)
  }
  if (length() > MAX_DRAFT_CHARS) return { error: `the typed text alone is ${Math.ceil(length() / 1024)} KB; a message is at most 64 KB · trim it, or save it to a file and mention it with @` }
  return { attachments, pastes }
}
