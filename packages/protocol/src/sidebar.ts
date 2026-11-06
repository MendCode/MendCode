import { z } from "zod"
import { lazySchema } from "./lazy"

export const SidebarWidget = lazySchema(() => z.strictObject({
  type: z.union([z.enum(["context", "usage", "todos", "changes", "jobs", "loops", "workflows", "agents", "mcp", "git", "session", "clock", "text", "sidechat", "agent", "activity", "workspace", "tokens", "tools", "alerts", "pace", "savings", "queue", "lineage", "files", "limits", "rent", "orbit", "models", "stats", "atom", "backlog"]), z.string().regex(/^extension:[a-zA-Z0-9_-]+$/)]),
  title: z.string().max(100).optional(),
  options: z.strictObject({ maxRows: z.number().int().min(1).max(100).optional(), text: z.string().max(8_000).optional(), priority: z.enum(["high", "normal", "low"]).optional() }).default({}),
}).superRefine((widget, ctx) => {
  if (widget.type !== "text" && widget.type !== "stats" && widget.options.text !== undefined) ctx.addIssue({ code: "custom", message: "text is only valid for a text widget (a stats widget's text is its comma list of parts)" })
}))
export type SidebarWidget = z.infer<typeof SidebarWidget>
export const SidebarSpec = lazySchema(() => z.array(SidebarWidget).max(32))
export type SidebarSpec = z.infer<typeof SidebarSpec>
const scope = { scope: z.enum(["user", "project"]).default("user") }
const index = z.number().int().min(0).max(31)
export const SidebarAction = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("get"), ...scope }),
  z.strictObject({ action: z.literal("set"), widgets: SidebarSpec, ...scope }),
  z.strictObject({ action: z.literal("add"), widget: SidebarWidget, index: index.optional(), ...scope }),
  z.strictObject({ action: z.literal("remove"), index, ...scope }),
  z.strictObject({ action: z.literal("move"), index, to: index, ...scope }),
  z.strictObject({ action: z.literal("clear"), ...scope }),
]))
export type SidebarAction = z.infer<typeof SidebarAction>

/** One entry of a side chat: a question, an answer, or a tool the answer ran (`status`: running, then ok or error; `ms` once it ended). */
const AsideMessage = z.strictObject({
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string().max(24_000),
  status: z.enum(["running", "ok", "error"]).optional(),
  ms: z.number().int().nonnegative().optional(),
})

/**
 * What a side chat has to go on: `seen` characters of the main session (`cut`: the start of it is missing), and the side
 * model's last prompt in tokens with the share that came from the provider's cache.
 */
const AsideContext = z.strictObject({
  seen: z.number().int().nonnegative(),
  cut: z.boolean(),
  tokens: z.number().int().nonnegative().optional(),
  cached: z.number().int().nonnegative().optional(),
})

/** The `/btw` side chat: questions, answers and the tools the answers used (`tool` lines), the model answering, what it sees, and what it is doing now. */
export const AsideThread = lazySchema(() => z.strictObject({
  messages: z.array(AsideMessage).max(64),
  busy: z.boolean(),
  error: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  status: z.string().max(300).optional(),
  context: AsideContext.optional(),
}))
export type AsideThread = z.infer<typeof AsideThread>

/** A side chat that was cleared, kept for `/btw history`: when, which model, and its entries. */
export const AsideArchive = lazySchema(() => z.strictObject({
  at: z.number().int().nonnegative(),
  model: z.string().max(200).optional(),
  messages: z.array(AsideMessage).max(64),
}))
export type AsideArchive = z.infer<typeof AsideArchive>
