import { pasteLabel, type PendingPaste } from "./paste-placeholders"
import type { PendingAttachment } from "./attachments"

/** The most pasted texts kept, and their characters in all (a message is at most 64 KB, so one paste never passes it). */
const PASTES_KEPT = 6
const PASTE_CHARS_KEPT = 256 * 1024
/** The most sent messages whose attachments are kept, and the characters of text-file content one of them may carry. */
const MESSAGES_KEPT = 12
const FILE_CHARS_KEPT = 16 * 1024

/** A cheap stable key for a message text: its length and a hash, so the text itself is not held a second time. */
function keyOf(text: string): string {
  return `${text.length}:${Bun.hash(text).toString(36)}`
}

/**
 * What the terminal remembers of how a sent message was composed, so a message brought back into the prompt (↑ history, a queued
 * message taken back, Esc retract, a draft) shows as it was written: each large paste as its `[Pasted Content N chars]` chip and each
 * image or file as its chip. The daemon holds only the plain text; this holds the structure for the messages of this run, bounded:
 * a few pastes by reference (the text the message already carries), and attachment refs, which are small. Older entries drop first.
 */
export function createCompositionMemory() {
  const pastes: string[] = []
  const attachments = new Map<string, PendingAttachment[]>()

  return {
    /** A message just composed: its pastes and its attachments (the ones whose tokens it still holds), keyed by the text it goes as. */
    remember({ texts, pastes: used, attachments: kept }: { texts: readonly string[]; pastes: readonly PendingPaste[]; attachments: readonly PendingAttachment[] }) {
      for (const paste of used) {
        if (!paste.text || paste.text.length > PASTE_CHARS_KEPT) continue
        const at = pastes.indexOf(paste.text)
        if (at >= 0) pastes.splice(at, 1)
        pastes.push(paste.text)
      }
      while (pastes.length > PASTES_KEPT || pastes.reduce((sum, text) => sum + text.length, 0) > PASTE_CHARS_KEPT) pastes.shift()
      if (!kept.length) return
      const small = kept.filter((item) => item.kind !== "text" || item.content.length <= FILE_CHARS_KEPT)
      if (!small.length) return
      for (const text of texts) {
        const key = keyOf(text.trim())
        attachments.delete(key)
        attachments.set(key, small as PendingAttachment[])
      }
      while (attachments.size > MESSAGES_KEPT) attachments.delete(attachments.keys().next().value!)
    },
    /**
     * `text` with every remembered paste it holds put back as a chip: the text and the new `pending` list (the pastes already in the prompt
     * stay, and a new label never repeats theirs). `text` is returned as it came when it holds none.
     */
    rechip(text: string, pending: readonly PendingPaste[]): { text: string; pastes: PendingPaste[] } {
      let result = text
      const all = [...pending]
      for (const pasted of [...pastes].sort((a, b) => b.length - a.length)) {
        for (let at = result.indexOf(pasted); at >= 0; at = result.indexOf(pasted)) {
          const label = pasteLabel(pasted.length, all)
          all.push({ label, text: pasted })
          result = result.slice(0, at) + label + result.slice(at + pasted.length)
        }
      }
      return { text: result, pastes: all }
    },
    /** The attachments a sent message carried, when its text is one this run composed. */
    attachmentsOf(text: string): PendingAttachment[] | undefined {
      return attachments.get(keyOf(text.trim()))?.map((item) => ({ ...item }))
    },
  }
}
export type CompositionMemory = ReturnType<typeof createCompositionMemory>
