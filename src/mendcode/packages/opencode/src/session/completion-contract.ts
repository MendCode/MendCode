import { Schema, Types } from "effect"

import { NonNegativeInt } from "@/util/schema"

export const CompletionConfirmation = Schema.Literals(["same-run", "next-run"])
export type CompletionConfirmation = Schema.Schema.Type<typeof CompletionConfirmation>

export const CompletionProgressStatus = Schema.Literals([
  "candidate",
  "auditing",
  "passed",
  "rejected",
  "blocked",
])
export type CompletionProgressStatus = Schema.Schema.Type<typeof CompletionProgressStatus>

export const CompletionEvidenceRef = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["command-output", "artifact", "state", "observation", "human-approval"]),
  summary: Schema.String,
  source: Schema.optional(Schema.String),
})
export type CompletionEvidenceRef = Types.DeepMutable<Schema.Schema.Type<typeof CompletionEvidenceRef>>

export const CompletionCriterionResult = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pass", "fail", "uncertain", "blocked", "needs_human"]),
  summary: Schema.String,
  evidence: Schema.Array(CompletionEvidenceRef),
})
export type CompletionCriterionResult = Types.DeepMutable<Schema.Schema.Type<typeof CompletionCriterionResult>>

export const CompletionAuditReceipt = Schema.Struct({
  generation: NonNegativeInt,
  status: Schema.Literals(["pass", "fail", "uncertain", "blocked", "needs_human"]),
  summary: Schema.String,
  criteria: Schema.Array(CompletionCriterionResult),
  fingerprintBefore: Schema.optional(Schema.String),
  fingerprintAfter: Schema.optional(Schema.String),
  recommendedNextAction: Schema.optional(Schema.String),
  createdAt: NonNegativeInt,
})
export type CompletionAuditReceipt = Types.DeepMutable<Schema.Schema.Type<typeof CompletionAuditReceipt>>

export const CompletionProgress = Schema.Struct({
  status: CompletionProgressStatus,
  generation: NonNegativeInt,
  sourceID: Schema.String,
  auditAttempts: NonNegativeInt,
  candidateFingerprint: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  failedCriteria: Schema.optional(Schema.Array(Schema.String)),
  receipt: Schema.optional(CompletionAuditReceipt),
  auditLease: Schema.optional(Schema.Struct({
    holder: Schema.String,
    expiresAt: NonNegativeInt,
  })),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
})
export type CompletionProgress = Types.DeepMutable<Schema.Schema.Type<typeof CompletionProgress>>

export type CompletionGate = {
  readonly id: string
  readonly status: "pass" | "fail" | "skip" | "blocked" | "awaiting_approval" | "waived"
  readonly summary?: string
}

export type CompletionAuditDecision =
  | { readonly outcome: "complete"; readonly summary: string }
  | { readonly outcome: "retry-work"; readonly summary: string; readonly failedCriteria: readonly string[] }
  | { readonly outcome: "retry-audit"; readonly summary: string }
  | { readonly outcome: "needs-input"; readonly summary: string }
  | { readonly outcome: "blocked"; readonly summary: string }

export const compileCompletionCriteria = (criteria: readonly string[]) =>
  criteria
    .map((description, index) => ({ id: `criterion-${index + 1}`, description: description.trim() }))
    .filter((criterion) => criterion.description.length > 0)

export const nextCompletionProgress = (input: {
  readonly confirmation: CompletionConfirmation
  readonly workSatisfied: boolean
  readonly current?: CompletionProgress
  readonly sourceID: string
  readonly now: number
}): { readonly terminal: boolean; readonly progress?: CompletionProgress } => {
  if (!input.workSatisfied) return { terminal: false }
  if (input.confirmation === "same-run") return { terminal: true }
  if (input.current?.status === "passed") return { terminal: true, progress: input.current }
  if (input.current?.status === "candidate" || input.current?.status === "auditing") {
    return { terminal: false, progress: input.current }
  }
  return {
    terminal: false,
    progress: {
      status: "candidate",
      generation: (input.current?.generation ?? 0) + 1,
      sourceID: input.sourceID,
      auditAttempts: 0,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
}

const blockingGate = (gate: CompletionGate) =>
  gate.status === "fail" || gate.status === "blocked" || gate.status === "awaiting_approval"

export const decideCompletionAudit = (input: {
  readonly progress: CompletionProgress
  readonly receipt: CompletionAuditReceipt
  readonly criteria: readonly { readonly id: string; readonly description: string }[]
  readonly gates?: readonly CompletionGate[]
  readonly maxAuditAttempts: number
}): CompletionAuditDecision => {
  if (input.receipt.generation !== input.progress.generation) {
    return { outcome: "blocked", summary: "Completion audit is stale because its generation no longer matches the active candidate." }
  }
  if (
    input.progress.candidateFingerprint &&
    (input.receipt.fingerprintBefore !== input.progress.candidateFingerprint ||
      input.receipt.fingerprintAfter !== input.progress.candidateFingerprint)
  ) {
    return { outcome: "retry-work", summary: "Workspace changed after completion was proposed; the candidate must be rebuilt and audited again.", failedCriteria: [] }
  }
  const gate = input.gates?.find(blockingGate)
  if (gate) {
    const summary = gate.summary ?? `Completion gate ${gate.id} did not pass.`
    if (gate.status === "awaiting_approval") return { outcome: "needs-input", summary }
    if (gate.status === "blocked") return { outcome: "blocked", summary }
    return { outcome: "retry-work", summary, failedCriteria: [] }
  }
  if (input.receipt.status === "needs_human") {
    return { outcome: "needs-input", summary: input.receipt.summary }
  }
  if (input.receipt.status === "blocked") {
    return { outcome: "blocked", summary: input.receipt.summary }
  }
  if (input.receipt.status === "uncertain") {
    return input.progress.auditAttempts < input.maxAuditAttempts
      ? { outcome: "retry-audit", summary: input.receipt.summary }
      : { outcome: "blocked", summary: `Completion audit remained uncertain after ${input.progress.auditAttempts} attempt(s): ${input.receipt.summary}` }
  }

  const byID = new Map(input.receipt.criteria.map((criterion) => [criterion.id, criterion]))
  const failedCriteria = input.criteria.flatMap((criterion) => {
    const result = byID.get(criterion.id)
    return result?.status === "pass" && result.evidence.length > 0 ? [] : [criterion.id]
  })
  if (input.receipt.status !== "pass" || failedCriteria.length > 0) {
    return {
      outcome: "retry-work",
      summary: input.receipt.summary,
      failedCriteria,
    }
  }
  return { outcome: "complete", summary: input.receipt.summary }
}

export const completionAuditJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "criteria", "recommendedNextAction"],
  properties: {
    status: { type: "string", enum: ["pass", "fail", "uncertain", "blocked", "needs_human"] },
    summary: { type: "string", minLength: 1 },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "summary", "evidence"],
        properties: {
          id: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["pass", "fail", "uncertain", "blocked", "needs_human"] },
          summary: { type: "string", minLength: 1 },
          evidence: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
    recommendedNextAction: { type: "string", minLength: 1 },
  },
} as const
