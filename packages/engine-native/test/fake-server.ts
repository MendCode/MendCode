import type { ModelEvent } from "../src"

/** A provider stand-in on 127.0.0.1 (never the network): records every request and answers with `handler`. */
export type Recorded = { method: string; path: string; headers: Record<string, string>; body: any }

export function fakeServer(handler: (request: Recorded, index: number) => Response | Promise<Response>) {
  const requests: Recorded[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const text = await request.text()
      let body: unknown
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = text
      }
      const url = new URL(request.url)
      const recorded: Recorded = { method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers), body }
      requests.push(recorded)
      return handler(recorded, requests.length - 1)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) }
}

/** An SSE body; small chunks split events and multi-byte characters across reads like a real network. */
export function sse(events: Array<unknown | string>, options: { named?: boolean; chunkSize?: number } = {}) {
  const text = events
    .map((event) => {
      const data = typeof event === "string" ? event : JSON.stringify(event)
      const name = options.named && typeof event === "object" && event !== null ? `event: ${(event as { type?: string }).type}\n` : ""
      return `${name}data: ${data}\n\n`
    })
    .join("")
  const bytes = new TextEncoder().encode(text)
  const size = options.chunkSize ?? 9
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** A stream that sends `events`, then stays open until the client goes away. */
export function hangingSse(events: unknown[], options: { named?: boolean } = {}) {
  const encoder = new TextEncoder()
  const first = events.map((event) => `${options.named ? `event: ${(event as { type?: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("")
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(encoder.encode(first)),
    // Never resolves: the stream is cancelled when the client aborts.
    pull: () => new Promise<void>(() => {}),
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** Every event of a stream but the pieces of a call's input as it is written (`tool_input`); `collectAll` keeps those too. */
export async function collect(stream: AsyncIterable<ModelEvent>) {
  return (await collectAll(stream)).filter((event) => event.type !== "tool_input")
}

export async function collectAll(stream: AsyncIterable<ModelEvent>) {
  const out: ModelEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}
