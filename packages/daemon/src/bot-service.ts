import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { BOT_COLORS, BOT_SHAPES, parseAgentFile } from "@mendcode/packages"
import { redactSecrets, type AgentCreateReport, type AgentsReport, type BotInfo, type BotListReport, type BotState, type Command, type ExternalBotInfo, type SessionDetail } from "@mendcode/protocol"
import { AGENT_CREATE_PERMISSIONS } from "@mendcode/protocol/wire"
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

/** A bot is `waiting` while any session of it waits on the user, else `working`, else `problem` when a session failed, else `idle`. */
export function botStateOf(statuses: readonly string[]): BotState {
  if (statuses.some((status) => status.startsWith("waiting_"))) return "waiting"
  if (statuses.includes("running")) return "working"
  if (statuses.includes("failed")) return "problem"
  return "idle"
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
  connectors(): readonly BotConnector[]
}

const isBot = (agent: AgentsReport["agents"][number]) => agent.bot !== undefined && agent.source === "user" && agent.trusted

export async function listBots(context: BotContext): Promise<BotListReport> {
  const report = context.agents()
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
      file: agent.file ?? "",
      state: botStateOf(sessions.map((session) => session.status)),
      projects: [...byProject].map(([directory, group]) => ({
        directory,
        state: botStateOf(group.map((session) => session.status)),
        sessions: group.map((session) => ({ sessionId: session.sessionId, title: session.title, status: session.status, updatedAt: session.updatedAt })),
      })).sort((a, b) => a.directory.localeCompare(b.directory)),
    }
  })
  const problems = [...report.problems]
  const external: ExternalBotInfo[] = []
  for (const connector of context.connectors()) {
    try { external.push(...await connector.list()) } catch (error) { problems.push({ file: `connector:${connector.id}`, message: error instanceof Error ? error.message : String(error) }) }
  }
  return { bots, external, problems }
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
  const text = (await readFile(source, "utf8")).replace(/^(---\r?\n[\s\S]*?\r?\n)name:[^\n]*\n/, `$1name: ${command.newName}\n`)
  const file = path.join(context.dir, "agents", `${command.newName}.md`)
  const parsed = parseAgentFile({ text, stem: command.newName, file, source: "user" })
  if ("problem" in parsed) throw new Error(`[BOT]: ${parsed.problem}`)
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, text, { flag: "wx", mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`[BOT]: agent file already exists: ${file}`)
    throw error
  }
  const { prompt: _prompt, ...agent } = parsed.agent
  return { file, agent: { ...agent, trusted: true }, generation: "deterministic", callsProviders: false }
}

/** The bot's file as written, or (with `text`) replaced after the text is checked: it must still be this bot. */
export async function botFile(context: BotContext, command: Extract<Command, { type: "bot.file" }>): Promise<{ file: string; text: string; saved: boolean }> {
  const found = find(context, command.name)
  if ("error" in found) throw new Error(found.error)
  const file = found.agent.file!
  if (command.text === undefined) return { file, text: await readFile(file, "utf8"), saved: false }
  const parsed = parseAgentFile({ text: command.text, stem: command.name, file, source: "user" })
  if ("problem" in parsed) throw new Error(`[BOT]: ${parsed.problem}`)
  if (parsed.agent.name !== command.name) throw new Error(`[BOT]: the name must stay ${command.name}; /bot duplicate ${command.name} <new> makes another bot`)
  if (!parsed.agent.bot) throw new Error("[BOT]: the file lost its bot: block, so it would stop being a bot")
  // A copy beside the file, then a rename, so a reader never sees half a file.
  const staged = `${file}.${process.pid}.tmp`
  await writeFile(staged, command.text, { mode: 0o600 })
  await rename(staged, file)
  return { file, text: command.text, saved: true }
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
