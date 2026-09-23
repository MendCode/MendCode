import { createHash } from "node:crypto"
import path from "node:path"
import { Flock } from "@mendcode/core/util/flock"
import { z } from "zod"
import { evolutionPaths, readEvolutionJSON, readEvolutionPolicy, writeEvolutionJSON } from "./config"
import { authorizeEvolutionAction } from "./policy"

const EvidenceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["correction", "tool-result", "test-result"]),
  sessionID: z.string().max(128),
  turnID: z.string().max(128),
  createdAt: z.string().datetime(),
  revision: z.string(),
  outcome: z.enum(["observed", "passed", "failed"]),
  text: z.string().nullable(),
}).strict()
export type EvolutionEvidence = z.infer<typeof EvidenceSchema>
export type EvidenceInput = Pick<EvolutionEvidence, "source" | "sessionID" | "turnID" | "outcome"> & { text?: string }

// Conservative rejection, not a promise that arbitrary secrets can be recognized.
export function assertEvolutionTextSafe(text: string) {
  if (/-----BEGIN .*PRIVATE KEY-----|\b(?:sk|ghp|gho|xoxb|xoxp)[-_][a-z0-9_-]{12,}|\b(?:authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credential)\b|\bBearer\s+\S+/i.test(text)) {
    throw new Error("Potential sensitive content; evidence blocked")
  }
}

export async function listEvolutionEvidence(root: string, dataDir?: string) {
  const file = path.join(evolutionPaths(root, dataDir).projectDir, "evidence.json")
  const stored = await readEvolutionJSON(file)
  const entries = stored === undefined ? [] : z.array(EvidenceSchema).max(500).parse(stored)
  return entries.filter((item) => Date.parse(item.createdAt) > Date.now() - 30 * 86_400_000)
}

/** Only host completion metadata is retained, never stdout or model-authored summaries. */
export async function recordEvolutionToolEvidence(root: string, input: {
  sessionID: string; turnID: string; tool: string; command?: unknown; exitCode?: unknown; failed?: boolean
}, dataDir?: string) {
  if (!/^[\w.:-]{1,64}$/.test(input.tool)) return { recorded: false as const, reason: "Unsupported tool name" }
  const command = typeof input.command === "string" ? input.command.trim() : ""
  const test = input.tool === "bash" && command.length <= 256 && /^(?:bun test|pnpm test|pytest|cargo test|go test)(?:\s+[\w./:@=-]+)*$/.test(command)
  const exitCode = typeof input.exitCode === "number" && Number.isSafeInteger(input.exitCode) ? input.exitCode : undefined
  const outcome = input.failed || (exitCode !== undefined && exitCode !== 0) ? "failed" : exitCode === 0 ? "passed" : "observed"
  return recordEvolutionEvidence(root, {
    source: test ? "test-result" : "tool-result", sessionID: input.sessionID, turnID: input.turnID, outcome,
    text: test ? `Test command ${command}: ${outcome}. This records process status, not a semantic audit.` : `Tool ${input.tool}: ${outcome}. No command, output or arguments retained.`,
  }, dataDir)
}

/** Host callers supply origin. Never accept an assistant/model claim of user provenance. */
export async function recordEvolutionEvidence(root: string, input: EvidenceInput, dataDir?: string) {
  const initial = authorizeEvolutionAction(await readEvolutionPolicy(root, dataDir), "capture")
  if (!initial.allowed) return { recorded: false as const, reason: initial.reason }
  const paths = evolutionPaths(root, dataDir)
  return Flock.withLock(`evolution-evidence:${paths.projectDir}`, async () => {
    const policy = await readEvolutionPolicy(root, dataDir)
    const decision = authorizeEvolutionAction(policy, "capture")
    if (!decision.allowed) return { recorded: false as const, reason: decision.reason }
    const enabled = input.source === "correction" ? policy.config.sources.corrections
      : input.source === "tool-result" ? policy.config.sources.toolResults : policy.config.sources.testResults
    if (!enabled) return { recorded: false as const, reason: "Evidence source disabled" }
    const text = policy.config.mode === "observe" ? null : input.text?.trim() || null
    if (text) assertEvolutionTextSafe(text)
    const identity = JSON.stringify([input.source, input.sessionID, input.turnID, input.outcome, text])
    const entry = EvidenceSchema.parse({
      id: createHash("sha256").update(identity).digest("hex"),
      source: input.source, sessionID: input.sessionID, turnID: input.turnID,
      outcome: input.outcome, text, createdAt: new Date().toISOString(), revision: policy.revision,
    })
    if (Buffer.byteLength(JSON.stringify(entry)) > 4096) throw new Error("Evidence exceeds 4 KiB")
    const entries = await listEvolutionEvidence(root, dataDir)
    const previous = entries.find((item) => item.id === entry.id)
    if (previous) return { recorded: true as const, entry: previous }
    if (entries.length >= 500) throw new Error("Evolution evidence capacity reached")
    const beforeWrite = authorizeEvolutionAction(await readEvolutionPolicy(root, dataDir), "capture", policy.revision)
    if (!beforeWrite.allowed) return { recorded: false as const, reason: beforeWrite.reason }
    await writeEvolutionJSON(path.join(paths.projectDir, "evidence.json"), [...entries, entry])
    return { recorded: true as const, entry }
  }, { dir: path.join(paths.projectDir, ".locks"), timeoutMs: 5_000 })
}
