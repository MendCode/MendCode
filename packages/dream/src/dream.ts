import { MEMORY_CATEGORIES, type MemoryEntry, type SessionEvent } from "@mendcode/protocol"
import { z } from "zod"
import { sessionDigest, type DigestCache } from "./digest"

/** `revisions` caps updates + archives together; `memories`/`memoryChars` bound the saved memories shown to the model. */
export const DREAM_LIMITS = { sessions: 12, evidenceChars: 40_000, proposals: 5, revisions: 5, memories: 60, memoryChars: 8_000 } as const

/** A bounded slice of one recent conversation (its digest): what the user asked and what the agent concluded. */
export type Evidence = {
  sessionId: string
  title: string
  lines: string[]
  /** Set when the evidence comes from a digest: built now or reused from the cache. */
  digest?: "built" | "reused"
  messages?: number
  redactions?: number
  corrections?: string[]
  preferences?: string[]
}

/** One session Dream may read: `events` may be a function so a cached digest spares reading the log; `seq` is the session's last event number. */
export type DreamSession = { sessionId: string; title: string; seq?: number; events: SessionEvent[] | (() => SessionEvent[]) }

/**
 * The digests of the newest sessions (at most DREAM_LIMITS.sessions, DREAM_LIMITS.evidenceChars in all), reused from
 * `cache` for sessions that have not changed. No tool output, no reasoning, secrets redacted. Pure apart from the cache.
 */
export function collectEvidence(sessions: DreamSession[], options: { cache?: DigestCache } = {}): Evidence[] {
  const out: Evidence[] = []
  let used = 0
  for (const session of sessions.slice(0, DREAM_LIMITS.sessions)) {
    const { digest, origin } = sessionDigest({ sessionId: session.sessionId, seq: session.seq, events: session.events, cache: options.cache })
    if (digest.lines.length === 0) continue
    const size = digest.lines.reduce((total, line) => total + line.length, 0)
    if (used + size > DREAM_LIMITS.evidenceChars) break
    used += size
    out.push({ sessionId: session.sessionId, title: session.title, lines: digest.lines, digest: origin, messages: digest.messages, redactions: digest.redactions, corrections: digest.corrections, preferences: digest.preferences })
  }
  return out
}

/** The categories a proposal may name (`volatile` is for what must not be kept, so the model is not offered it). */
const PROPOSAL_CATEGORIES = MEMORY_CATEGORIES.filter((category) => category.id !== "volatile").map((category) => category.id)

/** The instruction for one Dream run; the model must answer with JSON only. */
export function dreamPrompt(input: { directory: string; evidence: Evidence[]; memories: MemoryEntry[] }) {
  const label = (m: MemoryEntry) => `[${m.scope}${m.category ? `/${m.category}` : ""}${m.status === "pending" ? ", pending" : ""}]`
  const savedEntries = boundedSaved(input.memories)
  const saved = [
    ...savedEntries.map((m) => `- ${m.memoryId} ${label(m)} ${m.text.replace(/\s+/g, " ")}`),
    ...input.memories.filter((m) => m.status === "pending" && m.kind !== "update" && m.kind !== "archive").map((m) => `- (pending, no id) ${label(m)} ${m.text.replace(/\s+/g, " ")}`),
  ]
  const sessions = input.evidence.map((e) => `### ${e.title || e.sessionId}\n${e.lines.join("\n")}`)
  return [
    `You maintain long-term memory for a coding assistant working in ${input.directory}.`,
    "From the recent conversations below, propose at most 5 NEW durable memories: stable facts, conventions, commands, preferences or decisions that will matter in future sessions.",
    "Rules: do not repeat anything already remembered (listed below); skip one-off details, secrets, credentials and personal data; state each memory on its own, specific and verbatim where exact values matter; scope \"user\" only for preferences that apply to every project, otherwise \"project\".",
    `Also review the remembered items that have an id. Propose an UPDATE (id plus the full corrected text) when a memory is outdated, imprecise or contradicted by newer conversations, and an ARCHIVE (id) when it is stale, no longer true or superseded. At most ${DREAM_LIMITS.revisions} updates and archives together, only with clear evidence in the conversations, using only ids listed below. Never add a NEW memory that merely restates a correction: use an update for it.`,
    `Answer with JSON only, no prose: {"proposals":[{"text":"…","scope":"project|user","category":"${PROPOSAL_CATEGORIES.join("|")}","why":"which conversation shows it","confidence":0.7,"durability":0.7,"changeRisk":0.3,"sensitivity":"low"}],"updates":[{"id":"memory id","text":"…","why":"what changed"}],"archives":[{"id":"memory id","why":"why it is stale"}],"notes":"duplicates or stale memories you noticed, or empty"}. Scores are 0 to 1: confidence in the evidence, durability across sessions, and risk of applying. Never inflate them to bypass host review.`,
    "",
    "## Already remembered",
    saved.length ? saved.join("\n") : "(nothing yet)",
    "",
    "## Recent conversations",
    sessions.join("\n\n"),
  ].join("\n")
}

