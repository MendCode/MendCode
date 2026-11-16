import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { BOT_COLORS, BOT_SHAPES, MAX_AGENT_BYTES, parseAgentFile } from "@mendcode/packages"
import { redactSecrets, type AgentCreateReport, type AgentsReport, type BotInfo, type BotListReport, type BotSchedule, type BotState, type Command, type ExternalBotInfo, type SessionDetail } from "@mendcode/protocol"
import { AGENT_CREATE_PERMISSIONS, agentName } from "@mendcode/protocol/wire"
import { canonicalDir } from "@mendcode/tools"
import type { createAgentFile } from "./agent-create"
import type { AgentContent } from "./agent-generate"
import { addBotMemory, clearBotMemory, readBotMemory } from "./bot-memory"

/**
 * Experimental bots (docs/agents.md). A bot is an agent file with a `bot:` block in the user's own `agents/` folder; this
 * module lists bots with the state of their sessions and makes, copies, edits and remembers them. It is loaded by the first
 * `bot.*` command, never at start.
 */

/**
 * How an app other than MendCode shows its bots to this one. No connector ships with B1: the daemon takes a list of them
 * (`DaemonOptions.botConnectors`) and `bot.list` carries what they answer in `external`.
 */
export type BotConnector = {
  /** The origin its bots carry in their `bot.origin`. */
  id: string
  list(): Promise<ExternalBotInfo[]>
}

/** How long a failed chat keeps its bot in `problem`; a failure is news for a few minutes, not a permanent mark on the bot. */
export const BOT_PROBLEM_WINDOW_MS = 10 * 60_000

/**
 * A bot is `waiting` while any session of it waits on the user, else `working`, else `problem` while a session failed within the last
 * `BOT_PROBLEM_WINDOW_MS` and nothing of the bot has had newer activity that did not fail, else `idle`. A session's `updatedAt` is its
 * last conversation event, so for a failed chat it is the time of the failure. (The terminal keeps the same rule: view/bot-live.ts.)
 */
export function botStateOf(sessions: ReadonlyArray<{ status: string; updatedAt: number }>, now: number): BotState {
  if (sessions.some((session) => session.status.startsWith("waiting_"))) return "waiting"
  if (sessions.some((session) => session.status === "running")) return "working"
  const newestOk = Math.max(0, ...sessions.filter((session) => session.status !== "failed").map((session) => session.updatedAt))
  const recentFailure = sessions.some((session) => session.status === "failed" && now - session.updatedAt <= BOT_PROBLEM_WINDOW_MS && session.updatedAt >= newestOk)
  return recentFailure ? "problem" : "idle"
}

const COLOR_WORDS: ReadonlyArray<readonly [RegExp, (typeof BOT_COLORS)[number]]> = [
  [/\b(green|emerald|mint)\b/i, "success"], [/\b(red|crimson|scarlet)\b/i, "error"], [/\b(yellow|orange|amber|gold)\b/i, "warning"],
  [/\b(blue|cyan|teal|aqua)\b/i, "info"], [/\b(purple|violet|magenta|pink|lilac)\b/i, "accent"], [/\b(gr[ae]y|silver|white)\b/i, "secondary"],
]
const SHAPE_WORDS: ReadonlyArray<readonly [RegExp, (typeof BOT_SHAPES)[number]]> = [
  [/\b(round|circle|circular)\b/i, "circle"], [/\b(square|boxy)\b/i, "square"], [/\bdiamond\b/i, "diamond"], [/\b(triangle|triangular)\b/i, "triangle"], [/\b(hexagon|hexagonal)\b/i, "hexagon"],
]
/** The color and shape a request names in words ("a calm green reviewer" is `success`); neither is invented when it names none. */
export function lookFromText(text: string): { color?: (typeof BOT_COLORS)[number]; shape?: (typeof BOT_SHAPES)[number] } {
  const color = COLOR_WORDS.find(([pattern]) => pattern.test(text))?.[1]
  const shape = SHAPE_WORDS.find(([pattern]) => pattern.test(text))?.[1]
  return { ...(color ? { color } : {}), ...(shape ? { shape } : {}) }
}

