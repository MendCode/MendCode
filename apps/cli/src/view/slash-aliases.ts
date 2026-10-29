import type { SlashPreference } from "@mendcode/protocol/wire"
import { DIAGNOSTIC_COMMANDS, SLASH_COMMANDS, type SlashCommand } from "./commands"

/**
 * Names that were once an alias of a built-in command and are not any more (docs/commands.md, "Aliases"). Typing one runs nothing;
 * the line says where the command went. Static on purpose: no fuzzy guessing, and a name the user defines (a command file, an
 * extension command, a profile alias) is never answered with this.
 */
const REMOVED: Record<string, string> = {
  mode: "view", "session-history": "history", branches: "tree", bookmark: "label", features: "experimental", tiers: "tier",
  warnings: "debug-config", dictate: "voice", note: "scratch", hotkeys: "shortcuts", recall: "prompt-history", tour: "tutorial",
  "screen-reader": "accessible", diagrams: "diagram", "set-context-window": "context-window", detach: "bg", continue: "unpause",
  memories: "memory", "memory-manager": "memory", "memory-center": "memory", onboarding: "setup", configure: "setup",
  tui: "customize", customization: "customize", capabilities: "customize", "tui-customization": "customize", av: "agents",
  "usage-limit": "limit", workflow: "workflows", disk: "storage", "prompt-context": "prompt-mode", prompt: "prompt-mode",
  modes: "prompt-mode", chatinput: "prompt-chrome", "prompt-style": "prompt-chrome", "tui-prompt": "prompt-chrome",
  "chat-presentation": "presentation", "render-mode": "presentation", "message-renderer": "message-rendering",
  "markdown-rendering": "message-rendering", "send-scroll": "submit-scroll", "clear-submit": "submit-scroll",
  "toggle-timestamps": "timestamps", "toggle-thinking": "thinking", latest: "jump-to-latest", comment: "comments",
  replies: "comments", working: "activity", "activity-status": "activity", sticky: "sticky-prompt", "project-stats": "stats-project",
  "project-usage": "stats-project", "commit-push": "commit push", "commit-pr": "commit pr", "pr-comments": "pr comments", "replay-intro": "intro",
  pair: "remote-control", orgs: "org", "switch-org": "org",
}

/** The daemon's templates behind `/commit push`, `/commit pr` and `/pr comments`: the terminal runs them through those, never by their own names. */
export const COMMIT_TEMPLATES: ReadonlySet<string> = new Set(["commit-push", "commit-pr", "pr-comments"])

/** `/tui is now /customize` for a typed line whose command word is a removed alias; undefined for anything else. */
export function removedAliasHint(text: string): string | undefined {
  const word = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s|$)/i.exec(text)?.[1]?.toLowerCase()
  const now = word === undefined || !Object.hasOwn(REMOVED, word) ? undefined : REMOVED[word]
  return word !== undefined && now !== undefined ? `/${word} is now /${now}` : undefined
}

const builtinWords = () => new Set([...SLASH_COMMANDS, ...DIAGNOSTIC_COMMANDS].flatMap((command) => [command.name, ...command.aliases]))

/**
 * The aliases a profile defines (`slashCommands: [{ name: "changes", aliases: ["d"] }]`): alias to command name. An alias that is the
 * word of a built-in command or of a command of the project, or whose command does not exist, is left out, so a user alias never
 * shadows anything and never chains to another alias.
 */
export function userAliases(prefs: readonly SlashPreference[], commands: readonly Pick<SlashCommand, "name">[] = []): Map<string, string> {
  const taken = builtinWords()
  const targets = new Set([...SLASH_COMMANDS, ...commands].map((command) => command.name))
  const own = new Set(commands.map((command) => command.name))
  const found = new Map<string, string>()
  for (const entry of prefs) {
    if (!targets.has(entry.name)) continue
    for (const alias of entry.aliases ?? []) if (!taken.has(alias) && !own.has(alias) && !found.has(alias)) found.set(alias, entry.name)
  }
  return found
}

/** What is wrong with the aliases of a profile, one line each, for `/doctor`; empty when every alias works. */
export function userAliasProblems(prefs: readonly SlashPreference[], commands: readonly Pick<SlashCommand, "name">[] = []): string[] {
  const taken = builtinWords()
  const own = new Set(commands.map((command) => command.name))
  const targets = new Set([...SLASH_COMMANDS, ...commands].map((command) => command.name))
  return prefs.flatMap((entry) => (entry.aliases ?? []).flatMap((alias) =>
    !targets.has(entry.name) ? [`alias ${alias} is ignored: there is no command ${entry.name}`]
      : taken.has(alias) ? [`alias ${alias} is ignored: /${alias} is a built-in command`]
        : own.has(alias) ? [`alias ${alias} is ignored: a command named ${alias} exists`]
          : []))
}

/** The line with a user alias in command position replaced by its command (`/d x` is `/changes x`); undefined when it holds none. */
export function expandUserAlias(text: string, prefs: readonly SlashPreference[], commands: readonly Pick<SlashCommand, "name">[] = []): string | undefined {
  if (!prefs.some((entry) => entry.aliases?.length)) return undefined
  const match = /^\/([a-z0-9][a-z0-9_-]*)(\s[\s\S]*)?$/.exec(text)
  const target = match ? userAliases(prefs, commands).get(match[1]!) : undefined
  return match && target ? `/${target}${match[2] ?? ""}` : undefined
}

/** The aliases a command has from the profile, for the menu next to its own. */
export const aliasesOf = (name: string, prefs: readonly SlashPreference[]): string[] => prefs.find((entry) => entry.name === name)?.aliases ?? []