const Proposal = z.object({
  text: z.string().min(8).max(500),
  scope: z.enum(["project", "user"]).catch("project"),
  category: z.string().max(40).catch("other"),
  why: z.string().max(300).catch(""),
  confidence: z.number().min(0).max(1).optional(),
  durability: z.number().min(0).max(1).optional(),
  changeRisk: z.number().min(0).max(1).optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
})
const Update = z.object({ id: z.string().min(1).max(100), text: z.string().min(8).max(500), why: z.string().max(300).catch("") })
const Archive = z.object({ id: z.string().min(1).max(100), why: z.string().max(300).catch("") })
const DreamOutput = z.object({
  proposals: z.array(z.unknown()).max(50).catch([]),
  updates: z.array(z.unknown()).max(50).catch([]),
  archives: z.array(z.unknown()).max(50).catch([]),
  notes: z.string().max(2_000).catch(""),
})

export type DreamProposal = z.infer<typeof Proposal>
/** A change to an existing saved memory. `text` is the new text (update) or the current text (archive). */
export type DreamRevision = { kind: "update" | "archive"; targetId: string; text: string; reason: string }

/** The saved memories the model may revise: newest first, at most DREAM_LIMITS.memories and memoryChars in total. */
function boundedSaved(memories: MemoryEntry[]) {
  const out: MemoryEntry[] = []
  let used = 0
  for (const memory of memories.filter((m) => m.status === "saved").slice(0, DREAM_LIMITS.memories)) {
    used += memory.text.length
    if (used > DREAM_LIMITS.memoryChars) break
    out.push(memory)
  }
  return out
}

/**
 * Parses the model's JSON (tolerating a surrounding code fence), drops invalid proposals and exact or
 * near duplicates of existing memories, and keeps at most DREAM_LIMITS.proposals.
 */
export function parseDreamOutput(text: string, existing: MemoryEntry[]): { proposals: DreamProposal[]; revisions: DreamRevision[]; notes: string; refused: DreamRefusal[] } | { error: string } {
  const json = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ""))?.[0]
  if (!json) return { error: "no JSON object in the model output" }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { error: "invalid JSON in the model output" }
  }
  const parsed = DreamOutput.safeParse(raw)
  if (!parsed.success) return { error: "unexpected JSON shape in the model output" }
  const refused: DreamRefusal[] = []
  const known = new Set(existing.map((m) => normalize(m.text)))
  const proposals: DreamProposal[] = []
  for (const item of parsed.data.proposals) {
    const proposal = Proposal.safeParse(item)
    if (!proposal.success) {
      refused.push({ item: describe(item), reason: "not a valid proposal (text of 8 to 500 characters)" })
      continue
    }
    const key = normalize(proposal.data.text)
    if (known.has(key)) {
      refused.push({ item: proposal.data.text, reason: "already remembered or repeated in this run" })
      continue
    }
    if (proposals.length >= DREAM_LIMITS.proposals) {
      refused.push({ item: proposal.data.text, reason: `over the limit of ${DREAM_LIMITS.proposals} new memories per run` })
      continue
    }
    known.add(key)
    proposals.push(proposal.data)
  }
  const revisions = parseRevisions(parsed.data.updates, parsed.data.archives, existing, known, refused)
  // A new memory that restates an update the user will review is the same idea twice: keep the update.
  const updates = revisions.filter((r) => r.kind === "update")
  const kept = proposals.filter((p) => {
    const restates = updates.some((r) => overlap(p.text, r.text) >= 0.7)
    if (restates) refused.push({ item: p.text, reason: "restates an update proposed in this run" })
    return !restates
  })
  return { proposals: kept, revisions, notes: parsed.data.notes, refused }
}

