import { z } from "zod"
import { MflowActivation, MflowLease } from "@mendcode/protocol"
import { isLoopbackHost, parseRemoteAddress } from "@mendcode/protocol/wire"
import type { MflowService } from "./mflow"

export function mflowListenerAddress(value: string) {
  const address = parseRemoteAddress(value)
  if (!isLoopbackHost(address.hostname)) throw new Error("Mflow HTTP listener requires literal loopback")
  return address
}
type Auth = { name: string; readOnly: boolean }
const LeaseRequest = z.strictObject({ room: z.string().min(1).max(200).refine((value) => !/[\x00-\x1f\x7f]/.test(value)), owner: z.string().regex(/^[a-f0-9]{64}$/), lease: MflowLease })
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } })

/** Request handler is independent of the optional listener, so service tests use local Requests only. */
export function createMflowHttp(input: { service: MflowService; directory: string; authenticate(token: string): Auth | undefined; allowed?(): boolean; failed?(): void }) {
  return async (request: Request): Promise<Response> => {
    if (input.allowed && !input.allowed()) return json({ error: "rate_limited" }, 429)
    const authorization = request.headers.get("authorization") ?? ""
    const match = /^Bearer ([^\s]{1,4096})$/.exec(authorization)
    let peer: Auth | undefined
    try { peer = match ? input.authenticate(match[1]!) : undefined } catch {}
    if (!peer) { input.failed?.(); return json({ error: "unauthorized" }, 401) }
    if (peer.readOnly) return json({ error: "forbidden" }, 403)
    const url = new URL(request.url)
    const route = url.pathname.replace(/\/$/, "")
    try {
      if (request.method === "GET") {
        if (route === "/mflow" || route === "/mflow/status") return json(await input.service.query(input.directory, { operation: "status" }))
        if (route === "/mflow/scan" || route === "/mflow/relay-guide") return json(await input.service.query(input.directory, { operation: route.endsWith("scan") ? "scan" : "relay-guide" }))
        if (route === "/mflow/health") return json({ protocol: "mendcode-v2-mflow", ...input.service.coordinator.stats() })
        if (route === "/mflow/room") {
          const room = url.searchParams.get("room")
          if (!room || room.length > 200 || /[\x00-\x1f\x7f]/.test(room)) return json({ error: "invalid_request" }, 400)
          return json(input.service.coordinator.snapshot(room))
        }
      } else if (request.method === "POST") {
        if (Number(request.headers.get("content-length") ?? 0) > 32_768) return json({ error: "too_large" }, 413)
        const text = await request.text()
        if (text.length > 32_768) return json({ error: "too_large" }, 413)
        const body: unknown = text ? JSON.parse(text) : {}
        if (route === "/mflow/activate") return json(await input.service.change(input.directory, { operation: "activate", input: MflowActivation.parse(body) }))
        if (route === "/mflow/deactivate" || route === "/mflow/remove") {
          z.strictObject({}).parse(body)
          return json(await input.service.change(input.directory, { operation: route.endsWith("remove") ? "remove" : "deactivate" }))
        }
        if (route === "/mflow/lease") {
          const value = LeaseRequest.parse(body)
          return json(input.service.coordinator.run(value.room, `http:${peer.name}:${value.owner}`, value.lease))
        }
      }
      return json({ error: "not_found" }, 404)
    } catch { return json({ error: "invalid_request", message: "Mflow request failed; check configuration and lease ownership" }, 400) }
  }
}
