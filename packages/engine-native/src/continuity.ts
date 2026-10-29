import { z } from "zod"
import { defineTool, type ToolResult } from "@mendcode/tools"
import { QuestionBatch } from "@mendcode/protocol"

const jobId = z.string().min(1).max(200)
const lookup = z.object({ job_id: jobId, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16000).optional() })
const spec = <T extends z.ZodType>(name: string, description: string, args: T) => defineTool({ name, description, args, permission: "read", async execute(): Promise<ToolResult> { throw new Error("Continuity requires the native engine") } })

export const CONTINUITY_TOOLS = [
  spec("tool_start", "Start a read, grep, glob or webfetch job and continue independent work. Original permissions apply. Shell, mutations, overrides and arbitrary MCP tools cannot run asynchronously. Results arrive at safe checkpoints.", z.object({ tool: z.enum(["read", "grep", "glob", "webfetch"]), arguments: z.record(z.string(), z.unknown()) })),
  spec("tool_status", "Read the current session's job and a bounded page of its stored result.", lookup),
  spec("tool_cancel", "Cancel a job in this session. Keep history and late results without resuming cancelled work.", lookup),
  spec("tool_wait", "Wait once, up to 60 seconds, for 1 to 12 jobs in this session. Returns immediately when all are terminal.", z.object({ job_ids: z.array(jobId).min(1).max(12), timeout_ms: z.number().int().min(0).max(60000).optional() })),
  spec("question_start", "Post questions and continue independent work. Replies arrive later. Silence never grants approval; tool authorization uses permissions.", z.object({ questions: QuestionBatch })),
  spec("question_status", "Read this session's posted question, actual reply or dismissal.", z.object({ question_id: jobId })),
]

export const continuityResult = (value: unknown): ToolResult => {
  const text = JSON.stringify(value)
  return { title: "Continuity", output: text.slice(0, 50_000), truncated: text.length > 50_000, isError: false }
}
