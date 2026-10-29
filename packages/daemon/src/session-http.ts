import { Command, createIdFactory, ItemId, MAX_FRAME_BYTES, MessagePart, parseCommand, SessionId, SessionShellPayload } from "@mendcode/protocol"
import { isLoopbackHost, parseRemoteAddress } from "@mendcode/protocol/wire"
import type { Outcome } from "./session-history"
import type { RemoteTokenInfo } from "./remote"

type Peer = RemoteTokenInfo & { hash: string }
const ids = createIdFactory()
const clientId = ids("client")
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
const error = (status: number, code: string, message: string) => json({ error: { code, message } }, status)

export function validateSessionHttpListener(listen: string | undefined) {
  if (!listen) return undefined
  const address = parseRemoteAddress(listen)
  if (!isLoopbackHost(address.hostname)) throw new Error("--http-listen must bind loopback")
  return address
}

/** Request objects exercise the complete handler without opening an HTTP listener. */
export function createSessionHttpApi(deps: {
  authenticate(token: string): Peer | undefined
  execute(command: Command, peer: Peer): Promise<Outcome<Record<string, unknown>>>
  shell(sessionId: SessionId, payload: SessionShellPayload, peer: Peer, signal: AbortSignal): Promise<Outcome<Record<string, unknown>>>
}) {
  return async function request(req: Request): Promise<Response> {
    if (req.headers.has("origin")) return error(403, "forbidden", "browser origins are disabled")
    const auth = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.get("authorization") ?? "")
    let peer: Peer | undefined
    try { peer = auth ? deps.authenticate(auth[1]!) : undefined } catch {}
    if (!peer) return error(401, "unauthorized", "authentication required")
    if (peer.readOnly) return error(403, "forbidden", "read-only token")
    const segments = new URL(req.url).pathname.split("/").filter(Boolean)
    const session = SessionId.safeParse(segments[1])
    if (segments[0] !== "session" || !session.success) return error(404, "target_mismatch", "route unavailable")
    const shell = req.method === "POST" && segments.length === 3 && segments[2] === "shell"
    const removeMessage = req.method === "DELETE" && segments.length === 4 && segments[2] === "message"
    const part = segments.length === 6 && segments[2] === "message" && segments[4] === "part" && ["DELETE", "PATCH"].includes(req.method)
    if (!shell && !removeMessage && !part) return error(404, "target_mismatch", "route unavailable")
    let payload: unknown
    if (shell || req.method === "PATCH") {
      if (!req.headers.get("content-type")?.startsWith("application/json")) return error(415, "invalid_command", "JSON required")
      const reader = req.body?.getReader()
      if (!reader) return error(400, "invalid_command", "JSON required")
      let text = ""
      let bytes = 0
      const decoder = new TextDecoder()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.length
          if (bytes > 80 * 1024) { await reader.cancel(); return error(413, "invalid_command", "payload too large") }
          text += decoder.decode(chunk.value, { stream: true })
        }
        payload = JSON.parse(text + decoder.decode())
      } catch { return error(400, "invalid_command", "invalid JSON") }
    }
    let result: Outcome<Record<string, unknown>>
    try {
      if (shell) {
        const parsed = SessionShellPayload.safeParse(payload)
        if (!parsed.success) return error(400, "invalid_command", "invalid shell payload")
        result = await deps.shell(session.data, parsed.data, peer, req.signal)
      } else {
        const message = ItemId.safeParse(segments[3])
        if (!message.success) return error(400, "invalid_command", "invalid message id")
        const match = req.headers.get("if-match") ?? "0"
        if (!/^\d{1,9}$/.test(match)) return error(400, "invalid_command", "If-Match must be a revision number")
        const expectedRevision = Number(match)
        const base = { id: ids("command"), clientId, sessionId: session.data, messageId: message.data, expectedRevision }
        let input: unknown = { ...base, type: "session.message.delete" }
        if (part) {
          const partId = segments[5]!
          if (req.method === "DELETE") input = { ...base, type: "session.part.delete", partId }
          else {
            const body = payload as Record<string, unknown> | null
            if (!body || body.sessionID !== session.data || body.messageID !== message.data || body.id !== partId) return error(400, "target_mismatch", "part identity mismatch")
            const { sessionID, messageID, ...native } = body
            const parsed = MessagePart.safeParse(native)
            if (!parsed.success) return error(400, "invalid_command", "invalid native part")
            input = { ...base, type: "session.part.update", partId, part: parsed.data }
          }
        }
        const command = parseCommand(input)
        if (!command.success) return error(400, "invalid_command", "invalid mutation")
        result = await deps.execute(command.data, peer)
      }
    } catch { return error(500, "internal", "session request failed") }
    if (!result.ok) return error(result.code === "forbidden" ? 403 : result.code === "unknown_session" ? 404 : result.code === "busy" || result.code === "target_mismatch" ? 409 : 400, result.code, result.message)
    const body = shell ? result.result : req.method === "PATCH" ? { ...(result.result.part as object), sessionID: session.data, messageID: segments[3] } : true
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_FRAME_BYTES - 4096) return error(413, "internal", "response too large")
    const response = json(body)
    if (typeof result.result.revision === "number") response.headers.set("etag", String(result.result.revision))
    return response
  }
}
