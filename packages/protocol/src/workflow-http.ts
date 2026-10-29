import { z } from "zod"
import { SessionId } from "./ids"
import { WorkflowBarrier, WorkflowDefinitionId, WorkflowFailureClass, WorkflowOutputContract, WorkflowPermissionPolicy, WorkflowPlan, WorkflowRevisionId, WorkflowTaskBudget, WorkflowWorkspacePolicy } from "./workflows"
import { lazySchema, lazyValue } from "./lazy"

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)
const text = z.string().min(1).max(8_000)
const model = lazySchema(() => z.strictObject({ providerID: z.string().min(1).max(100), modelID: z.string().min(1).max(200), variant: z.string().max(100).optional(), reasoning: z.string().max(100).optional() }))
const selector = lazySchema(() => z.strictObject({ taskID: identifier, path: z.string().max(200).optional(), projection: z.string().max(200).optional(), required: z.boolean().optional() }))
const routing = lazyValue(() => ({ model: model.optional(), agentProfile: z.string().max(64).optional(), allowedTools: WorkflowPermissionPolicy.shape.allowedTools, workspace: WorkflowWorkspacePolicy.optional(), permissions: WorkflowPermissionPolicy.optional(), budget: WorkflowTaskBudget.optional() }))
const retry = lazySchema(() => z.strictObject({ maxAttempts: z.number().int().positive().optional(), backoffMs: z.number().int().nonnegative().optional(), retryOn: z.array(WorkflowFailureClass).max(10).optional() }))
const template = lazySchema(() => z.strictObject({ kind: z.enum(["agent", "synthesize", "verify", "validate"]), prompt: text, output: WorkflowOutputContract, ...routing(), retry: retry.optional() }))

/** Donor JSON at the HTTP boundary only; execution always uses a validated native plan. */
export const RestWorkflowPlan = lazySchema(() => z.strictObject({
  formatVersion: z.literal(1), name: z.string().min(1).max(120), description: z.string().max(2_000), objective: text,
  phases: z.array(z.strictObject({ id: identifier, ordinal: z.number().int().positive(), name: z.string().min(1).max(80), description: z.string().max(2_000).optional(), barrier: WorkflowBarrier, taskIDs: z.array(identifier).min(1).max(32) })).min(1).max(16),
  tasks: z.array(z.strictObject({ id: identifier, phaseID: identifier, name: z.string().min(1).max(80), kind: z.enum(["agent", "synthesize", "verify", "validate", "human", "map"]), prompt: text, dependsOn: z.array(identifier).max(8), inputs: z.array(selector).max(8).optional(), output: WorkflowOutputContract, ...routing(), retry: retry.optional(), map: z.strictObject({ source: selector, maxItems: z.number().int().min(1).max(16), taskTemplate: template }).optional() })).min(1).max(32),
  finalTaskID: identifier, completionCriteria: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  completion: z.strictObject({ confirmation: z.enum(["same-run", "next-run"]).optional(), maxAuditAttempts: z.number().int().min(1).max(3).optional(), validationChecks: z.array(z.strictObject({ id: identifier, command: z.string().min(1).max(300), timeoutMs: z.number().int().positive().max(600_000).optional() })).max(5).optional(), criteria: z.array(z.strictObject({ id: identifier, description: z.string().trim().min(1).max(300), ownerTaskIDs: z.array(identifier).max(8).optional() })).min(1).max(12).optional() }).optional(),
  requiredGates: z.array(identifier).max(12), model: model.optional(), workspace: WorkflowWorkspacePolicy.optional(), permissions: WorkflowPermissionPolicy.optional(),
  budget: WorkflowTaskBudget.extend({ maxConcurrency: z.number().int().min(1).max(4).optional(), maxFanOut: z.number().int().positive().max(32).optional(), retention: z.strictObject({ maxArtifacts: z.number().int().nonnegative().optional(), maxAgeMs: z.number().int().nonnegative().optional(), maxBytes: z.number().int().nonnegative().optional() }).optional() }).optional(),
  overlapPolicy: z.enum(["skip", "queue", "replace"]).optional(),
}))
export type RestWorkflowPlan = z.infer<typeof RestWorkflowPlan>
export const RestWorkflowPlanInput = lazySchema(() => z.union([RestWorkflowPlan, WorkflowPlan]))
export const RestWorkflowPreview = lazySchema(() => z.strictObject({ plan: RestWorkflowPlanInput }))
const metadata = { name: z.string().min(1).max(120).optional(), description: z.string().max(2_000).optional(), source: z.enum(["session-generated", "saved", "template", "package", "manual"]).optional() }
export const RestWorkflowSave = lazySchema(() => RestWorkflowPreview.extend({ definitionID: WorkflowDefinitionId.optional(), ...metadata, ownerSessionID: SessionId.optional(), saved: z.boolean().optional() }))
export const RestWorkflowStart = lazySchema(() => z.strictObject({ plan: RestWorkflowPlanInput.optional(), revisionID: WorkflowRevisionId.optional(), definitionID: WorkflowDefinitionId.optional(), ...metadata, originSessionID: SessionId.optional(), loopID: z.string().min(1).max(200).optional(), loopRunID: z.string().min(1).max(200).optional(), overlapKey: z.string().trim().min(1).max(200).optional() }).refine((value) => [value.plan, value.revisionID, value.definitionID].filter((entry) => entry !== undefined).length === 1, { message: "Select exactly one plan, revisionID or definitionID" }))
export const RestWorkflowControl = lazySchema(() => z.strictObject({ reason: z.string().max(500).optional() }))
export const RestWorkflowPermission = lazySchema(() => RestWorkflowControl.extend({ mode: WorkflowPermissionPolicy.shape.mode.optional(), sessionMode: z.enum(["approval", "smart", "full_access", "global_default"]).nullable().optional() }))
export const RestWorkflowRetryTask = lazySchema(() => RestWorkflowControl.extend({ taskID: z.string().min(1).max(128) }))
export const RestWorkflowRetryPhase = lazySchema(() => RestWorkflowControl.extend({ phaseID: z.string().min(1).max(128) }))
/** Native extension (the donor has no route for a human task's answer): approve or reject a waiting human task or gate. */
export const RestWorkflowAnswerTask = lazySchema(() => RestWorkflowControl.extend({ taskID: z.string().min(1).max(128) }))
