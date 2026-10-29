import { DREAM_DEFAULT_MAX_TOKENS, redactSecrets, type DreamReport, type EvolutionMode, type MemoryEntry } from "@mendcode/protocol"
import { collectEvidence, dreamPrompt, parseDreamOutput, type DreamProposal, type DreamRefusal, type DreamRevision, type DreamSession, type Evidence } from "./dream"
import type { DigestCache } from "./digest"
import { runEvolution, type EvolutionPort } from "./evolution"
import { createMeter, type Completion } from "./meter"

export type DreamResult =
  | { status: "done"; proposed: number; notes: string; proposals: DreamProposal[]; revisions: DreamRevision[]; report: DreamReport }
  | { status: "skipped"; reason: string; report: DreamReport }
  | { status: "failed"; error: string; report: DreamReport }

/** What becomes of a proposal the agent or Dream makes: waits for review, is saved directly (category policy `auto`), or is dropped (`never`). */
export type ProposalOutcome = "pending" | "saved" | "dropped"

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * One Dream run for a project: read-only over sessions and memories, model calls without tools, then proposals handed to
 * `propose` (the category policy decides there whether each waits, is saved or is dropped). It never edits files, never
 * runs commands and never changes a saved memory (revisions wait for review). Every run ends with a safety report: what
 * it read, what it proposed, what it refused and why, secrets redacted, model usage and whether the token budget stopped it.
 */
