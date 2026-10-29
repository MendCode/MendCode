import type { SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import type { Outcome } from "./session-history"

/** Refuse before accessing projections, including fully privileged peers. */
export function sessionPanelSavings(store: Pick<Store, "hasSession" | "usageScopes">, sessionId: SessionId, connection: { remoteAddress?: unknown; peer?: unknown }): Outcome<Record<string, unknown>> {
  if (connection.remoteAddress || connection.peer) return { ok: false, code: "invalid_command", message: "Session savings are local only" }
  if (!store.hasSession(sessionId)) return { ok: false, code: "unknown_session", message: "unknown session" }
  return { ok: true, result: { savings: store.usageScopes.sessionSavings(sessionId) } }
}