export type BotContext = {
  /** The daemon's data directory: `agents/` and `bots/` live in it. */
  dir: string
  /** The agents of the user's layers. */
  agents(): AgentsReport
  /** The root sessions that ran as `name`, in every project. */
  sessions(name: string): SessionDetail[]
  /** The root sessions on a model id, in every project: the chats of an external bot (`chat`). Absent, external bots list no chats. */
  sessionsOfModel?(model: string): SessionDetail[]
  connectors(): readonly BotConnector[]
  /** The clock the failure window reads; the wall clock when absent. */
  now?(): number
  /** The schedules (loops) owned by `name`; absent when the host has no loops. */
  schedules?(name: string): BotSchedule[]
}

const isBot = (agent: AgentsReport["agents"][number]) => agent.bot !== undefined && agent.source === "user" && agent.trusted

/**
 * An external bot with the MendCode chats on its model, grouped by folder like a MendCode bot's, and the state those chats show
 * (the connector's own state stands while they are all idle). Generic per origin: nothing here names an app.
 */
function withChats(bot: ExternalBotInfo, context: BotContext, now: number): ExternalBotInfo {
  const sessions = bot.chat ? context.sessionsOfModel?.(bot.chat) ?? [] : []
  if (!sessions.length) return bot
  const byProject = new Map<string, SessionDetail[]>()
  for (const session of sessions) byProject.set(session.directory, [...(byProject.get(session.directory) ?? []), session])
  const own = botStateOf(sessions, now)
  return {
    ...bot,
    state: own !== "idle" ? own : bot.state,
    appState: bot.state,
    projects: [...byProject].map(([directory, group]) => ({
      directory,
      state: botStateOf(group, now),
      sessions: group.map((session) => ({ sessionId: session.sessionId, title: session.title, status: session.status, updatedAt: session.updatedAt })),
    })).sort((a, b) => a.directory.localeCompare(b.directory)),
  }
}

export async function listBots(context: BotContext): Promise<BotListReport> {
  const report = context.agents()
  const now = (context.now ?? Date.now)()
  const bots: BotInfo[] = report.agents.filter(isBot).map((agent) => {
    const sessions = context.sessions(agent.name)
    const byProject = new Map<string, SessionDetail[]>()
    for (const session of sessions) byProject.set(session.directory, [...(byProject.get(session.directory) ?? []), session])
    return {
      name: agent.name,
      description: agent.description,
      identity: agent.bot!,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.permission ? { permission: agent.permission } : {}),
      ...(!agent.permission && agent.permissionRules?.length ? { permissionRules: true } : {}),
      file: agent.file ?? "",
      state: botStateOf(sessions, now),
      schedules: context.schedules?.(agent.name) ?? [],
      projects: [...byProject].map(([directory, group]) => ({
        directory,
        state: botStateOf(group, now),
        sessions: group.map((session) => ({ sessionId: session.sessionId, title: session.title, status: session.status, updatedAt: session.updatedAt })),
      })).sort((a, b) => a.directory.localeCompare(b.directory)),
    }
  })
  const problems = [...report.problems]
  const external: ExternalBotInfo[] = []
  for (const connector of context.connectors()) {
    try { external.push(...(await connector.list()).map((bot) => withChats(bot, context, now))) } catch (error) { problems.push({ file: `connector:${connector.id}`, message: error instanceof Error ? error.message : String(error) }) }
  }
  return { bots, external, problems }
}

/** An agent file larger than the loader reads is skipped, so the bot would vanish from the list: nothing larger is written. */
function checkSize(text: string) {
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_AGENT_BYTES) throw new Error(`[BOT]: the file would take ${bytes} bytes, more than the ${MAX_AGENT_BYTES} an agent file may hold (non-Latin text takes more than one byte a character); shorten the personality`)
}

/** A copy beside the file under a name of its own, then a rename: a reader never sees half a file and two saves never share the copy. */
async function replaceFile(file: string, text: string) {
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(staged, text, { mode: 0o600, flag: "wx" })
    await rename(staged, file)
  } catch (error) {
    await rm(staged, { force: true })
    throw error
  }
}

/** The bot named `name` in the user's layers, or why not. */
function find(context: BotContext, name: string): { agent: AgentsReport["agents"][number] } | { error: string } {
  const agent = context.agents().agents.find((candidate) => candidate.name === name && candidate.trusted)
  if (!agent || !isBot(agent)) return { error: `[BOT]: no bot named ${name}; /bot list shows them` }
  return { agent }
}

