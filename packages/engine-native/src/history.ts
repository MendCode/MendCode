import type { ModelMessage, RequestDocument, RequestImage } from "./provider"

/** One part of a user message in the order the user wrote it, with the bytes resolved. */
export type OrderedPart = { type: "text"; text: string } | { type: "image"; image: RequestImage } | { type: "document"; document: RequestDocument }

/**
 * A user message that has inline attachment tokens as its ordered parts (text, the image or PDF its token names, more text…), or
 * undefined for a message without tokens: its adapter then keeps the text-then-media shape it has always sent. A part that points at
 * media that was not resolved is left out.
 */
export function orderedParts(message: Extract<ModelMessage, { role: "user" }>): OrderedPart[] | undefined {
  if (!message.layout) return undefined
  const parts: OrderedPart[] = []
  for (const part of message.layout) {
    if ("text" in part) parts.push({ type: "text", text: part.text })
    else if ("image" in part) {
      const image = message.images?.[part.image]
      if (image) parts.push({ type: "image", image })
    } else {
      const document = message.documents?.[part.document]
      if (document) parts.push({ type: "document", document })
    }
  }
  return parts
}

/**
 * The history as strict providers accept it: every tool call is followed by exactly one result, in call order (a call
 * whose result is missing, e.g. after a crash between the two, gets a "cancelled" error result), and a result that
 * answers no call is dropped. Everything else passes through untouched.
 */
export function pairToolCalls(messages: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === "tool") continue
    out.push(message)
    if (message.role !== "assistant" || message.toolCalls.length === 0) continue
    const results = new Map<string, Extract<ModelMessage, { role: "tool" }>>()
    let next = index + 1
    for (; next < messages.length; next++) {
      const candidate = messages[next]!
      if (candidate.role !== "tool") break
      results.set(candidate.callId, candidate)
    }
    for (const call of message.toolCalls) out.push(results.get(call.callId) ?? { role: "tool", callId: call.callId, name: call.name, output: "cancelled", isError: true })
    index = next - 1
  }
  return out
}

/** For a model that takes no images: the images of user messages are replaced by a one-line note. */
export function withoutUnsupportedImages(messages: ModelMessage[], takesImages: boolean): ModelMessage[] {
  if (takesImages) return messages
  return messages.map((message) => {
    if (message.role !== "user" || !message.images?.length) return message
    const { images, layout: _layout, ...rest } = message
    return { ...rest, content: `${message.content}\n[${images.length} image${images.length === 1 ? "" : "s"} omitted: this model does not take images]`.trimStart() }
  })
}

/** Plain-object tool arguments (every API wants an object, never a string or null). */
export function argsObject(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}