/** Something the model proposed and Dream did not take, with the reason (for the run's safety report). */
export type DreamRefusal = { item: string; reason: string }

function describe(item: unknown) {
  const text = typeof item === "object" && item !== null && "text" in item ? (item as { text: unknown }).text : undefined
  return typeof text === "string" && text.trim() ? text.trim() : "(unreadable item)"
}

/** Share of the shorter text's words (3+ letters) that also appear in the other one. */
function overlap(a: string, b: string) {
  const words = (text: string) => new Set(normalize(text).split(" ").filter((word) => word.length >= 3))
  const [left, right] = [words(a), words(b)]
  const shared = [...left].filter((word) => right.has(word)).length
  return shared / Math.max(1, Math.min(left.size, right.size))
}

/**
 * Keeps only revisions of saved memories the model was shown: the id must exist, an update must really
 * change the text and not copy another memory, and each memory gets one revision (also none while one is pending).
 */
function parseRevisions(updates: unknown[], archives: unknown[], existing: MemoryEntry[], known: Set<string>, refused: DreamRefusal[]): DreamRevision[] {
  const targets = new Map(boundedSaved(existing).map((m) => [m.memoryId as string, m]))
  const busy = new Set(existing.filter((m) => m.status === "pending" && m.targetId).map((m) => m.targetId as string))
  const out: DreamRevision[] = []
  /** Why `id` cannot be revised now, or undefined when it can. */
  const blocked = (id: string) => (!targets.has(id) ? "not a saved memory that was shown" : busy.has(id) ? "that memory already has a revision waiting" : out.length >= DREAM_LIMITS.revisions ? `over the limit of ${DREAM_LIMITS.revisions} revisions per run` : undefined)
  for (const item of updates) {
    const update = Update.safeParse(item)
    if (!update.success) {
      refused.push({ item: `update: ${describe(item)}`, reason: "not a valid update (id and text of 8 to 500 characters)" })
      continue
    }
    const reason = blocked(update.data.id)
    if (reason) {
      refused.push({ item: `update ${update.data.id}`, reason })
      continue
    }
    const target = targets.get(update.data.id)!
    const key = normalize(update.data.text)
    if (key === normalize(target.text) || known.has(key)) {
      refused.push({ item: `update ${update.data.id}`, reason: "does not change the text, or copies another memory" })
      continue
    }
    known.add(key)
    busy.add(update.data.id)
    out.push({ kind: "update", targetId: update.data.id, text: update.data.text.trim(), reason: update.data.why })
  }
  for (const item of archives) {
    const archive = Archive.safeParse(item)
    if (!archive.success) {
      refused.push({ item: "archive: (unreadable item)", reason: "not a valid archive (needs an id)" })
      continue
    }
    const reason = blocked(archive.data.id)
    if (reason) {
      refused.push({ item: `archive ${archive.data.id}`, reason })
      continue
    }
    busy.add(archive.data.id)
    out.push({ kind: "archive", targetId: archive.data.id, text: targets.get(archive.data.id)!.text, reason: archive.data.why })
  }
  return out
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}
