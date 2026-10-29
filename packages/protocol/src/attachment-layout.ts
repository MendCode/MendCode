/**
 * Where in the text of a user message each attachment belongs (docs/attachments.md, "Inline tokens"). Zod-free, so the terminal's
 * startup graph and every engine can use it.
 *
 * The prompt shows an attachment as a token in the text (`[Image #1]`). On the wire the token stays in the text and the attachment's
 * `BlobRef` carries two additive fields: `label`, the token's text, and `at`, the offset right after it in the text as the client
 * sent it. The label is the anchor: the daemon prepends or appends text and masks secrets after the client composed the message, so
 * an offset alone would drift; `at` is only trusted when the label still stands there.
 */

/** The fields of a `BlobRef` that place it. */
export type PlacedRef = { at?: number | undefined; label?: string | undefined }

/** Offsets are UTF-16 units, like `String.prototype.slice`. */
export type LayoutPart = { text: string } | { ref: number }

/** The longest label a ref may carry. */
export const MAX_ATTACHMENT_LABEL = 80

type Located = { ref: number; start: number; end: number }

/** Where each placed ref stands in `text`: its own hint when the label is still there, else the first free occurrence of the label. Refs without a label, or whose label is gone, are not located. */
function locate(text: string, refs: readonly PlacedRef[]): Located[] {
  const taken = new Set<number>()
  const found: Located[] = []
  refs.forEach((ref, index) => {
    const label = ref.label
    if (!label) return
    let start = -1
    if (ref.at !== undefined && ref.at >= label.length && !taken.has(ref.at - label.length) && text.startsWith(label, ref.at - label.length)) start = ref.at - label.length
    if (start < 0) {
      let from = 0
      for (let at = text.indexOf(label, from); at >= 0; at = text.indexOf(label, from)) {
        if (!taken.has(at)) {
          start = at
          break
        }
        from = at + 1
      }
    }
    if (start < 0) return
    taken.add(start)
    found.push({ ref: index, start, end: start + label.length })
  })
  return found.sort((a, b) => a.start - b.start || a.ref - b.ref)
}

/**
 * The message as an ordered list: the text up to and including each token, then the attachment it names, and so on. An attachment
 * with no label, or whose label is no longer in the text, goes at the end in its original order. Undefined when no ref is placed:
 * the caller then keeps the plain layout (the text, then the attachments), which is what every message without tokens has always had.
 */
export function layoutAttachments(text: string, refs: readonly PlacedRef[]): LayoutPart[] | undefined {
  const located = locate(text, refs)
  if (located.length === 0) return undefined
  const parts: LayoutPart[] = []
  let cursor = 0
  for (const { ref, end } of located) {
    if (end > cursor) parts.push({ text: text.slice(cursor, end) })
    parts.push({ ref })
    cursor = Math.max(cursor, end)
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  const placed = new Set(located.map((entry) => entry.ref))
  refs.forEach((_, index) => {
    if (!placed.has(index)) parts.push({ ref: index })
  })
  return parts
}

/** The refs in the order their tokens stand in the text, then the rest: for an engine that cannot interleave. Same order as the refs when none is placed. */
export function attachmentOrder(text: string, refs: readonly PlacedRef[]): number[] {
  const parts = layoutAttachments(text, refs)
  return parts ? parts.flatMap((part) => ("ref" in part ? [part.ref] : [])) : refs.map((_, index) => index)
}

/**
 * What is wrong with the positions a client sent, or undefined. Each ref that has a position must say which token it is, the token
 * must fit in the text before that offset, and two tokens may not overlap (one token belongs to one attachment).
 */
export function attachmentPlacementProblem(text: string, refs: readonly PlacedRef[]): string | undefined {
  const spans: Array<{ start: number; end: number }> = []
  for (const ref of refs) {
    if (ref.at === undefined) continue
    if (!ref.label) return "an attachment position needs its label"
    if (ref.at > text.length) return "an attachment position is past the end of the text"
    if (ref.at < ref.label.length) return "an attachment position is before its label"
    spans.push({ start: ref.at - ref.label.length, end: ref.at })
  }
  spans.sort((a, b) => a.start - b.start)
  for (let index = 1; index < spans.length; index++) if (spans[index]!.start < spans[index - 1]!.end) return "two attachments are placed on the same token"
  return undefined
}

/**
 * A long paste the prompt kept as its label (`text/plain` attachment) as the model reads it: the whole text, fenced, right after
 * the label. One shape for every engine.
 */
export function pastedText(bytes: Uint8Array): string {
  return `\n<pasted>\n${new TextDecoder().decode(bytes)}\n</pasted>\n`
}

/**
 * The message with its text attachments put back in: each one's text after its label, or at the end when its label is gone, for an
 * engine that reads the message as text (Claude Code, Codex, pi, ACP agents). `texts` holds the decoded text of each text ref by index;
 * the other refs are returned in their order.
 */
export function inlineTexts<T extends PlacedRef>(text: string, refs: readonly T[], texts: ReadonlyMap<number, string>): { text: string; refs: T[] } {
  if (!texts.size) return { text, refs: [...refs] }
  const parts = layoutAttachments(text, refs)
  const body = parts ? parts.map((part) => ("text" in part ? part.text : texts.get(part.ref) ?? "")).join("") : text + [...texts.values()].join("")
  return { text: body, refs: refs.filter((_, index) => !texts.has(index)) }
}
