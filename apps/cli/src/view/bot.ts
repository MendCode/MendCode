import type { BotInfo, BotListReport } from "@mendcode/protocol"

/** Experimental bots (docs/agents.md): the words of `/bot` and the text its pages show. Pure, so the daemon-free parts are tested alone. */
export const BOT_USAGE = "usage: /bot [list] · new [name] · new <name> <description> · new -d <description> · open [name] · edit <name> · delete <name> · duplicate <name> <new> · memory <name> [add|clear] [--project] [text]"
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type BotWords =
  | { kind: "list" }
  /** The form opens either way; with `generate` the model's draft of `description` fills it first. */
  | { kind: "new"; name?: string; description: string; generate: boolean }
  /** The bot's page; no name means the bot of the open chat. */
  | { kind: "open"; name?: string }
  | { kind: "edit"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "duplicate"; name: string; newName: string }
  | { kind: "memory"; name: string; op: "list" | "add" | "clear"; project: boolean; text?: string }
  | { kind: "error"; message: string }

const bad = (message: string): BotWords => ({ kind: "error", message })
const nameError = (name: string) => `${name} is not a bot name: lowercase letters, digits, _ and - (at most 64)`

export function parseBotWords(args: string): BotWords {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [verb, ...rest] = words
  if (verb === undefined || verb === "list") return rest.length ? bad("list takes no arguments") : { kind: "list" }
  if (verb === "new") {
    if (rest[0] === "-d" || rest[0] === "--describe") {
      const description = rest.slice(1).join(" ")
      if (!description) return bad("-d needs a description, for example: /bot new -d a calm green reviewer")
      return description.length > 300 ? bad(`a description takes at most 300 characters (this one has ${description.length})`) : { kind: "new", description, generate: true }
    }
    const [name, ...text] = rest
    // No words: an empty form. A name: the form with the name filled in. A description too: the model drafts it (the plain template when that fails) and the form shows the draft.
    if (!name) return { kind: "new", description: "", generate: false }
    if (!NAME.test(name)) return bad(nameError(name))
    const description = text.join(" ")
    if (description.length > 300) return bad(`a description takes at most 300 characters (this one has ${description.length})`)
    return { kind: "new", name, description, generate: description !== "" }
  }
  if (verb === "open") return rest.length === 0 ? { kind: "open" } : rest.length === 1 && NAME.test(rest[0]!) ? { kind: "open", name: rest[0]! } : bad("open takes one bot name, or none for the bot of this chat")
  if (verb === "edit") return rest.length === 1 && NAME.test(rest[0]!) ? { kind: "edit", name: rest[0]! } : bad("edit needs one bot name")
  if (verb === "delete") return rest.length === 1 && NAME.test(rest[0]!) ? { kind: "delete", name: rest[0]! } : bad("delete needs one bot name")
  if (verb === "duplicate") {
    if (rest.length !== 2) return bad("duplicate needs the bot's name and the new name")
    const invalid = rest.find((name) => !NAME.test(name))
    return invalid ? bad(nameError(invalid)) : { kind: "duplicate", name: rest[0]!, newName: rest[1]! }
  }
  if (verb === "memory") {
    const [name, ...tail] = rest
    if (!name || !NAME.test(name)) return bad("memory needs a bot name")
    const project = tail.includes("--project")
    const open = tail.filter((word) => word !== "--project")
    const op = open[0]
    if (op === undefined) return { kind: "memory", name, op: "list", project }
    if (op === "clear") return open.length === 1 ? { kind: "memory", name, op: "clear", project } : bad("clear takes no text")
    if (op === "add") {
      const text = open.slice(1).join(" ")
      return text ? { kind: "memory", name, op: "add", project, text } : bad("add needs the text to remember")
    }
    return bad(`unknown memory word: ${op}`)
  }
  return bad(`unknown bot word: ${verb}`)
}

const STATE_MARK: Record<BotInfo["state"], string> = { working: "working", waiting: "waiting for you", idle: "idle", problem: "problem" }

/** One line per bot, then its projects. State is always a word, never only a color. */
export function botListText(report: BotListReport): string[] {
  const lines: string[] = []
  for (const bot of report.bots) {
    const look = [bot.identity.shape, bot.identity.color].filter(Boolean).join(" ")
    lines.push(`- ${bot.name} · ${STATE_MARK[bot.state]}${look ? ` · ${look}` : ""}${bot.identity.origin === "mendcode" ? "" : ` · from ${bot.identity.origin}`} · ${bot.description}`)
    for (const project of bot.projects) lines.push(`    ${project.directory} · ${STATE_MARK[project.state]} · ${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"}`)
  }
  for (const bot of report.external) lines.push(`- ${bot.name} · ${STATE_MARK[bot.state]} · from ${bot.origin}${bot.description ? ` · ${bot.description}` : ""}`)
  return lines
}
