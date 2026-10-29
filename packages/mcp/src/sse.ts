export type SseEvent = { event: string; data: string }

const MAX_EVENT_CHARS = 32 * 1024 * 1024

/**
 * Server-sent events of a response body (WHATWG HTML §9.2): `event:` and `data:` fields, blank line ends an event,
 * `:` lines are comments, LF, CRLF and CR all end a line. An event larger than 32 MB aborts the stream with an error.
 * Stops reading (and cancels the body) when the consumer stops iterating.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  // The unfinished line, kept as chunks (no line ends inside) and joined once it ends: appending to one string and searching it again at
  // every read copied a long line (a tool result with an image) once per chunk. `carriage`: the last chunk ended in a CR that may start a CRLF.
  let pending: string[] = []
  let pendingChars = 0
  let carriage = false
  let event = ""
  let data: string[] = []
  let size = 0

  function* flush(): Generator<SseEvent> {
    if (data.length > 0) yield { event: event || "message", data: data.join("\n") }
    event = ""
    data = []
    size = 0
  }

  function* line(text: string): Generator<SseEvent> {
    if (text === "") {
      yield* flush()
      return
    }
    if (text.startsWith(":")) return
    const colon = text.indexOf(":")
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? "" : text.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") {
      size += value.length
      if (size > MAX_EVENT_CHARS) throw new Error("server-sent event is too large")
      data.push(value)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let text: string = (carriage ? "\r" : "") + decoder.decode(value, { stream: true })
      carriage = false
      for (;;) {
        const end = text.search(/[\r\n]/)
        if (end === -1) break
        // A trailing CR may be the first half of CRLF: wait for the next chunk.
        if (text[end] === "\r" && end === text.length - 1) {
          text = text.slice(0, end)
          carriage = true
          break
        }
        const complete = pending.length ? pending.join("") + text.slice(0, end) : text.slice(0, end)
        pending = []
        pendingChars = 0
        text = text.slice(text[end] === "\r" && text[end + 1] === "\n" ? end + 2 : end + 1)
        yield* line(complete)
      }
      if (text) {
        pending.push(text)
        pendingChars += text.length
      }
      if (pendingChars + (carriage ? 1 : 0) > MAX_EVENT_CHARS) throw new Error("server-sent event line is too large")
    }
    const rest = pending.join("") + (carriage ? "\r" : "") + decoder.decode()
    if (rest !== "") yield* line(rest.replace(/\r$/, ""))
    yield* flush()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