export async function createBot(input: {
  dir: string
  command: Extract<Command, { type: "bot.create" }>
  outcome?: { generated?: AgentContent; fallback?: string; calledProvider?: boolean }
  /** Whether an agent already has this name (a bot or not). */
  exists(name: string): boolean
  /** The daemon's own `createAgentFile`, passed in so this lazy module shares no chunk with the start-up graph. */
  write: typeof createAgentFile
}): Promise<AgentCreateReport> {
  const { command } = input
  if (command.name !== undefined && (input.exists(command.name) || ["build", "plan"].includes(command.name))) throw new Error(`[BOT]: ${command.name} is already an agent name`)
  const look = lookFromText(command.description)
  const shape = command.shape ?? look.shape
  const color = command.color ?? look.color
  const extraFrontmatter = ["permission: smart", "bot:", ...(shape ? [`  shape: ${shape}`] : []), ...(color ? [`  color: ${color}`] : []), "  origin: mendcode"]
  return input.write(input.dir, {
    id: command.id, clientId: command.clientId, type: "agent.create", directory: command.directory, scope: "user",
    ...(command.name ? { name: command.name } : {}), description: command.description, mode: "primary",
    permissions: [...AGENT_CREATE_PERMISSIONS], ...(command.model ? { model: command.model } : {}), ...(command.generate ? { generate: true } : {}),
  }, { ...input.outcome, extraFrontmatter })
}

export async function duplicateBot(context: BotContext, command: Extract<Command, { type: "bot.duplicate" }>): Promise<AgentCreateReport> {
  const found = find(context, command.name)
  if ("error" in found) throw new Error(found.error)
  if (context.agents().agents.some((agent) => agent.name === command.newName) || ["build", "plan"].includes(command.newName)) throw new Error(`[BOT]: ${command.newName} is already an agent name`)
  const source = found.agent.file!
  // Only a `name:` line of the frontmatter is renamed (any line of it, the first included); the body is left as it is.
  const text = (await readFile(source, "utf8")).replace(/^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/, (_whole, open: string, front: string, close: string) => `${open}${front.replace(/^name:[^\r\n]*/m, `name: ${command.newName}`)}${close}`)
  const file = path.join(context.dir, "agents", `${command.newName}.md`)
  const parsed = parseAgentFile({ text, stem: command.newName, file, source: "user" })
  if ("problem" in parsed) throw new Error(`[BOT]: ${parsed.problem}`)
  if (parsed.agent.name !== command.newName) throw new Error(`[BOT]: the copy would still be named ${parsed.agent.name}`)
  checkSize(text)
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, text, { flag: "wx", mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`[BOT]: agent file already exists: ${file}`)
    throw error
  }
  const { prompt: _prompt, ...agent } = parsed.agent
  return { file, agent: { ...agent, trusted: true }, generation: "deterministic", callsProviders: false }
}

/** The bot's file as written, or (with `text`) replaced after the text is checked: it must still be this bot. */
export async function botFile(context: BotContext, command: Extract<Command, { type: "bot.file" }>): Promise<{ file: string; text: string; saved: boolean; /** The personality the agent loads with: a frontmatter `prompt:` outranks the body. */ prompt?: string }> {
  const found = find(context, command.name)
  if ("error" in found) throw new Error(found.error)
  const file = found.agent.file!
  if (command.text === undefined) {
    const text = await readFile(file, "utf8")
    const parsed = parseAgentFile({ text, stem: command.name, file, source: "user" })
    return { file, text, saved: false, ...("agent" in parsed ? { prompt: parsed.agent.prompt } : {}) }
  }
  const parsed = parseAgentFile({ text: command.text, stem: command.name, file, source: "user" })
  if ("problem" in parsed) throw new Error(`[BOT]: ${parsed.problem}`)
  if (parsed.agent.name !== command.name) throw new Error(`[BOT]: the name must stay ${command.name}; /bot duplicate ${command.name} <new> makes another bot`)
  if (!parsed.agent.bot) throw new Error("[BOT]: the file lost its bot: block, so it would stop being a bot")
  checkSize(command.text)
  await replaceFile(file, command.text)
  return { file, text: command.text, saved: true }
}