export async function runDream(input: {
  directory: string
  sessions(directory: string): DreamSession[]
  memories(directory: string): MemoryEntry[]
  /** One tool-less completion; with token counts when the provider reports them (otherwise they are estimated). */
  complete(prompt: string, signal: AbortSignal): Promise<Completion>
  /** `forceReview`: the text had a secret redacted, so it must not be saved without a person looking (whatever the policy). `cap`: the policy may at most send it to review. */
  propose(entry: { scope: "user" | "project"; directory?: string; text: string; category: string; forceReview?: boolean; cap?: "review"; details?: MemoryEntry["details"] }): ProposalOutcome | void
  /** A pending update/archive of a saved memory; never applied without the user's review. */
  revise?(entry: { kind: "update" | "archive"; targetId: string; text: string; reason: string }): void
  signal: AbortSignal
  /** Cooperative yield between steps (JobScheduler checkpoint: waits while foreground work runs). */
  checkpoint?(): Promise<void>
  /** Model tokens the whole run may spend; DREAM_DEFAULT_MAX_TOKENS when unset. */
  maxTokens?: number
  /** Where session digests are cached; without it they are built every run. */
  digests?: DigestCache
  /** What Evolution does in this run (off or absent: nothing) and where it keeps what it learns. */
  evolution?: { mode: EvolutionMode; port: EvolutionPort; runId?: number; workflows?: boolean }
}): Promise<DreamResult> {
  const limit = input.maxTokens ?? DREAM_DEFAULT_MAX_TOKENS
  const meter = createMeter({ limit, complete: input.complete, signal: input.signal })
  const refused: DreamRefusal[] = []
  const proposed: DreamReport["proposed"] = []
  const failures: string[] = []
  const redactions = { evidence: 0, proposals: 0 }
  const read: DreamReport["read"] = { sessions: [], memories: 0, promptChars: 0 }
  let evolution: DreamReport["evolution"]

  const report = (): DreamReport => ({
    read,
    proposed: proposed.slice(0, 12),
    refused: refused.slice(0, 20).map((entry) => ({ item: clip(redactSecrets(entry.item).text.replace(/\s+/g, " "), 120), reason: clip(entry.reason, 120) })),
    redactions,
    ...meter.snapshot(),
    ...(evolution ? { evolution } : {}),
    failures: failures.slice(0, 5).map((failure) => clip(failure, 200)),
  })
  const skipped = (reason: string): DreamResult => ({ status: "skipped", reason, report: report() })
  const failed = (error: string): DreamResult => {
    failures.push(error)
    return { status: "failed", error, report: report() }
  }

  const evidence: Evidence[] = collectEvidence(input.sessions(input.directory), input.digests ? { cache: input.digests } : {})
  for (const item of evidence.slice(0, 12)) {
    read.sessions.push({ sessionId: clip(item.sessionId, 64), title: clip(item.title, 80), digest: item.digest ?? "built", messages: item.messages ?? item.lines.length, redactions: item.redactions ?? 0 })
    redactions.evidence += item.redactions ?? 0
  }
  if (evidence.length === 0) return skipped("no recent conversations in this project")

  const memories = input.memories(input.directory)
  await input.checkpoint?.()
  const prompt = dreamPrompt({ directory: input.directory, evidence, memories })
  read.memories = memories.filter((memory) => memory.status !== "archived" && memory.kind !== "update" && memory.kind !== "archive").length
  read.promptChars += prompt.length
  let reply: { text: string } | { refused: string }
  try {
    reply = await meter.call(prompt, "Dream")
  } catch (error) {
    return failed(error instanceof Error ? error.message.slice(0, 500) : String(error))
  }
  if ("refused" in reply) return skipped(reply.refused)
  await input.checkpoint?.()
  const parsed = parseDreamOutput(reply.text, memories)
  if ("error" in parsed) return failed(parsed.error)
  refused.push(...parsed.refused)

  let landed = 0
  for (const proposal of parsed.proposals) {
    const safe = redactSecrets(proposal.text)
    redactions.proposals += safe.count
    const scope = proposal.scope
    const result =
      input.propose({
        scope,
        ...(scope === "project" ? { directory: input.directory } : {}),
        text: safe.text,
        category: proposal.category,
        ...([proposal.confidence, proposal.durability, proposal.changeRisk, proposal.sensitivity].some((value) => value !== undefined) ? { details: { ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}), ...(proposal.durability !== undefined ? { durability: proposal.durability } : {}), ...(proposal.changeRisk !== undefined ? { changeRisk: proposal.changeRisk } : {}), ...(proposal.sensitivity !== undefined ? { sensitivity: proposal.sensitivity } : {}) } } : {}),
        ...(safe.count > 0 ? { forceReview: true } : {}),
      }) ?? "pending"
    proposed.push({ kind: "new", category: clip(proposal.category, 64), scope, text: clip(safe.text, 160), outcome: result })
    if (result === "dropped") refused.push({ item: safe.text, reason: "the category policy drops proposals" })
    else landed++
  }
  const revisions = input.revise ? parsed.revisions : []
  for (const revision of revisions) {
    const target = memories.find((memory) => memory.memoryId === revision.targetId)
    const safe = redactSecrets(revision.text)
    redactions.proposals += safe.count
    input.revise!(revision)
    proposed.push({ kind: revision.kind, category: clip(target?.category ?? "other", 64), ...(target && target.scope !== "session" ? { scope: target.scope } : {}), text: clip(safe.text, 160), outcome: "pending" })
    landed++
  }

  if (input.evolution && input.evolution.mode !== "off") {
    await input.checkpoint?.()
    try {
      const outcome = await runEvolution({
        mode: input.evolution.mode,
        directory: input.directory,
        evidence,
        memories,
        port: input.evolution.port,
        meter,
        runId: input.evolution.runId,
        workflows: input.evolution.workflows,
        propose: (entry) => input.propose(entry) ?? "pending",
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
      })
      evolution = outcome.report
      refused.push(...outcome.refused)
      failures.push(...outcome.failures)
      for (const memory of outcome.memories) proposed.push({ kind: "new", category: clip(memory.category, 64), scope: "project", text: clip(memory.text, 160), outcome: memory.outcome })
      landed += outcome.memories.filter((memory) => memory.outcome !== "dropped").length + outcome.report.suggested.skills + outcome.report.suggested.instructions + (outcome.report.suggested.workflows ?? 0)
    } catch (error) {
      failures.push(`Evolution: ${error instanceof Error ? error.message.slice(0, 150) : String(error)}`)
    }
  }

  const snapshot = meter.snapshot()
  const notes = [parsed.notes, snapshot.budget.stopped ? snapshot.budget.reason : ""].filter(Boolean).join(" · ")
  return { status: "done", proposed: landed, notes, proposals: parsed.proposals, revisions, report: report() }
}
