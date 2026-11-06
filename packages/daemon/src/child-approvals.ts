import type { SessionEventDraft } from "@mendcode/kernel"
import type { Command, QueueId, RequestId, SessionEvent, SessionId, TurnId } from "@mendcode/protocol"

/** Waits this long after a child starts waiting before announcing, so children that block together are one notice and one card. */
export const GROUP_DELAY_MS = 1500
/** Items one card lists and singles it opens; the rest are answered in their own session. */
const MAX_LISTED = 12
const SHOWN_DETAIL = 160
export const APPROVE_ALL = "Allow all"
export const DENY_ALL = "Reject all"
export const ONE_BY_ONE = "One by one"
export const APPROVE_ONE = "Allow once"
export const DENY_ONE = "Reject"

/** A request of a session another session started (`mendcode run --bg`) that waits for the user. */
type Mirror = { header: string; question: string; options: string[]; context: string }
type Waiting = { child: SessionId; requestId: RequestId; launcher: SessionId; approval: boolean; title: string; tool: string | undefined; detail: string; announced: boolean; mirror: Mirror | undefined; mirrored: boolean }
type Card = { requestId: RequestId; at: SessionId; launcher: SessionId; items: RequestId[] }
type Single = { requestId: RequestId; at: SessionId; target: RequestId; launcher: SessionId; options: string[] }

const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.replace(/\s+/g, " ").trim() ?? ""
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Approvals that sessions started from another session's shell wait for (docs/permissions.md, "Children waiting for approval").
 * Nobody is attached to such a child, so its request used to sit unseen. Here the requests of one launching session are grouped:
 * the launching session's model gets one notice (it cannot approve; it is told to stop polling), and a local terminal of the user
 * gets one card listing what waits with "Approve all", "Deny all" and "One by one". Only the user's own terminal answers a card, and
 * "Approve all" approves exactly the requests the card listed, not ones that arrived after. Nothing runs until a child waits.
 * Core permission rule: every tier.
 */
