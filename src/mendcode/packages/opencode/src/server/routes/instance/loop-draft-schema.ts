import { WorkspaceID } from "@/control-plane/schema"
import { SessionID } from "@/session/schema"
import z from "zod"

const nonNegativeInteger = z.number().int().nonnegative()

export const LoopDraftBody = z.object({
  name: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  source: z.enum(["converted-session", "objective", "template", "manual"]).optional(),
  workspaceID: WorkspaceID.zod.optional(),
  ownerSessionID: SessionID.zod.optional(),
  templateID: z.string().optional(),
  trigger: z
    .object({
      mode: z.enum(["manual", "interval", "daily", "adaptive", "external-signal", "self-paced"]).optional(),
      intervalMs: nonNegativeInteger.optional(),
      dailyAt: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  workflow: z
    .object({
      revisionID: z.string().trim().min(1).optional(),
      definitionID: z.string().trim().min(1).optional(),
      overlapKey: z.string().trim().min(1).optional(),
    })
    .optional(),
  budgetMode: z.enum(["fixed", "max-goal", "unbounded-monitor"]).optional(),
  completionCriteria: z.array(z.string()).optional(),
  successChecks: z.array(z.string()).optional(),
  validationChecks: z
    .array(z.object({ id: z.string(), command: z.string(), timeoutMs: nonNegativeInteger.optional() }))
    .optional(),
  strategy: z
    .object({
      targetTurns: nonNegativeInteger.optional(),
      reserveTurns: nonNegativeInteger.optional(),
      notifyOwnerOnComplete: z.boolean().optional(),
    })
    .optional(),
  stopWhen: z.array(z.string()).optional(),
  gates: z.array(z.string()).optional(),
  model: z
    .object({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().optional() })
    .optional(),
  agent: z.string().optional(),
  evaluation: z
    .object({
      mode: z.enum(["legacy", "deterministic", "independent"]).optional(),
      confirmation: z.enum(["same-run", "next-run"]).optional(),
      evaluatorAgent: z.string().optional(),
      requireIndependentForCompletion: z.boolean().optional(),
      allowWorkerSelfComplete: z.boolean().optional(),
      maxEvaluatorRetries: nonNegativeInteger.optional(),
    })
    .optional(),
  rubric: z
    .object({
      name: z.string().optional(),
      passThreshold: z.number().optional(),
      criteria: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            weight: z.number().optional(),
            minScore: z.number().optional(),
            evidenceRequired: z.array(z.string()).optional(),
          }),
        )
        .optional(),
      mandatoryBlockers: z.array(z.string()).optional(),
    })
    .optional(),
  workspace: z
    .object({ mode: z.enum(["read-only", "in-place", "per-loop-worktree", "per-run-worktree"]).optional() })
    .optional(),
  costBudget: z
    .object({ maxCost: z.number().nonnegative().optional(), maxTokens: nonNegativeInteger.optional() })
    .optional(),
  approvalPolicy: z
    .object({ requireApprovalFor: z.array(z.string()).optional(), approvedActions: z.array(z.string()).optional() })
    .optional(),
  memory: z
    .object({
      enabled: z.boolean().optional(),
      sections: z.array(z.enum(["tried", "verified", "open", "decisions", "rejected"])).optional(),
    })
    .optional(),
  retention: z
    .object({
      maxArtifacts: nonNegativeInteger.optional(),
      maxAgeMs: nonNegativeInteger.optional(),
      maxBytes: nonNegativeInteger.optional(),
    })
    .optional(),
  policy: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxRuntimeMs: nonNegativeInteger.optional(),
      maxChildren: nonNegativeInteger.optional(),
      maxDepth: nonNegativeInteger.optional(),
      requireApprovalFor: z.array(z.string()).optional(),
      approvedActions: z.array(z.string()).optional(),
    })
    .optional(),
})
