import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { QuestionBatch, todoListCard, todoListStatus, type TodoListItem } from "@mendcode/protocol"

/** `question`: ask the user when a decision is genuinely theirs; the turn waits for the answer. */
export const questionTool = defineTool({
  name: "question",
  description:
    "Ask the user questions and wait for the answers. Use questions[] for a batch with short headers, options, optional multiple selection and custom answers. Use only for decisions that are genuinely the user's; do not ask for things you can find out yourself.",
  permission: "read",
  args: z.object({
    question: z.string().min(1).max(500).optional().describe("A single question, one sentence; use this or questions[]"),
    context: z.string().max(4_000).optional().describe("Short background the user needs to answer"),
    options: z
      .array(z.object({ label: z.string().min(1).max(120).describe("The choice, a few words"), description: z.string().max(300).optional().describe("What choosing it means") }))
      .max(9)
      .optional()
      .describe("The choices when there is a known set (best first); the user can still type their own answer"),
    multiple: z.boolean().optional().describe("Whether the user may pick more than one option"),
    questions: QuestionBatch.optional().describe("Questions in order, with a short header for each tab"),
  }).refine((args) => Boolean(args.question) !== Boolean(args.questions), "provide question or questions, not both"),
  async execute({ question, context: detail, options, multiple, questions }, context) {
    if (questions) {
      const title = `Asked ${questions.length} question${questions.length === 1 ? "" : "s"}`
      if (!context.ask) return { output: "no user is available to answer; decide and state your assumption", truncated: false, title, isError: true }
      const reply = await context.ask({ title, detail: detail ?? "", questions })
      if (!reply.answered) return { output: `not answered: ${reply.reason}`, truncated: false, title, isError: true }
      if (!reply.answers || reply.answers.length !== questions.length) return { output: "not answered: the client did not return an ordered answer batch", truncated: false, title, isError: true }
      const formatted = questions.map((q, i) => `${JSON.stringify(q.question)}=${JSON.stringify(reply.answers![i]!.length ? reply.answers![i]!.join(", ") : "Unanswered")}`).join(", ")
      return { output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`, truncated: false, title, isError: false }
    }
    question = question!
    if (!context.ask) return { output: "no user is available to answer; decide and state your assumption", truncated: false, title: `question: ${question.slice(0, 60)}`, isError: true }
    const choices = options?.map((option) => (option.description ? { label: option.label, description: option.description } : { label: option.label }))
    const reply = await context.ask({ title: question, detail: detail ?? "", ...(choices?.length ? { options: choices } : {}), ...(multiple && choices?.length ? { multiple: true } : {}) })
    if (!reply.answered) return { output: `not answered: ${reply.reason}`, truncated: false, title: `question: ${question.slice(0, 60)}`, isError: true }
    return { output: reply.text, truncated: false, title: `question: ${question.slice(0, 60)}`, isError: false }
  },
})

/**
 * `todo`: the agent's visible plan for multi-step work. Each call replaces the whole list; the terminal pins its progress above the
 * prompt (feature `visible_plan`) and the dock and the card show the whole list. Balanced and up: minimalist has no such tool at all.
 */
export const todoTool = defineTool({
  name: "todo",
  tier: "balanced",
  description: "Your visible plan: the user sees it pinned above the prompt as live progress. Call it at the start of any task with 3+ steps or several requests, before the first edit or command. Send the whole list each time (it replaces the previous; [] clears). Keep exactly one item in_progress; mark an item done as soon as it is finished, cancelled if dropped. Skip it for one-step or conversational requests. Do not repeat the list in your reply.",
  permission: "read",
  args: z.object({
    items: z
      .array(z.object({ text: z.string().min(1).max(300), status: z.enum(["pending", "in_progress", "done", "completed", "cancelled"]), priority: z.enum(["high", "medium", "low"]).optional() }))
      .max(50),
  }),
  async execute({ items }) {
    const list = items.map((item): TodoListItem => ({ text: item.text, status: todoListStatus(item.status), ...(item.priority ? { priority: item.priority } : {}) }))
    const card = todoListCard(list)
    return { output: card.text, truncated: false, title: card.title, isError: false, meta: { done: list.filter((item) => item.status === "done").length, total: items.length } }
  },
})