export function createChildApprovals(deps: {
  /** The session that started `child` from its shell, or undefined. */
  launcherOf(child: SessionId): SessionId | undefined
  /** Sessions a local, interactive terminal of the user has open that can show the card, the launcher's first. */
  humanSessions(launcher: SessionId): SessionId[]
  title(sessionId: SessionId): string
  turnOf(sessionId: SessionId): TurnId | undefined
  requestId(): RequestId
  turnId(): TurnId
  queueId(): QueueId
  emit(event: SessionEventDraft): void
  mask(sessionId: SessionId, text: string): string
  /** The text for the launching session's model; resolves once it is queued or steered. */
  notify(launcher: SessionId, text: string, queueId: QueueId): Promise<unknown>
  /** Answers the child's own request as the user. */
  resolveChild(input: { child: SessionId; requestId: RequestId; decision: { kind: "approve"; scope: "once" } | { kind: "deny" } | { kind: "answer"; text: string; answers: string[][] }; clientId: string | undefined }): Promise<void>
  /** Who waits for `launcher`, told to every local terminal so the one with another session open can see it; no children says nothing waits now. */
  announce(waiting: { launcher: SessionId; launcherTitle: string; total: number; children: Array<{ sessionId: SessionId; title: string }> }): void
  delayMs?: number
}) {
  const waiting = new Map<RequestId, Waiting>()
  const cards = new Map<SessionId, Card>()
  const singles = new Map<RequestId, Single>()
  const timers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  const delay = deps.delayMs ?? GROUP_DELAY_MS
  const announced = new Map<SessionId, string>()
  let stopped = false

  const forLauncher = (launcher: SessionId) => [...waiting.values()].filter((entry) => entry.launcher === launcher)

  function withdraw(requestId: RequestId, at: SessionId, resolution: "answered" | "abandoned", clientId?: string) {
    try { deps.emit({ type: "server.request.resolved", sessionId: at, requestId, resolution, ...(clientId ? { byClientId: clientId as never } : {}) }) } catch { /* the session is gone */ }
  }
  function closeCard(launcher: SessionId, resolution: "answered" | "abandoned" = "abandoned", clientId?: string) {
    const card = cards.get(launcher)
    if (!card) return
    cards.delete(launcher)
    withdraw(card.requestId, card.at, resolution, clientId)
  }
  function closeSingles(launcher: SessionId) {
    for (const single of [...singles.values()]) if (single.launcher === launcher) { singles.delete(single.requestId); withdraw(single.requestId, single.at, "abandoned") }
  }

  /** The launcher's approvals as the terminals' notice says them; sent again only when they change. */
  function waitingFor(launcher: SessionId) {
    const approvals = forLauncher(launcher).filter((entry) => entry.approval)
    return { launcher, launcherTitle: clip(deps.mask(launcher, deps.title(launcher)), 60), total: approvals.length, children: approvals.slice(0, MAX_LISTED).map((entry) => ({ sessionId: entry.child, title: clip(deps.mask(entry.child, entry.title) || entry.child, 60) })) }
  }
  function announce(launcher: SessionId) {
    if (stopped) return
    const waitingNow = waitingFor(launcher)
    const key = JSON.stringify(waitingNow.children)
    if ((announced.get(launcher) ?? "[]") === key) return
    if (waitingNow.total) announced.set(launcher, key)
    else announced.delete(launcher)
    try { deps.announce(waitingNow) } catch { /* no terminal to tell */ }
  }

  const line = (entry: Waiting, at: SessionId) => `${clip(deps.mask(at, entry.title), 60)} · ${entry.approval ? (entry.tool ?? "approval") : "question, answer it in that session"}: ${clip(deps.mask(at, entry.detail), SHOWN_DETAIL)}`

  function notice(entries: Waiting[]) {
    const lines = entries.map((entry) => `- ${entry.child} ${JSON.stringify(deps.mask(entry.child, entry.title))}: ${entry.approval ? `approval for ${entry.tool ?? "a tool"}` : "a question"}: ${JSON.stringify(clip(deps.mask(entry.child, entry.detail), SHOWN_DETAIL))}`)
    return `Internal notification. ${entries.length === 1 ? "A session you started is" : `${entries.length} sessions you started are`} blocked waiting for the user's approval:\n${lines.join("\n")}\n\nThe user has been shown one card for them in MendCode. You cannot approve, and polling does not help: do not retry the work another way. Tell the user these wait for them, and continue with what does not depend on them.`
  }

  function groupCard(launcher: SessionId, at: SessionId, entries: Waiting[]): Card {
    const listed = entries.slice(0, MAX_LISTED)
    const more = entries.length - listed.length
    const requestId = deps.requestId()
    const count = listed.length
    const context = [...listed.map((entry) => `• ${line(entry, at)}`), ...(more > 0 ? [`… and ${more} more: answer them in their own sessions`] : []), "", "Allow all allows exactly these, once each."].join("\n")
    deps.emit({
      type: "server.request", sessionId: at, requestId, turnId: deps.turnOf(at) ?? deps.turnId(), kind: "approval", async: true,
      title: `${count} child session${count === 1 ? "" : "s"} waiting for approval`, detail: context.slice(0, 4000),
      options: [{ label: `${APPROVE_ALL} (${count})` }, { label: DENY_ALL }, { label: ONE_BY_ONE }],
    })
    return { requestId, at, launcher, items: listed.map((entry) => entry.requestId) }
  }

  function singleCard(entry: Waiting, at: SessionId) {
    const requestId = deps.requestId()
    const mirror = entry.mirror
    const options = mirror ? mirror.options : [APPROVE_ONE, DENY_ONE]
    deps.emit({
      type: "server.request", sessionId: at, requestId, turnId: deps.turnOf(at) ?? deps.turnId(), kind: mirror ? "question" : "approval", async: true,
      title: deps.mask(at, `${entry.title || entry.child} ${mirror ? "asks you" : "waits for approval"}`).slice(0, 500),
      ...(mirror ? {
        detail: "",
        questions: [{
          header: deps.mask(at, mirror.header).slice(0, 30) || "Child",
          question: deps.mask(at, mirror.question).slice(0, 500),
          options: options.map((label) => ({ label })), custom: false,
          context: deps.mask(at, `Session ${entry.child}\n${mirror.context}`).slice(0, 4000),
        }],
      } : {
        detail: deps.mask(at, `${entry.tool ?? "Tool"}: ${clip(entry.detail, 4000)}`).slice(0, 4000),
        options: options.map((label) => ({ label })),
        ...(entry.tool ? { tool: entry.tool } : {}),
      }),
    })
    singles.set(requestId, { requestId, at, target: entry.requestId, launcher: entry.launcher, options })
  }

  function flush(launcher: SessionId) {
    timers.delete(launcher)
    if (stopped) return
    const entries = forLauncher(launcher)
    const fresh = entries.filter((entry) => !entry.announced)
    if (fresh.length) {
      for (const entry of fresh) entry.announced = true
      void deps.notify(launcher, notice(fresh), deps.queueId()).catch(() => undefined)
    }
    // A choice a child asks (a settings proposal, a question with options) is shown to the user as it is: a headless child has no one to see it.
    const at = deps.humanSessions(launcher)[0]
    if (at) for (const entry of entries) if (entry.mirror && !entry.mirrored) { entry.mirrored = true; singleCard(entry, at) }
    announce(launcher)
    const approvals = entries.filter((entry) => entry.approval)
    const open = cards.get(launcher)
    if (!approvals.length) return closeCard(launcher)
    // The same requests are already on the card: leave it where the user is looking at it.
    if (open && open.items.length === Math.min(approvals.length, MAX_LISTED) && open.items.every((id) => waiting.has(id))) return
    closeCard(launcher)
    if (at) cards.set(launcher, groupCard(launcher, at, approvals))
  }

  function schedule(launcher: SessionId) {
    if (stopped || timers.has(launcher)) return
    const timer = setTimeout(() => flush(launcher), delay)
    timer.unref?.()
    timers.set(launcher, timer)
  }

  async function answerItems(items: RequestId[], approve: boolean, clientId: string | undefined) {
    for (const requestId of items) {
      const entry = waiting.get(requestId)
      if (!entry) continue
      await deps.resolveChild({ child: entry.child, requestId, decision: approve ? { kind: "approve", scope: "once" } : { kind: "deny" }, clientId }).catch(() => undefined)
    }
  }

  return {
    observe(event: SessionEvent) {
      if (event.type === "server.request") {
        if (event.async) return
        const launcher = deps.launcherOf(event.sessionId)
        if (!launcher || launcher === event.sessionId) return
        const approval = event.kind === "approval" && event.tool !== "plan_review"
        const asked = event.kind === "question" && !event.planReview ? (event.questions?.length === 1 ? event.questions[0] : event.questions ? undefined : event.options?.length ? { header: "Question", question: event.title, options: event.options, context: event.detail } : undefined) : undefined
        const mirror = asked && asked.options.length > 0 && !asked.multiple ? { header: asked.header, question: asked.question, options: asked.options.map((option) => option.label), context: `${asked.context ?? ""}\n${event.detail}`.trim() } : undefined
        waiting.set(event.requestId, { child: event.sessionId, requestId: event.requestId, launcher, approval, title: deps.title(event.sessionId), tool: "tool" in event ? event.tool : undefined, detail: firstLine(event.detail || event.title || ""), announced: false, mirror, mirrored: false })
        schedule(launcher)
        return
      }
      if (event.type === "server.request.resolved") {
        const entry = waiting.get(event.requestId)
        if (entry) { waiting.delete(event.requestId); announce(entry.launcher); schedule(entry.launcher) }
      }
    },
    /** An answer to one of these cards; undefined when the request is not one. Only the user's own terminal answers it. */
    resolve(command: Extract<Command, { type: "request.resolve" }>, human: boolean): { ok: true } | { ok: false; code: "forbidden" | "invalid_command"; message: string } | undefined {
      const card = [...cards.values()].find((entry) => entry.requestId === command.requestId)
      const single = singles.get(command.requestId)
      const at = card?.at ?? single?.at
      if (!at || at !== command.sessionId) return undefined
      const decision = command.decision
      // Dismissing a card answers nothing: the children keep waiting and the card comes back when the group changes.
      if (decision.kind === "deny") {
        if (card) { cards.delete(card.launcher); withdraw(card.requestId, card.at, "abandoned", command.clientId) }
        else if (single) { singles.delete(single.requestId); withdraw(single.requestId, single.at, "abandoned", command.clientId) }
        return { ok: true }
      }
      if (!human) return { ok: false, code: "forbidden", message: "[DAEMON]: a child's approval is answered only from a local terminal of the user" }
      if (decision.kind !== "answer") return { ok: false, code: "invalid_command", message: "[DAEMON]: this card takes an answer or a dismissal" }
      const answer = (decision.answers?.[0]?.[0] ?? decision.text).trim()
      if (card) {
        cards.delete(card.launcher)
        withdraw(card.requestId, card.at, "answered", command.clientId)
        if (answer.startsWith(APPROVE_ALL)) void answerItems(card.items, true, command.clientId)
        else if (answer === DENY_ALL) void answerItems(card.items, false, command.clientId)
        else if (answer === ONE_BY_ONE) for (const id of card.items) { const entry = waiting.get(id); if (entry) singleCard(entry, card.at) }
        return { ok: true }
      }
      singles.delete(single!.requestId)
      withdraw(single!.requestId, single!.at, "answered", command.clientId)
      const target = waiting.get(single!.target)
      if (target?.mirror) {
        if (single!.options.includes(answer)) void deps.resolveChild({ child: target.child, requestId: target.requestId, decision: { kind: "answer", text: answer, answers: [[answer]] }, clientId: command.clientId }).catch(() => undefined)
      } else if (answer === APPROVE_ONE || answer === DENY_ONE) void answerItems([single!.target], answer === APPROVE_ONE, command.clientId)
      return { ok: true }
    },
    /** What waits now, for a terminal that connects. */
    snapshot: () => [...announced.keys()].map(waitingFor),
    /** What waits for `launcher` right now. */
    pending: (launcher: SessionId) => forLauncher(launcher).map((entry) => ({ child: entry.child, requestId: entry.requestId, approval: entry.approval })),
    forget(sessionId: SessionId) {
      for (const [id, entry] of waiting) if (entry.child === sessionId || entry.launcher === sessionId) { waiting.delete(id); if (entry.launcher !== sessionId) schedule(entry.launcher) }
      closeCard(sessionId)
      closeSingles(sessionId)
      for (const launcher of new Set([...announced.keys(), sessionId])) announce(launcher)
    },
    stop() {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const launcher of [...cards.keys()]) closeCard(launcher)
      for (const single of [...singles.values()]) { singles.delete(single.requestId); withdraw(single.requestId, single.at, "abandoned") }
    },
  }
}
