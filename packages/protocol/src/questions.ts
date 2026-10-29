import { z } from "zod"
import { lazySchema } from "./lazy"

export const QuestionInfo = lazySchema(() => z.strictObject({
  question: z.string().min(1).max(500),
  header: z.string().min(1).max(30),
  options: z.array(z.strictObject({ label: z.string().min(1).max(120), description: z.string().max(300).optional() })).max(9),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
  context: z.string().max(4000).optional(),
}))
export type QuestionInfo = z.infer<typeof QuestionInfo>

export const QuestionBatch = lazySchema(() => z.array(QuestionInfo).min(1).max(32))
export const QuestionAnswers = lazySchema(() => z.array(z.array(z.string().min(1).max(4000)).max(10)).min(1).max(32))
