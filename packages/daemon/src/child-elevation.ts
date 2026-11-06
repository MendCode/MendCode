import type { SessionEventDraft } from "@mendcode/kernel"
import { launchOf } from "@mendcode/protocol/launch"
import { permissionRank, type Command, type PermissionMode, type RequestId, type SessionId, type TurnId } from "@mendcode/protocol"
import type { AgentOrigin } from "./agent-origin"

/** How long the card waits for the user; no answer keeps the refusal. */
export const ELEVATION_WAIT_MS = 120_000
/** The highest mode a session can ask for on a card: it never asks for `full`. */
const HIGHEST: PermissionMode = "smart"
const SHOWN_PROMPT = 1200
const APPROVE = "Approve once"
/** Only the user picks this, on the card itself: the asking session cannot request it. */
const APPROVE_FULL = "Approve in full access"
const DENY = "Deny"

export type ChildFacts = { title: string; directory: string; model: string; agent?: string | undefined; addDirs?: readonly string[] | undefined; maxTurns?: number | undefined; systemPrompt?: "replaced" | "appended" | undefined }

/** `mode` is set when the user picked full access on the card instead of the mode asked for. */
type Pending = { sessionId: SessionId; finish(outcome: "approved" | "denied" | "abandoned", clientId?: string, mode?: PermissionMode): void }
/** A child the user approved: the one prompt it was approved for, until it is submitted. */
type Approved = { launcher: string; text: string; images: number; used: boolean }

/**
 * A session asking to start a child above its own permission mode (docs/permissions.md, "A child with more authority").
 * The daemon never grants it by itself: one card goes to a local terminal the user has on the launching session (or, failing
 * that, on another session of its project), naming the model, the folder, the mode, the title and the prompt. Approving it
 * sets the child's mode once (the one asked for, or full access when the user picks it there: a session never asks for full)
 * and lets exactly that prompt through; denying it, no answer, no such terminal, or a remote or
 * peer client leaves the refusal in place. The approved child takes no other work from the session that started it.
 * Core permission rule: every tier.
 */