/** A frontmatter split into its top-level blocks (a `key:` line and the indented or blank lines under it) and the body after it. */
function splitFile(text: string): { blocks: Array<{ key: string; lines: string[] }>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return undefined
  const blocks: Array<{ key: string; lines: string[] }> = []
  for (const line of match[1]!.split(/\r?\n/)) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1]
    if (key !== undefined) blocks.push({ key, lines: [line] })
    else blocks[blocks.length - 1]?.lines.push(line)
  }
  return { blocks, body: text.slice(match[0].length) }
}

/**
 * The agent file with the form's fields applied: description (when given), model, permission and the `bot:` block are rewritten,
 * every other frontmatter block is kept as it was, and the body becomes the personality.
 */
export function applyBotFields(text: string, fields: Pick<Extract<Command, { type: "bot.save" }>, "description" | "prompt" | "shape" | "color" | "avatar" | "model" | "permission">): string | undefined {
  const parts = splitFile(text)
  if (!parts) return undefined
  const old = parts.blocks.find((block) => block.key === "bot")
  const origin = old?.lines.map((line) => /^\s+origin:\s*(\S+)/.exec(line)?.[1]).find(Boolean) ?? "mendcode"
  // A `prompt:` block of the frontmatter outranks the body when the agent loads, so the personality the form edits would never apply
  // while it stays: the body replaces it. A permission mapping stays unless the form deliberately set one.
  const replaced = ["model", "bot", "prompt", ...(fields.permission !== undefined ? ["permission"] : []), ...(fields.description !== undefined ? ["description"] : [])]
  const kept = parts.blocks.filter((block) => !replaced.includes(block.key)).flatMap((block) => block.lines)
  const front = [
    ...(fields.description !== undefined ? [`description: ${JSON.stringify(fields.description)}`] : []),
    ...kept,
    ...(fields.model ? [`model: ${JSON.stringify(fields.model)}`] : []),
    ...(fields.permission !== undefined ? [`permission: ${fields.permission}`] : parts.blocks.some((block) => block.key === "permission") ? [] : ["permission: smart"]),
    "bot:",
    ...(fields.shape ? [`  shape: ${fields.shape}`] : []),
    ...(fields.color ? [`  color: ${fields.color}`] : []),
    ...(fields.avatar ? [`  avatar: ${JSON.stringify(fields.avatar)}`] : []),
    `  origin: ${origin}`,
  ]
  const body = fields.prompt.trim()
  return ["---", ...front, "---", body, ""].join("\n")
}

/** Where a bot's file must be: directly in the user's own `agents/` folder. */
const ownFile = (context: BotContext, file: string) => path.dirname(path.resolve(file)) === path.join(context.dir, "agents")

