import { defineTool, fail, type BotResult, type ToolResult } from "@mendcode/tools"
import { z } from "zod"

/**
 * The tools a bot learns with (experimental bots, docs/agents.md): `bot_note` keeps a note, `bot_skill` saves a procedure of its own,
 * `bot_schedule` sets up its own recurring work. Plain data and schemas only: the work happens in the session's `BotPort`, which the
 * daemon builds (bot-learn.ts, loaded by the first bot turn) and only for a bot's turn with the flag on; the engine offers these tools nowhere else.
 */
const finish = (title: string, result: BotResult | undefined): ToolResult => {
  if (!result) return fail({ title, message: "this is not a bot's session" })
  if (!result.ok) return fail({ title, message: result.message })
  return { output: result.text, truncated: false, title, isError: false, ...(result.meta ? { meta: result.meta } : {}) }
}

export const botNoteTool = defineTool({
  name: "bot_note",
  description: "Keep a short note in your own memory (one fact, preference or lesson worth knowing next time: what the user likes, how this project works, what failed). scope=project (default) is for this folder, everywhere for all your chats. One line, no secrets. The note shows as 'learned' in the chat.",
  permission: "read",
  args: z.object({
    text: z.string().min(6).max(400).describe("The note, one line"),
    scope: z.enum(["project", "everywhere"]).optional().describe("project (default): this folder; everywhere: every chat"),
  }),
  async execute(args, context) {
    return finish("bot_note", context.bot?.note({ text: args.text, scope: args.scope ?? "project" }))
  },
})

export const botSkillTool = defineTool({
  name: "bot_skill",
  description: "Save what worked as a skill you can reuse: a short reusable procedure (when to use it, the steps, the traps) kept in your own skills folder and offered only to you. action=create or update (name, description of one line, body in Markdown), list, read (name). Save one only after a task that worked and is likely to repeat; keep it short and specific. The user is asked the first time per skill.",
  // Reads like a note: it writes only into the bot's own skills folder; the user's say is `approvalFor` (the first save of each skill).
  permission: "read",
  args: z.object({
    action: z.enum(["create", "update", "list", "read"]),
    name: z.string().min(1).max(60).optional().describe("Skill name: lowercase letters, digits, - and _ (create, update, read)"),
    description: z.string().min(1).max(200).optional().describe("create, update: one line saying when to use it"),
    body: z.string().min(1).max(12_000).optional().describe("create, update: the procedure in Markdown"),
  }),
  approvalFor: (args, context) => (args.action === "create" || args.action === "update") && args.name !== undefined && context?.bot?.skillNeedsApproval(args.name) === true,
  async preview(args, context) {
    if (args.action !== "create" && args.action !== "update") return undefined
    return context.bot?.skillPreview({ name: args.name ?? "", description: args.description, body: args.body })
  },
  async execute(args, context) {
    const bot = context.bot
    const title = `bot_skill: ${args.name ?? args.action}`
    if (!bot) return finish(title, undefined)
    if (args.action === "list") return finish("bot_skill: skills", bot.skillList())
    if (!args.name) return fail({ title, message: `${args.action} needs a name` })
    if (args.action === "read") return finish(title, bot.skillRead(args.name))
    return finish(title, bot.skillSave({ mode: args.action, name: args.name, description: args.description, body: args.body }))
  },
})

export const botScheduleTool = defineTool({
  name: "bot_schedule",
  description: [
    "Schedule your own recurring work: the user tells you 'do X every day at 9' or 'every Monday' and you create it. action=create (name, objective, trigger), list (yours, every folder), cancel (loopId).",
    'trigger: "daily 09:00" (add a zone: "daily 09:00 Europe/Madrid"), "weekly mon 09:00" (weekly mon,thu 09:00), "every 30m", "adaptive 30m", or "external" (when something outside fires it: mendcode loop fire <id>). Each run is a message in a chat with you in the folder (default: this one), with your memory and digest.',
    "The objective must stand alone: the run does not see this conversation. Runs only read and report unless reportOnly=false and the user asked for edits. The user is asked before every schedule is created.",
  ].join(" "),
  // Listing and cancelling one's own schedule asks nothing; creating always asks (`approvalFor`), in every permission mode.
  permission: "read",
  args: z.object({
    action: z.enum(["create", "list", "cancel"]),
    name: z.string().min(1).max(120).optional().describe("create: a short name"),
    objective: z.string().min(1).max(8_000).optional().describe("create: what each run does, self-contained"),
    trigger: z.string().min(1).max(80).optional().describe('create: "daily 09:00", "weekly mon 09:00", "every 30m", "adaptive 30m" or "external"'),
    directory: z.string().min(1).max(1_024).optional().describe("create: the folder the runs work in (absolute; default: this session's)"),
    reportOnly: z.boolean().optional().describe("create: runs only read and report (default true)"),
    maxRuns: z.number().int().min(1).max(1_000).optional().describe("create: stop after this many runs (default: until cancelled)"),
    loopId: z.string().min(1).max(64).optional().describe("cancel: the id from list"),
  }),
  approvalFor: (args) => args.action === "create",
  async preview(args, context) {
    if (args.action === "list") return "List your schedules."
    if (args.action === "cancel") return `Cancel schedule ${args.loopId ?? "(no id)"}.`
    if (!context.bot || !args.name || !args.objective || !args.trigger) return undefined
    const checked = await context.bot.schedulePreview({ name: args.name, objective: args.objective, trigger: args.trigger, directory: args.directory, reportOnly: args.reportOnly, maxRuns: args.maxRuns }).catch(() => undefined)
    if (!checked) return undefined
    return checked.problems.length ? `Problems:\n${checked.problems.map((problem) => `- ${problem}`).join("\n")}` : checked.detail
  },
  async execute(args, context) {
    const bot = context.bot
    if (!bot) return finish("bot_schedule", undefined)
    if (args.action === "list") return finish("bot_schedule: schedules", bot.scheduleList())
    if (args.action === "cancel") return args.loopId ? finish(`bot_schedule: ${args.loopId}`, bot.scheduleCancel(args.loopId)) : fail({ title: "bot_schedule", message: "cancel needs a loopId (from action list)" })
    if (!args.name || !args.objective || !args.trigger) return fail({ title: "bot_schedule", message: "create needs a name, an objective and a trigger" })
    return finish(`bot_schedule: ${args.name}`, await bot.scheduleCreate({ name: args.name, objective: args.objective, trigger: args.trigger, directory: args.directory, reportOnly: args.reportOnly, maxRuns: args.maxRuns }))
  },
})

export const BOT_TOOLS = [botNoteTool, botSkillTool, botScheduleTool]