export function createChildElevation(deps: {
  /** Sessions a local, interactive terminal of the user (not a session's shell, not remote, not a peer) has open, the launcher's first. */
  humanSessions(launcher: SessionId): SessionId[]
  turnOf(sessionId: SessionId): TurnId | undefined
  requestId(): RequestId
  turnId(): TurnId
  emit(event: SessionEventDraft): void
  mask(sessionId: SessionId, text: string): string
  facts(child: SessionId): ChildFacts
  /** Whether the child is untouched: no turn, nothing queued. */
  fresh(child: SessionId): boolean
  apply(child: SessionId, mode: PermissionMode, clientId: string | undefined): Promise<void>
  waitMs?: number
}) {
  const pending = new Map<RequestId, Pending>()
  const asking = new Set<string>()
  const approved = new Map<string, Approved>()
  const wait = deps.waitMs ?? ELEVATION_WAIT_MS

  function card(input: { launcher: SessionId; child: SessionId; mode: PermissionMode; ceiling: PermissionMode; text: string; images: number; at: SessionId }) {
    const facts = deps.facts(input.child)
    const safe = (text: string) => deps.mask(input.at, text)
    const prompt = input.text.length > SHOWN_PROMPT ? `${input.text.slice(0, SHOWN_PROMPT)}… (${input.text.length} characters)` : input.text
    const lines = [
      `Session "${deps.facts(input.launcher).title || input.launcher}" (${input.ceiling}) asks to start a child in ${input.mode}.`,
      `Title: ${facts.title || "(none)"}`,
      `Model: ${facts.model}${facts.agent ? ` · agent ${facts.agent}` : ""}`,
      `Folder: ${facts.directory}`,
      ...(facts.addDirs?.length ? [`Extra folders: ${facts.addDirs.join(", ")}`] : []),
      `Permission: ${input.mode}${facts.maxTurns ? ` · at most ${facts.maxTurns} turns` : ""}`,
      ...(facts.systemPrompt ? [`System prompt: ${facts.systemPrompt} by the caller`] : []),
      ...(input.images ? [`Images: ${input.images}`] : []),
      "Prompt:",
      prompt,
      "",
      `Approving runs this one prompt in ${input.mode}; the launching session cannot send that child anything else. No answer in ${Math.round(wait / 1000)} s keeps the refusal.`,
      "Full access is your choice only: the child asks nothing, running every edit and command unless a rule denies it.",
    ]
    return {
      title: safe(`Start a child in ${input.mode}?`).slice(0, 500),
      questions: [{
        header: "Child permission",
        question: safe(`Start "${facts.title || input.child}" in ${input.mode} with ${facts.model}?`).slice(0, 500),
        options: [{ label: APPROVE, description: `This child only, in ${input.mode}` }, { label: APPROVE_FULL, description: "This child only, in full: asks nothing" }, { label: DENY }],
        custom: false,
        context: safe(lines.join("\n")).slice(0, 4000),
      }],
    }
  }

  return {
    /**
     * Asks the user. Resolves with undefined when approved (the mode is set), or the reason the refusal stands. `alive` is
     * checked once more before the mode is set: a caller that went away gets nothing.
     */
    async request(input: { origin: AgentOrigin; child: SessionId; mode: PermissionMode; ceiling: PermissionMode; text: string; images: number; startedByCaller: boolean; alive(): boolean }): Promise<string | undefined> {
      const launcher = input.origin.sessionId as SessionId | undefined
      if (!launcher) return "the calling session cannot be identified, so there is no one to ask"
      if (permissionRank(input.mode) > permissionRank(HIGHEST)) return `${input.mode} is never approved this way`
      if (!input.startedByCaller) return "only a session the caller just started can be approved into a higher mode"
      if (!deps.fresh(input.child) || approved.has(input.child)) return "the child has already run; only a new one can be approved"
      if (asking.has(input.child)) return "an approval for this child is already open"
      const at = deps.humanSessions(launcher)[0]
      if (!at) return "no one has the launching session or its project open in a local terminal to approve it (headless runs, loops, remote and peer clients cannot)"
      const requestId = deps.requestId()
      const shown = card({ launcher, child: input.child, mode: input.mode, ceiling: input.ceiling, text: input.text, images: input.images, at })
      asking.add(input.child)
      const outcome = await new Promise<{ result: "approved" | "denied" | "abandoned"; clientId?: string | undefined; mode?: PermissionMode | undefined }>((resolve) => {
        const timer = setTimeout(() => entry.finish("abandoned"), wait)
        timer.unref?.()
        const entry: Pending = {
          sessionId: at,
          finish(result, clientId, mode) {
            if (!pending.delete(requestId)) return
            clearTimeout(timer)
            try { deps.emit({ type: "server.request.resolved", sessionId: at, requestId, resolution: result, ...(clientId ? { byClientId: clientId as never } : {}) }) } catch { /* the session is gone */ }
            resolve({ result, clientId, mode })
          },
        }
        pending.set(requestId, entry)
        deps.emit({ type: "server.request", sessionId: at, requestId, turnId: deps.turnOf(at) ?? deps.turnId(), kind: "question", async: true, title: shown.title, detail: "", questions: shown.questions })
      })
      asking.delete(input.child)
      if (outcome.result === "denied") return "the user denied it"
      if (outcome.result === "abandoned") return `no one answered within ${Math.round(wait / 1000)} s`
      if (!input.alive() || !deps.fresh(input.child)) return "the caller went away or the child changed before the approval"
      approved.set(input.child, { launcher, text: input.text, images: input.images, used: false })
      await deps.apply(input.child, outcome.mode ?? input.mode, outcome.clientId)
      return undefined
    },
    /** An answer to one of these cards; undefined when the request is not one. Only the user's own terminal answers it. */
    resolve(command: Extract<Command, { type: "request.resolve" }>, human: boolean): { ok: true } | { ok: false; code: "forbidden" | "invalid_command"; message: string } | undefined {
      const entry = pending.get(command.requestId)
      if (!entry || entry.sessionId !== command.sessionId) return undefined
      const decision = command.decision
      if (decision.kind === "deny") return entry.finish("denied", command.clientId), { ok: true }
      if (!human) return { ok: false, code: "forbidden", message: "[DAEMON]: a child's higher permission is approved only from a local terminal" }
      if (decision.kind !== "answer") return { ok: false, code: "invalid_command", message: "[DAEMON]: this card takes an answer or a dismissal" }
      const answer = (decision.answers?.[0]?.[0] ?? decision.text).trim()
      if (answer === APPROVE_FULL) entry.finish("approved", command.clientId, "full")
      else entry.finish(answer === APPROVE ? "approved" : "denied", command.clientId)
      return { ok: true }
    },
    /**
     * What the session that started an approved child may still send it: the one approved prompt, cancelling, denying,
     * lowering its mode, and removing it. Undefined when allowed (or the target is no such child).
     */
    check(origin: AgentOrigin, command: Command, ceiling: PermissionMode): string | undefined {
      const target = "sessionId" in command && typeof command.sessionId === "string" ? command.sessionId : undefined
      const child = target ? approved.get(target) : undefined
      if (!child || child.launcher !== origin.sessionId) return undefined
      if (["turn.cancel", "request.resolve", "session.delete", "session.archive", "session.rename", "session.fork"].includes(command.type)) return undefined
      if (command.type === "session.permission.set" && permissionRank(command.mode) <= permissionRank(ceiling)) return undefined
      if (command.type === "user.submit" || command.type === "commands.execute") {
        const launch = launchOf(command)
        if (!child.used && launch && launch.text === child.text && launch.images === child.images) {
          child.used = true
          return undefined
        }
      }
      return `${command.type}: the user approved this child for one prompt; it takes no other work from the session that started it`
    },
    forget(sessionId: string) { approved.delete(sessionId) },
    stop() { for (const entry of [...pending.values()]) entry.finish("abandoned") },
  }
}