/** The form's save: a new bot (a taken name is refused) or an existing one rewritten in place. Nothing is written unless the result is still this bot. */
export async function saveBot(context: BotContext, command: Extract<Command, { type: "bot.save" }>): Promise<AgentCreateReport> {
  const checked = (text: string | undefined, file: string) => {
    if (text === undefined) throw new Error("[BOT]: the file has no frontmatter, so it would stop being a bot")
    const parsed = parseAgentFile({ text, stem: command.name, file, source: "user" })
    if ("problem" in parsed) throw new Error(`[BOT]: ${parsed.problem}`)
    if (!parsed.agent.bot) throw new Error("[BOT]: the file lost its bot: block, so it would stop being a bot")
    return parsed.agent
  }
  const report = (file: string, agent: ReturnType<typeof checked>): AgentCreateReport => {
    const { prompt: _prompt, ...rest } = agent
    return { file, agent: { ...rest, trusted: true }, generation: "deterministic", callsProviders: false }
  }
  if (command.create) {
    if (context.agents().agents.some((agent) => agent.name === command.name) || ["build", "plan"].includes(command.name)) throw new Error(`[BOT]: ${command.name} is already an agent name`)
    const file = path.join(context.dir, "agents", `${command.name}.md`)
    const description = command.description ?? `The ${command.name} bot`
    const text = applyBotFields(`---\ndescription: ${JSON.stringify(description)}\nmode: primary\n---\n`, { ...command, prompt: command.prompt.trim() ? command.prompt : description, description })
    const agent = checked(text, file)
    checkSize(text!)
    await mkdir(path.dirname(file), { recursive: true })
    try { await writeFile(file, text!, { flag: "wx", mode: 0o600 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`[BOT]: agent file already exists: ${file}`)
      throw error
    }
    return report(file, agent)
  }
  const found = find(context, command.name)
  if ("error" in found) throw new Error(found.error)
  const file = found.agent.file!
  if (!ownFile(context, file)) throw new Error(`[BOT]: ${command.name} is not in your own agents folder, so it cannot be edited here`)
  const text = applyBotFields(await readFile(file, "utf8"), { ...command, prompt: command.prompt.trim() ? command.prompt : found.agent.description })
  const agent = checked(text, file)
  checkSize(text!)
  await replaceFile(file, text!)
  return report(file, agent)
}

/** What the model would write for a description, not written: the form shows it to confirm. */
export function draftBot(input: {
  command: Extract<Command, { type: "bot.draft" }>
  outcome?: { generated?: AgentContent; fallback?: string; calledProvider?: boolean }
  exists(name: string): boolean
}): { name: string; description: string; prompt: string; shape?: (typeof BOT_SHAPES)[number]; color?: (typeof BOT_COLORS)[number]; generation: "model" | "deterministic"; callsProviders: boolean; fallback?: string } {
  const { command, outcome } = input
  const name = outcome?.generated?.name ?? command.name ?? agentName(command.description)
  if (command.name !== undefined && (input.exists(name) || ["build", "plan"].includes(name))) throw new Error(`[BOT]: ${name} is already an agent name`)
  const look = lookFromText(command.description)
  return {
    name, description: outcome?.generated?.description ?? command.description, prompt: outcome?.generated?.prompt ?? command.description,
    ...look, generation: outcome?.generated ? "model" : "deterministic", callsProviders: outcome?.calledProvider ?? false, ...(outcome?.fallback ? { fallback: outcome.fallback } : {}),
  }
}

/** Removes a bot's agent file, and with `memory` its memory folder. Sessions are only counted: they stay as ordinary sessions. */
export async function deleteBot(context: BotContext, command: Extract<Command, { type: "bot.delete" }>): Promise<{ file: string; memoryRemoved: boolean; sessions: number }> {
  const found = find(context, command.name)
  if ("error" in found) throw new Error(found.error)
  const file = found.agent.file!
  if (!ownFile(context, file)) throw new Error(`[BOT]: ${command.name} is not in your own agents folder, so it cannot be deleted here`)
  const sessions = context.sessions(command.name).length
  let memoryRemoved = false
  // The memory goes first: if it cannot be removed the bot is still there, and deleting again finishes the job.
  if (command.memory) {
    const folder = path.join(context.dir, "bots", command.name)
    if (path.dirname(path.resolve(folder)) === path.join(context.dir, "bots")) {
      memoryRemoved = existsSync(folder)
      try { await rm(folder, { recursive: true, force: true }) } catch (error) {
        throw new Error(`[BOT]: the memory folder could not be removed (${error instanceof Error ? error.message : String(error)}); ${command.name} is kept, so delete can be tried again`)
      }
    }
  }
  await rm(file, { force: true })
  return { file, memoryRemoved, sessions }
}

export function botMemory(context: BotContext, command: Extract<Command, { type: "bot.memory" }>): { global: string; project?: string } {
  const found = find(context, command.name)
  if ("error" in found) throw new Error(found.error)
  const place = (scope: "global" | "project") => {
    if (scope === "global") return { dir: context.dir, name: command.name }
    if (!command.directory) throw new Error("[BOT]: project memory needs a directory")
    return { dir: context.dir, name: command.name, directory: canonicalDir(command.directory) }
  }
  if (command.op === "add") {
    if (!command.text) throw new Error("[BOT]: add needs text")
    const failure = addBotMemory(place(command.scope ?? "global"), redactSecrets(command.text).text)
    if (failure) throw new Error(failure)
  }
  if (command.op === "clear") clearBotMemory(place(command.scope ?? "global"))
  return { global: readBotMemory(place("global")), ...(command.directory ? { project: readBotMemory(place("project")) } : {}) }
}
