import path from "node:path"
import { buildDigest, DIGEST_VERSION, type SessionDigest } from "@mendcode/dream"
import { redactSecrets, visibleEvents, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"

/** The whole note stays under this, whatever the sessions hold: it rides in the first message of a new chat. */
export const RESUME_MAX_CHARS = 1_800
const PER_PROJECT = 3
const OTHER_PROJECTS = 3
const WINDOW_MS = 7 * 86_400_000
/** Events read to build a digest of a session no cached digest covers (the newest ones carry where the work stands). */
const EVENTS_READ = 250

const squash = (text: string) => text.replace(/\s+/g, " ").trim()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const ago = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`
/** Loops, workflows and PR reviews are machinery, not work the user was doing. */
const machinery = (title: string) => /^(loop|workflow|pr review|review) ·/i.test(title)

type Session = ReturnType<Store["listSessions"]>[number]

/** What a session was for and where it stopped: its recap when one matches its last event, else its digest, else one built from its newest events. */
function stateOf(store: Store, session: Session): { goal: string; state: string } | undefined {
  const recap = store.sessionTree.recap(session.sessionId as SessionId, session.lastSeq)
  if (recap) {
    const lines = recap.text.split("\n").map(squash).filter(Boolean)
    if (lines.length) return { goal: clip(lines[0]!, 150), state: lines.length > 1 ? clip(lines[lines.length - 1]!, 200) : "" }
  }
  let digest: SessionDigest | undefined
  const cached = store.digests.get(session.sessionId as SessionId, { sourceSeq: session.lastSeq, version: DIGEST_VERSION })
  if (cached) try { digest = JSON.parse(cached) as SessionDigest } catch { digest = undefined }
  digest ??= buildDigest(visibleEvents(store.readAfter(session.sessionId as SessionId, Math.max(0, session.lastSeq - EVENTS_READ), EVENTS_READ)))
  const first = [...digest.lines].reverse().find((line) => line.startsWith("user:"))
  if (!first) return undefined
  const last = [...digest.lines].reverse().find((line) => line.startsWith("agent:"))
  return { goal: clip(first.slice(5).trim(), 120), state: last ? clip(last.slice(6).trim(), 160) : "" }
}

/**
 * The resume note of a new chat (feature `resume_context`): what the newest sessions of its project, and of other projects, were
 * doing, so the model starts knowing where the work stood. At most RESUME_MAX_CHARS, secrets redacted, empty when there is nothing.
 * It is read once, for the first message, and lives in the history from then on.
 */
export function resumeNote(input: { store: Store; sessionId: SessionId; directory: string; now: number }): string {
  const { store, directory, now } = input
  const recent = store.listSessions({ since: now - WINDOW_MS, hideEmpty: true, limit: 60 }).filter((session) => session.sessionId !== input.sessionId && !machinery(session.title))
  const here = recent.filter((session) => session.directory === directory).slice(0, PER_PROJECT)
  const seen = new Set<string>([directory])
  const elsewhere = recent.filter((session) => !seen.has(session.directory) && (seen.add(session.directory), true)).slice(0, OTHER_PROJECTS)
  const line = (session: Session, withProject: boolean) => {
    const found = stateOf(store, session)
    if (!found) return undefined
    const title = clip(squash(session.title), 50)
    return `- ${ago(now - session.updatedAt)} ago${withProject ? ` · ${path.basename(session.directory)}` : ""} · "${title}": ${found.goal}${found.state ? ` → ${found.state}` : ""}`
  }
  const projectLines = here.flatMap((session) => line(session, false) ?? [])
  const otherLines = elsewhere.flatMap((session) => line(session, true) ?? [])
  if (!projectLines.length && !otherLines.length) return ""
  const head = ["<resume>", "Earlier work, from the latest sessions (may be stale: check before acting on it; mention it only when it bears on the request)."]
  const body = [...(projectLines.length ? ["This project:", ...projectLines] : []), ...(otherLines.length ? ["Other projects:", ...otherLines] : [])]
  let text = redactSecrets([...head, ...body].join("\n")).text
  if (text.length > RESUME_MAX_CHARS - 10) text = `${text.slice(0, RESUME_MAX_CHARS - 12)}…`
  return `${text}\n</resume>`
}

const REMEMBERED = 200

/**
 * The resume note as part of the system prompt, never written to the session. It is built the first time a session without a finished
 * turn asks, then kept in memory so every request of that session carries the same text and the provider's cached prefix holds. After a
 * daemon restart a session that already has turns gets none (one prefix change); a new one gets a fresh note.
 */
export function createResumeSource(input: { store: Store; now(): number; enabled(): boolean }) {
  const frozen = new Map<string, string>()
  return (sessionId: SessionId, directory: string): string => {
    if (!input.enabled()) return ""
    const known = frozen.get(sessionId)
    if (known !== undefined) return known
    const info = input.store.sessionInfo(sessionId)
    if (!info || info.parentId) return ""
    const started = input.store.readAfter(sessionId, 0, 200).some((event) => event.type === "turn.completed")
    const note = started ? "" : resumeNote({ store: input.store, sessionId, directory, now: input.now() })
    frozen.set(sessionId, note)
    if (frozen.size > REMEMBERED) frozen.delete(frozen.keys().next().value!)
    return note
  }
}
