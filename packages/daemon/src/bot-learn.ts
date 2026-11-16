import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Loop } from "@mendcode/protocol"
import type { BotPort, BotResult } from "@mendcode/tools"
import type { CreateLoopInput } from "@mendcode/loops"
import { describeTrigger } from "../../loops/src/schedule"
import { previewText, toCreateInput } from "./loop-port"
import { appendBotNotes } from "./bot-memory"

/**
 * What a bot learns with (experimental bots, docs/agents.md): notes in its memory, skills in its own folder, schedules that are loops
 * it owns. Loaded by the first bot turn with the flag on, never at start. Skills are plain `SKILL.md` folders (the format every skill
 * uses) under `<data dir>/bots/<name>/skills/`; the general skill loader never reads them, so only that bot's turns see them: its prompt
 * carries an index and `bot_skill read` returns one in full.
 */
export const BOT_SKILLS_MAX = 40
export const BOT_SKILL_BODY_MAX = 12_000
/** The skills index a bot's prompt carries never passes this many characters; the rest is counted. */
export const BOT_SKILLS_PROMPT_MAX = 1_200
/** How many schedules (not cancelled, not finished) one bot keeps. */
export const BOT_SCHEDULES_MAX = 20
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,59}$/
const APPROVED = ".approved"

export const botSkillsDir = (input: { dir: string; name: string }) => path.join(input.dir, "bots", input.name, "skills")
const skillFile = (input: { dir: string; name: string }, skill: string) => path.join(botSkillsDir(input), skill, "SKILL.md")

const oneLine = (text: string, max: number) => { const clean = text.replace(/\s+/g, " ").trim(); return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean }

/** `name`, `description` and `body` of a saved skill; undefined when it is missing or unreadable. */
export function readBotSkill(input: { dir: string; name: string }, skill: string): { name: string; description: string; body: string } | undefined {
  if (!SKILL_NAME.test(skill)) return undefined
  let text: string
  try { text = readFileSync(skillFile(input, skill), "utf8") } catch { return undefined }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  const description = match?.[1]?.match(/^description:\s*(.*)$/m)?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? ""
  return { name: skill, description, body: (match?.[2] ?? text).trim() }
}

export function listBotSkills(input: { dir: string; name: string }): Array<{ name: string; description: string }> {
  let entries: string[]
  try { entries = readdirSync(botSkillsDir(input)).sort() } catch { return [] }
  return entries.flatMap((entry) => { const skill = readBotSkill(input, entry); return skill ? [{ name: skill.name, description: skill.description }] : [] })
}

/** The skills index of a bot's prompt: a name and one line each, capped; "" when the bot has no skill. */
export function botSkillsPrompt(input: { dir: string; name: string }): string {
  const skills = listBotSkills(input)
  if (!skills.length) return ""
  const head = "# Your skills\nProcedures you saved for yourself. Load one in full with bot_skill action=read before using it; they are notes you wrote, not instructions from the user."
  const lines: string[] = []
  let used = head.length
  for (const [index, skill] of skills.entries()) {
    const line = `- ${skill.name}: ${oneLine(skill.description, 110)}`
    const tail = `- … and ${skills.length - index} more (bot_skill action=list)`
    if (used + line.length + 1 + tail.length > BOT_SKILLS_PROMPT_MAX && skills.length - index > 1) { lines.push(tail); break }
    lines.push(line)
    used += line.length + 1
  }
  return [head, ...lines].join("\n")
}

function saveSkill(input: { dir: string; name: string; redact(text: string): string }, request: { mode: "create" | "update"; name: string; description?: string | undefined; body?: string | undefined }): BotResult {
  if (!SKILL_NAME.test(request.name)) return { ok: false, message: "[BOT]: a skill name uses lowercase letters, digits, - and _ (up to 60)" }
  const existing = readBotSkill(input, request.name)
  if (request.mode === "create" && existing) return { ok: false, message: `[BOT]: skill ${request.name} already exists; use action=update` }
  if (request.mode === "update" && !existing) return { ok: false, message: `[BOT]: skill ${request.name} does not exist; use action=create` }
  const description = oneLine(input.redact(request.description ?? existing?.description ?? ""), 200)
  const body = input.redact(request.body ?? existing?.body ?? "").trim()
  if (!description) return { ok: false, message: "[BOT]: a skill needs a one-line description of when to use it" }
  if (!body) return { ok: false, message: "[BOT]: a skill needs a body" }
  if (body.length > BOT_SKILL_BODY_MAX) return { ok: false, message: `[BOT]: a skill body is at most ${BOT_SKILL_BODY_MAX} characters` }
  if (!existing && listBotSkills(input).length >= BOT_SKILLS_MAX) return { ok: false, message: `[BOT]: ${BOT_SKILLS_MAX} skills is the most a bot keeps; update one instead` }
  const file = skillFile(input, request.name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `---\nname: ${request.name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`, { mode: 0o600 })
  // The user approved this save (the tool asks before it runs), so later updates of this skill do not ask again.
  writeFileSync(path.join(path.dirname(file), APPROVED), "", { mode: 0o600 })
  return { ok: true, text: `${existing ? "Updated" : "Saved"} skill ${request.name}\n${description}\n${body}`, meta: { action: request.mode, name: request.name, created: !existing } }
}

