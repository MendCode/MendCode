import type { SessionEventDraft } from "@mendcode/kernel"
import { EXTENSION_DIALOGS_CAPABILITY } from "@mendcode/extension-api"
import type { Command, RequestId, SessionId, TurnId } from "@mendcode/protocol"
import type { DialogRequest, ExtensionDialogPort } from "./extensions/dialogs"

/** The terminal capability that says it shows extension dialogs (the interactive terminal; a headless run never declares it). */
export const DIALOGS_CAPABILITY = EXTENSION_DIALOGS_CAPABILITY
/** Dialogs open at once in one session; one more answers its default at once. */
const MAX_OPEN = 4

type Pending = { sessionId: SessionId; finish(answer: string | undefined, resolution: "answered" | "denied" | "abandoned", clientId?: string): void }

/**
 * Extension dialogs as the session's questions: an async `server.request` (it never holds the turn) that every terminal draws and
 * answers with `request.resolve`. Shown only while a local terminal that declared `extension-dialogs` has the session open; otherwise
 * the default answers at once. A dialog nobody answers is withdrawn (`abandoned`) when its time runs out.
 */
export function createExtensionDialogs(deps: {
  canShow(sessionId: SessionId): boolean
  /** The running turn, or the session's last one: the request names a turn like any question. */
  turnOf(sessionId: SessionId): TurnId | undefined
  requestId(): RequestId
  turnId(): TurnId
  emit(event: SessionEventDraft): void
  mask(sessionId: SessionId, text: string): string
}): ExtensionDialogPort & { resolve(command: Extract<Command, { type: "request.resolve" }>): { ok: true } | { ok: false; code: "invalid_command"; message: string } | undefined; stop(): void } {
  const pending = new Map<RequestId, Pending>()
  const openIn = (sessionId: SessionId) => [...pending.values()].filter((entry) => entry.sessionId === sessionId).length
  return {
    ask(request: DialogRequest) {
      const sessionId = request.sessionId as SessionId
      if (!deps.canShow(sessionId) || openIn(sessionId) >= MAX_OPEN) return Promise.resolve(undefined)
      const requestId = deps.requestId()
      const safe = (text: string) => deps.mask(sessionId, text)
      return new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => entry.finish(undefined, "abandoned"), request.timeoutMs)
        timer.unref?.()
        const entry: Pending = {
          sessionId,
          finish(answer, resolution, clientId) {
            if (!pending.delete(requestId)) return
            clearTimeout(timer)
            // A session deleted while the dialog was open has no log to write to; the extension still gets its answer.
            try { deps.emit({ type: "server.request.resolved", sessionId, requestId, resolution, ...(clientId ? { byClientId: clientId as never } : {}) }) } catch { /* gone */ }
            resolve(answer)
          },
        }
        pending.set(requestId, entry)
        const seconds = Math.round(request.timeoutMs / 1000)
        deps.emit({
          type: "server.request",
          sessionId,
          requestId,
          turnId: deps.turnOf(sessionId) ?? deps.turnId(),
          kind: "question",
          async: true,
          title: safe(`${request.extension}: ${request.title}`).slice(0, 500),
          detail: "",
          questions: [{ header: safe(request.title).slice(0, 30) || "Extension", question: safe(request.question).slice(0, 500), options: request.options.map((label) => ({ label: safe(label).slice(0, 120) })), custom: request.custom, context: `From the extension ${request.extension}. Unanswered in ${seconds} s (or dismissed), it takes its default.` }],
        })
      })
    },
    resolve(command) {
      const entry = pending.get(command.requestId)
      if (!entry || entry.sessionId !== command.sessionId) return undefined
      const decision = command.decision
      if (decision.kind === "answer") {
        const answer = decision.answers?.[0]?.[0] ?? decision.text
        entry.finish(answer.trim() ? answer : undefined, "answered", command.clientId)
      } else if (decision.kind === "deny") entry.finish(undefined, "denied", command.clientId)
      else return { ok: false, code: "invalid_command", message: "[DAEMON]: an extension dialog takes an answer or a dismissal" }
      return { ok: true }
    },
    stop() {
      for (const entry of [...pending.values()]) entry.finish(undefined, "abandoned")
    },
  }
}
