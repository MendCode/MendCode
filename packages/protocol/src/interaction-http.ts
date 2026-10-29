import { z } from "zod"
import { ItemId, RequestId, SessionId } from "./ids"
import { QuestionBatch } from "./questions"
import { MemoryAssistantAction } from "./memory-model"
import { lazySchema } from "./lazy"

export const InteractionKind = z.enum(["permission", "question", "plan-review"])
export type InteractionKind = z.infer<typeof InteractionKind>

export const PermissionContext = lazySchema(() => z.strictObject({
  name: z.string().min(1).max(200),
  patterns: z.array(z.string().max(8000)).max(100),
  always: z.array(z.string().max(8000)).max(100),
}))
export type PermissionContext = z.infer<typeof PermissionContext>

const tool = lazySchema(() => z.strictObject({ messageID: ItemId, callID: z.string().min(1).max(200) }))
const request = { id: RequestId, sessionID: SessionId, tool: tool.optional() }
export const RestPermissionRequest = lazySchema(() => z.strictObject({
  ...request,
  permission: z.string().min(1).max(200),
  patterns: PermissionContext.shape.patterns,
  always: PermissionContext.shape.always,
  metadata: z.strictObject({ title: z.string().max(500), detail: z.string().max(210_000) }),
}))
export const RestQuestionRequest = lazySchema(() => z.strictObject({ ...request, questions: QuestionBatch }))
export const RestPlanReviewRequest = lazySchema(() => z.strictObject({ ...request, title: z.string().max(200).optional(), markdown: z.string().min(1).max(30_000) }))
export const InteractionReport = lazySchema(() => z.strictObject({
  requests: z.array(z.union([RestPermissionRequest, RestQuestionRequest, RestPlanReviewRequest])).max(1000),
}))
export type InteractionReport = z.infer<typeof InteractionReport>
export const RestPermissionReply = lazySchema(() => z.strictObject({ reply: z.enum(["once", "always", "reject"]), message: z.string().max(2000).optional() }))
export type RestPermissionReply = z.infer<typeof RestPermissionReply>
export const RestQuestionReply = lazySchema(() => z.strictObject({ answers: z.array(z.array(z.string().min(1).max(4000)).max(10)).min(1).max(32) }))
export const RestPlanReviewReply = lazySchema(() => z.strictObject({
  action: z.enum(["apply", "edit", "reject", "close"]),
  markdown: z.string().min(1).max(30_000).optional(),
  reason: z.string().max(2000).optional(),
  comments: z.string().max(4000).optional(),
}))

export const MemorySideChatPayload = lazySchema(() => z.strictObject({
  root: z.string().min(1).max(4096).optional(),
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.strictObject({ id: z.string().min(1).max(200), role: z.enum(["user", "assistant"]), text: z.string().max(24_000), createdAt: z.string().max(100) })).max(24).optional(),
  context: z.strictObject({
    selectedWorkspaceID: z.string().max(4096).nullable().optional(),
    selectedGroupID: z.string().max(4096).nullable().optional(),
    selectedCategoryID: z.string().max(64).nullable().optional(),
    pageContext: z.string().max(16_000).nullable().optional(),
  }).optional(),
}))
export type MemorySideChatPayload = z.infer<typeof MemorySideChatPayload>
export const MemorySideChatResponse = lazySchema(() => z.strictObject({ text: z.string().max(24_000), actions: z.array(MemoryAssistantAction).max(20) }))
export type MemorySideChatResponse = z.infer<typeof MemorySideChatResponse>