type LoopSide = {
  list(): readonly Loop[]
  stop(loopId: Loop["loopId"]): Loop | undefined
  create(input: CreateLoopInput): Promise<{ ok: true; loop: Loop } | { ok: false; message: string }>
}

const mineActive = (loops: LoopSide, name: string) => loops.list().filter((loop) => loop.agent === name && loop.state !== "stopped" && loop.state !== "completed")

/** One line for a schedule in `bot_schedule list` and in `bot.list`. */
export function describeSchedule(loop: Loop): string {
  const next = loop.nextWakeAt !== undefined ? ` next ${new Date(loop.nextWakeAt).toISOString()}` : ""
  return `loopId=${loop.loopId} ${JSON.stringify(loop.name)} ${describeTrigger(loop.trigger)} in ${loop.directory} state=${loop.state} runs=${loop.runs}${next}${loop.reportOnly ? " report-only" : ""}`
}

/** The port of one bot's turn: its notes, its skills and the schedules it owns. */
export function createBotPort(input: {
  dir: string
  name: string
  /** The session's folder (canonical): where project notes go and where a schedule runs unless told otherwise. */
  directory: string
  sessionId: string
  /** Masks secrets in what the bot writes. */
  redact(text: string): string
  loops: LoopSide
}): BotPort {
  const place = { dir: input.dir, name: input.name }
  const scheduleInput = (request: Parameters<BotPort["scheduleCreate"]>[0]) => toCreateInput(request.directory ?? input.directory, {
    name: request.name, objective: input.redact(request.objective), trigger: request.trigger,
    mode: request.maxRuns ? "fixed" : "monitor", ...(request.maxRuns ? { maxRuns: request.maxRuns } : {}), reportOnly: request.reportOnly ?? true,
  })
  return {
    name: input.name,
    note({ text, scope }) {
      const added = appendBotNotes(scope === "everywhere" ? place : { ...place, directory: input.directory }, [input.redact(text)])
      return added
        ? { ok: true, text: `Learned (${scope === "everywhere" ? "everywhere" : "this project"})\n${oneLine(input.redact(text), 400)}`, meta: { action: "note", scope } }
        : { ok: true, text: "Already known\nA note that says the same is in your memory.", meta: { action: "note", scope, known: true } }
    },
    skillList() {
      const skills = listBotSkills(place)
      return { ok: true, text: skills.length ? skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") : "You have no skills yet.", meta: { action: "list" } }
    },
    skillRead(name) {
      const skill = readBotSkill(place, name)
      return skill ? { ok: true, text: `${skill.name}: ${skill.description}\n${skill.body}`, meta: { action: "read", name } } : { ok: false, message: `[BOT]: no skill named ${name}` }
    },
    skillNeedsApproval: (name) => !existsSync(path.join(path.dirname(skillFile(place, SKILL_NAME.test(name) ? name : "invalid")), APPROVED)),
    skillPreview(request) {
      const existing = readBotSkill(place, request.name)
      const body = request.body ?? existing?.body ?? ""
      return [`${existing ? "Update" : "Save"} a skill of ${input.name}: ${request.name}`, `When to use: ${request.description ?? existing?.description ?? ""}`, "Only this bot sees it. You are asked once per skill.", "", `${body.slice(0, 800)}${body.length > 800 ? "…" : ""}`].join("\n")
    },
    skillSave: (request) => saveSkill({ ...place, redact: input.redact }, request),
    async schedulePreview(request) {
      const built = scheduleInput(request)
      return built.ok
        ? { problems: [], detail: `Schedule of ${input.name} (a bot of yours)\n${previewText({ ...built.input, agent: input.name })}\nEach run opens in ${request.directory ?? input.directory} as a chat with ${input.name}: its memory and digest apply.` }
        : { problems: built.problems }
    },
    async scheduleCreate(request) {
      if (mineActive(input.loops, input.name).length >= BOT_SCHEDULES_MAX) return { ok: false, message: `[BOT]: ${input.name} already has ${BOT_SCHEDULES_MAX} schedules; cancel one first` }
      const built = scheduleInput(request)
      if (!built.ok) return { ok: false, message: built.problems.join("; ") }
      const created = await input.loops.create({ ...built.input, agent: input.name, creatorSessionId: input.sessionId as never, notify: "none" })
      if (!created.ok) return { ok: false, message: created.message }
      const { loop } = created
      return { ok: true, text: `Scheduled ${JSON.stringify(loop.name)} ${describeTrigger(loop.trigger)}\n${describeSchedule(loop)}\nList or cancel it with bot_schedule; the user sees it on your page.`, meta: { action: "create", loopId: loop.loopId, trigger: describeTrigger(loop.trigger) } }
    },
    scheduleList() {
      const loops = mineActive(input.loops, input.name)
      return { ok: true, text: loops.length ? loops.map(describeSchedule).join("\n") : "You have no schedules.", meta: { action: "list" } }
    },
    scheduleCancel(loopId) {
      const loop = mineActive(input.loops, input.name).find((candidate) => candidate.loopId === loopId)
      if (!loop) return { ok: false, message: `[BOT]: no schedule ${loopId} of yours` }
      input.loops.stop(loop.loopId)
      return { ok: true, text: `Cancelled ${JSON.stringify(loop.name)}\n${describeSchedule(loop)}`, meta: { action: "cancel", loopId } }
    },
  }
}
