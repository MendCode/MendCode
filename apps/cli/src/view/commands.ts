import type { Line } from "../ui/theme"
import { FEATURES, featureState, slashTier, tierIncludes, type FeatureId, type SlashGroupId, type SlashPreference, type Tier, type TierSettings } from "@mendcode/protocol/wire"
import { SLASH_TIERS, SLASH_TIER_CAPS, slashMatch } from "./slash-match"
import { POPUP_ROWS, popupWindowStart, renderPopup } from "./popup"
import { argumentMatches } from "./slash-arguments"

export type SlashCommand = {
  name: string
  group: SlashGroupId
  feature?: FeatureId
  setting?: string
  aliases: string[]
  summary: string
  shortcut?: string
  /** From .mendcode/commands: inserted as text so its arguments can follow. */
  custom?: true
  /** From a terminal extension (`api.command`): runs in this terminal, and is inserted as text like a custom one. */
  ext?: true
  mcp?: true
  /** Set on the catalog the command editor shows: the tier does not list it unless the user's `hidden: false` does. */
  tierHidden?: true
  /** A row of a command's argument words (`/pr publish`, view/slash-arguments.ts): `more` when another word follows it. */
  argument?: { more: boolean }
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", group: "session", aliases: [], summary: "Start a session" },
  { name: "sessions", group: "session", aliases: ["resume"], summary: "Switch session" },
  { name: "usage", group: "session", aliases: ["stats"], summary: "Show usage and quota" },
  { name: "view", group: "look", setting: "presentation", aliases: [], summary: "Change view" },
  { name: "model", group: "setup", aliases: ["models"], summary: "Switch model" },
  { name: "agent", group: "agents", aliases: [], summary: "Switch session agent" },
  { name: "connect", group: "setup", aliases: [], summary: "Connect an API-key provider" },
  { name: "providers", group: "setup", aliases: ["provider"], summary: "Manage API-key providers" },
  { name: "permissions", group: "setup", aliases: ["perm"], summary: "Manage permissions and grants" },
  { name: "approve", group: "setup", aliases: [], summary: "Allow one retry of a denied call" },
  { name: "plan", group: "code", aliases: [], summary: "Toggle plan mode" },
  { name: "compact", group: "context", aliases: [], summary: "Compact session" },
  { name: "undo", group: "code", aliases: [], summary: "Undo the last message and its file edits" },
  { name: "redo", group: "code", aliases: [], summary: "Redo the undone message" },
  { name: "history", group: "session", aliases: [], summary: "Browse session history" },
  { name: "skills", group: "setup", aliases: [], summary: "Manage and load project skills" },
  { name: "variants", group: "setup", aliases: [], summary: "Select model variant" },
  { name: "rename", group: "session", aliases: [], summary: "Rename this session" },
  { name: "title", group: "session", feature: "session_meta", aliases: [], summary: "Regenerate this session's title" },
  { name: "pin", group: "session", feature: "session_meta", aliases: [], summary: "Toggle the session pin" },
  { name: "settle", group: "session", feature: "session_meta", aliases: [], summary: "Manage session settling" },
  { name: "fanout", group: "agents", feature: "fanout", aliases: [], summary: "Compare isolated branch runs" },
  { name: "editor", group: "code", aliases: [], summary: "Edit the prompt in $EDITOR" },
  { name: "timeline", group: "session", aliases: [], summary: "Jump to or fork at a message" },
  { name: "fork", group: "session", aliases: [], summary: "Fork or merge a session" },
  { name: "handoff", group: "agents", feature: "handoff", aliases: [], summary: "Start a focused handoff session" },
  { name: "tree", group: "session", aliases: [], summary: "Browse messages, forks and child agents" },
  { name: "label", group: "session", aliases: [], summary: "Bookmark the latest message" },
  { name: "recap", group: "context", aliases: [], summary: "Summarize this session" },
  { name: "changelog", group: "more", aliases: [], summary: "Show MendCode changes" },
  { name: "export", group: "session", aliases: [], summary: "Export the transcript" },
  { name: "import", group: "session", aliases: [], summary: "Import a Claude Code or Codex session" },
  { name: "fast", group: "setup", aliases: [], summary: "Toggle priority service" },
  { name: "output-style", group: "look", aliases: [], summary: "Choose an answer tone" },
  { name: "experimental", group: "setup", aliases: [], summary: "Toggle experimental features" },
  { name: "tier", group: "setup", aliases: [], summary: "Choose a feature tier" },
  { name: "graph", group: "setup", feature: "codegraph", aliases: [], summary: "Set code graph indexing: on, off or auto" },
  { name: "debug-config", group: "setup", aliases: [], summary: "Inspect config layers and warnings" },
  { name: "cd", group: "setup", aliases: [], summary: "Move this session to another directory" },
  { name: "pwd", group: "setup", aliases: [], summary: "Show this session's directory" },
  { name: "sandbox", group: "setup", aliases: [], summary: "Choose a shell sandbox" },
  { name: "voice", group: "more", feature: "voice", aliases: [], summary: "Dictate into the prompt" },
  { name: "add-dir", group: "setup", aliases: [], summary: "Manage workspace directories" },
  { name: "sidebar", group: "look", aliases: [], summary: "Toggle the sessions sidebar" },
  { name: "panel", group: "look", feature: "panel", aliases: [], summary: "Customize the right panel" },
  { name: "scratch", group: "context", aliases: [], summary: "Edit this project's scratch note" },
  { name: "backlog", group: "context", feature: "backlog", aliases: [], summary: "Manage this project's backlog" },
  { name: "remember", group: "context", aliases: [], summary: "Save a memory" },
  { name: "open", group: "context", feature: "file_viewer", aliases: [], summary: "Open a file at a line in the viewer" },
  { name: "attach", group: "context", aliases: [], summary: "Attach a file" },
  { name: "stash", group: "session", aliases: [], summary: "Browse stashed prompts" },
  { name: "drafts", group: "session", aliases: [], summary: "Restore earlier unsent drafts" },
  { name: "vim", group: "look", setting: "vimMode", aliases: [], summary: "Toggle prompt Vim mode" },
  { name: "multiline", group: "look", setting: "multiline", aliases: [], summary: "Toggle multiline input" },
  { name: "shortcuts", group: "more", aliases: [], summary: "Show keyboard shortcuts" },
  { name: "prompt-history", group: "session", aliases: [], summary: "Search this project's earlier prompts" },
  { name: "backtrack", group: "session", aliases: [], summary: "Edit an earlier prompt and resend" },
  { name: "keymap", group: "setup", aliases: ["keybindings"], summary: "Edit key bindings" },
  { name: "terminal-setup", group: "setup", aliases: [], summary: "Configure terminal key reporting" },
  { name: "tutorial", group: "more", aliases: [], summary: "Tour the terminal" },
  { name: "accessible", group: "look", setting: "accessible", aliases: [], summary: "Toggle screen-reader output" },
  { name: "doctor", group: "more", aliases: [], summary: "Check terminal capabilities" },
  { name: "copy", group: "session", aliases: [], summary: "Copy a response or transcript" },
  { name: "diagram", group: "more", aliases: [], summary: "Open a diagram full screen" },
  { name: "changes", group: "code", aliases: ["diff"], summary: "Review changes and replay hunks" },
  { name: "git", group: "code", feature: "git_hub", aliases: [], summary: "Review, commit and see worktrees" },
  { name: "context", group: "context", aliases: ["ctx"], summary: "Inspect context usage" },
  { name: "files", group: "context", aliases: [], summary: "Browse context files" },
  { name: "context-window", group: "context", aliases: [], summary: "Set the context window; --always keeps it" },
  { name: "env", group: "context", aliases: [], summary: "Connect encrypted credentials" },
  { name: "privacy", group: "context", aliases: [], summary: "Toggle optional local chat encryption" },
  { name: "secrets", group: "context", aliases: [], summary: "Manage pasted secrets" },
  { name: "ps", group: "agents", aliases: [], summary: "Show or stop background commands" },
  { name: "tasks", group: "agents", feature: "subagents", aliases: [], summary: "Browse child sessions" },
  { name: "bg", group: "agents", aliases: ["background"], summary: "Detach to Agent View" },
  { name: "pause", group: "session", aliases: [], summary: "Pause after the running turn" },
  { name: "unpause", group: "session", aliases: [], summary: "Resume a paused session" },
  { name: "stop", group: "session", aliases: [], summary: "Stop the running turn and sub-agents" },
  { name: "memory", group: "context", aliases: ["mem"], summary: "Review saved memories" },
  { name: "dream", group: "context", aliases: [], summary: "Propose memories" },
  { name: "btw", group: "agents", aliases: [], summary: "Open a side chat" },
  { name: "fetch", group: "more", aliases: [], summary: "Show project and MendCode details" },
  { name: "setup", group: "setup", aliases: [], summary: "Configure setup and health checks" },
  { name: "settings", group: "setup", aliases: ["config"], summary: "Edit saved settings" },
  { name: "customize", group: "look", aliases: [], summary: "Customize the terminal layout" },
  { name: "status", group: "setup", aliases: [], summary: "Inspect daemon and engine status" },
  { name: "extensions", group: "setup", feature: "extensions", aliases: ["ext"], summary: "Manage and reload extensions" },
  { name: "hooks", group: "setup", feature: "hooks", aliases: [], summary: "Inspect hooks and recent runs" },
  { name: "trust", group: "setup", aliases: [], summary: "Trust project integrations" },
  { name: "agents", group: "agents", feature: "subagents", aliases: [], summary: "Browse running agents" },
  { name: "goal", group: "agents", aliases: [], summary: "Work on an objective until it is done" },
  { name: "limit", group: "session", aliases: [], summary: "Resume a turn paused by a usage limit" },
  { name: "daemon", group: "more", aliases: [], summary: "Show or restart the daemon" },
  { name: "restart", group: "more", aliases: [], summary: "Restart this terminal on the same session" },
  { name: "reload", group: "more", aliases: [], summary: "Reload extensions, packages, keys and themes" },
  { name: "pr", group: "code", feature: "pr_watch", aliases: ["pr-watch"], summary: "Review, watch and comment on pull requests" },
  { name: "loops", group: "agents", aliases: ["loop"], summary: "Manage loops" },
  { name: "workflows", group: "agents", aliases: ["wf"], summary: "Manage workflows" },
  { name: "storage", group: "more", aliases: [], summary: "Inspect storage and cleanup" },
  { name: "acp", group: "setup", aliases: [], summary: "Configure ACP agents" },
  { name: "mcps", group: "setup", feature: "mcp", aliases: ["mcp"], summary: "Manage MCP servers" },
  { name: "tools", group: "setup", aliases: [], summary: "Manage custom tools" },
  { name: "packages", group: "setup", feature: "packages", aliases: ["pkg"], summary: "Manage packages" },
  { name: "footer", group: "look", aliases: [], summary: "Customize footer segments" },
  { name: "theme", group: "look", aliases: ["themes"], summary: "Pick a theme" },
  { name: "pet", group: "look", feature: "pets", aliases: [], summary: "Choose a pet" },
  { name: "mascot", group: "look", setting: "homeMascot", aliases: [], summary: "Choose the home mascot" },
  { name: "help", group: "more", aliases: ["?"], summary: "Show keys and commands" },
  { name: "quit", group: "session", aliases: ["exit", "q"], summary: "Quit" },
  { name: "prompt-mode", group: "context", setting: "promptContext", aliases: [], summary: "Choose prompt context" },
  { name: "prompt-chrome", group: "look", setting: "promptChrome", aliases: [], summary: "Choose prompt chrome" },
  { name: "presentation", group: "look", setting: "presentation", aliases: [], summary: "Choose transcript presentation" },
  { name: "message-rendering", group: "look", setting: "messageRenderer", aliases: [], summary: "Choose message rendering" },
  { name: "submit-scroll", group: "look", setting: "submitScroll", aliases: [], summary: "Choose scrolling after send" },
  { name: "timestamps", group: "look", setting: "timestamps", aliases: [], summary: "Toggle message timestamps" },
  { name: "thinking", group: "look", setting: "reasoning", aliases: [], summary: "Toggle reasoning visibility" },
  { name: "scrollbar", group: "look", setting: "scrollbar", aliases: [], summary: "Choose the transcript scrollbar" },
  { name: "jump-to-latest", group: "look", setting: "jumpHint", aliases: ["jump"], summary: "Choose the jump-to-latest button" },
  { name: "comments", group: "look", setting: "comments", aliases: [], summary: "Manage comments on an answer" },
  { name: "activity", group: "look", setting: "activityPlacement", aliases: [], summary: "Set where the activity status shows" },
  { name: "username", group: "look", setting: "username", aliases: [], summary: "Choose the conversation author" },
  { name: "terminal-title", group: "look", setting: "terminalTitle", aliases: [], summary: "Toggle window title" },
  { name: "tips", group: "look", setting: "homeTips", aliases: [], summary: "Toggle extension home tips" },
  { name: "sticky-prompt", group: "look", setting: "stickyPrompt", aliases: [], summary: "Toggle the pinned latest prompt" },
  { name: "find", group: "session", aliases: ["search"], summary: "Search the transcript" },
  { name: "raw", group: "look", setting: "presentation", aliases: [], summary: "Toggle plain, copy-friendly output" },
  { name: "messages", group: "session", aliases: [], summary: "Select a message to copy, revert or fork" },
  { name: "plan-review", group: "code", aliases: [], summary: "Review plans and saved decisions" },
  { name: "stats-project", group: "more", aliases: [], summary: "Inspect project usage" },
  { name: "compaction", group: "context", aliases: [], summary: "Review compacted memory and notes" },
  { name: "init", group: "code", aliases: [], summary: "Set up project instructions", custom: true },
  { name: "review", group: "code", aliases: [], summary: "Review changes in a subtask", custom: true },
  { name: "commit", group: "code", aliases: [], summary: "Commit changes, push or open a PR", custom: true },
  { name: "security-review", group: "code", aliases: [], summary: "Review security without edits", custom: true },
  { name: "bughunter", group: "code", aliases: [], summary: "Find bugs without edits", custom: true },
  { name: "ultraplan", group: "code", aliases: [], summary: "Plan and critique without edits", custom: true },
  { name: "wiki", group: "context", aliases: [], summary: "Manage the project wiki", custom: true },
  { name: "verify", group: "code", aliases: [], summary: "Build and test the project", custom: true },
  { name: "queue", group: "session", aliases: [], summary: "Manage queued prompts" },
  { name: "worktrees", group: "code", aliases: [], summary: "Manage worktrees and previews" },
  { name: "warp", group: "more", aliases: [], summary: "Choose a workspace" },
  { name: "compound", group: "agents", aliases: [], summary: "Run a bounded agent workflow" },
  { name: "marketplace", group: "setup", feature: "packages", aliases: [], summary: "Browse the package catalog" },
  { name: "mend-assets", group: "more", aliases: [], summary: "Inspect runtime assets" },
  { name: "intro", group: "look", aliases: [], summary: "Replay MendCode intro" },
  { name: "ai-config", group: "setup", aliases: [], summary: "Inspect, preview and save model recipes" },
  { name: "release-channel", group: "more", aliases: [], summary: "Manage updates and recovery" },
  { name: "tsm", group: "more", aliases: [], summary: "Configure terminal-session integration" },
  { name: "ide", group: "code", aliases: [], summary: "Connect editor context and files" },
  { name: "mflow", group: "more", aliases: [], summary: "Manage rooms, peers and file leases" },
  { name: "remote-control", group: "more", aliases: [], summary: "Pair and control a Telegram bridge" },
  { name: "org", group: "more", aliases: [], summary: "Switch Console organization" },
  { name: "console", group: "more", aliases: [], summary: "Manage Console accounts" },
  { name: "share", group: "more", aliases: [], summary: "Create and sync a session link" },
  { name: "unshare", group: "more", aliases: [], summary: "Remove the session link" },
]

/** Commands that need arguments after their name: selecting one inserts `/name ` instead of running it. */
const ARGUMENT_COMMANDS = new Set(["attach", "remember", "goal", "btw", "label", "cd"])
/** True when Enter or a click on a suggestion runs it at once. Tab only completes text. */
export function runsOnSelect(command: SlashCommand) {
  return command.custom !== true && command.ext !== true && !ARGUMENT_COMMANDS.has(command.name)
}

const OPTIONAL_ARGUMENTS = new Set(["limit", "daemon", "pr", "context-window", "rename", "view", "agent", "model", "permissions", "fork", "recap", "export", "import", "sandbox", "add-dir", "fast", "output-style", "experimental", "tier", "sidebar", "find", "stash", "copy", "diagram", "mcp", "mcps", "footer", "theme", "pet", "mascot", "prompt-chrome", "presentation", "message-rendering", "submit-scroll", "scrollbar", "jump-to-latest", "activity", "comments", "prompt-mode", "username", "queue", "compound", "release-channel", "tsm", "mflow", "remote-control", "vim", "multiline", "prompt-history", "backlog"])
export function takesArguments(command: SlashCommand) {
  return command.name === "panel" || !runsOnSelect(command) || OPTIONAL_ARGUMENTS.has(command.name)
}

function names(command: SlashCommand) {
  return [command.name, ...command.aliases]
}

/** Matches "/name" or "/alias" optionally followed by args. Leading space, "//" and unknown names are not commands. */
export function parseSlash(text: string): { command: SlashCommand; args: string } | undefined {
  if (!text.startsWith("/") || text.startsWith("//")) return undefined
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd())
  if (!match) return undefined
  const name = match[1]!.toLowerCase()
  const command = SLASH_COMMANDS.find((candidate) => names(candidate).includes(name))
  const args = (match[2] ?? "").trim()
  return command ? { command, args } : undefined
}

const BUILTIN_NAMES = new Set(SLASH_COMMANDS.map((command) => command.name))

/**
 * Whether the tier lists a built-in command in the menu, its search, `/help` and the palette (docs/tiers.md, "Slash commands").
 * Minimalist lists `MINIMALIST_SLASH` only; with no tier, or from balanced, everything is listed (a command whose feature is
 * off is still left out by the feature's own gate). A `slashCommands` entry with `hidden: false`, or `features.<id>: true` for
 * the command's feature, lists a command in minimalist too; `hidden: true` is the menu's own existing removal and is handled
 * there. Extension, MCP and project commands are the user's own and are always listed.
 */
export function tierListed(command: Pick<SlashCommand, "name" | "feature" | "ext" | "mcp">, settings: TierSettings, prefs: readonly SlashPreference[] = []) {
  if (command.ext || command.mcp || !BUILTIN_NAMES.has(command.name)) return true
  if (settings.tier !== "minimalist") return true
  if (slashTier(command.name) === "minimalist") return true
  if (prefs.find((entry) => entry.name === command.name)?.hidden === false) return true
  return command.feature !== undefined && settings.features?.[command.feature] === true
}

/** The whole catalog for the command editor: every command, those the tier does not list marked `tierHidden` so the editor can show and flip them. */
export const editableCatalog = (custom: SlashCommand[], settings: TierSettings): SlashCommand[] => slashCatalog(custom).map((command) => tierListed(command, settings) ? command : { ...command, tierHidden: true })

/** The built-in commands the tier lists, for `/help` and the palette. */
export const listedBuiltins = (settings: TierSettings, prefs: readonly SlashPreference[] = []) => SLASH_COMMANDS.filter((command) => tierListed(command, settings, prefs))

/** Commands whose handler already answers for the tier (`/sidebar right` is the right bar's panel: "presets need the balanced or full view"). */
const ANSWERS_FOR_ITSELF = new Set(["sidebar", "panel"])
/** True when Enter on the command's off-feature hint row still runs its own handler, which explains more than the hint. */
export const answersForItself = (name: string) => ANSWERS_FOR_ITSELF.has(name)

/**
 * The switch that brings back a command of a feature that is off, as its menu row shows it: `off · /tier balanced` when the tier
 * does not include it, `off · /experimental thread_tools on` when the feature's own flag turned it off, `off · /tier pr_watch on`
 * for an override or an opt-in feature. Undefined while the feature is on.
 */
export function gatedHint(feature: FeatureId, settings: TierSettings): string | undefined {
  const state = featureState(settings, feature)
  if (state.on) return undefined
  const spec = FEATURES[feature]
  if (state.why === "setting" && spec.flag) return `off · /experimental ${spec.flag} on`
  if (state.why === "tier" && !tierIncludes(settings.tier, spec.tier)) return `off · /tier ${spec.tier}`
  return `off · /tier ${feature} on`
}

/**
 * Commands of a feature that is off whose name or alias is exactly `query` (`pr-watch` finds `/pr`), each with its hint. A prefix
 * finds none of them, so typing another command is not cluttered with switched-off ones.
 */
export function gatedMatches(query: string, settings: TierSettings, custom: SlashCommand[] = []): Array<{ command: SlashCommand; hint: string }> {
  const word = query.toLowerCase()
  return slashCatalog(custom).flatMap((command) => {
    const hint = command.feature && names(command).includes(word) ? gatedHint(command.feature, settings) : undefined
    return hint ? [{ command, hint }] : []
  })
}

/**
 * What a typed command the tier does not list answers, in one line: `/review · balanced · /tier balanced`. Undefined when it is
 * listed, is no command, or already had its own tier behaviour: a command of a feature was hidden from the menu by the feature's
 * tier before this existed and its handler answers for itself (`/panel`), so that stays.
 */
export function slashRefusal(text: string, settings: TierSettings, prefs: readonly SlashPreference[] = []): string | undefined {
  const command = parseSlash(text)?.command
  if (!command || command.feature || ANSWERS_FOR_ITSELF.has(command.name) || tierListed(command, settings, prefs)) return undefined
  const needs: Tier = slashTier(command.name)
  return `/${command.name} · ${needs} · /tier ${needs}`
}

/**
 * Commands for a prompt like "/us", best first: with no query, alphabetical; otherwise the match of `slashMatch`
 * (name, alias, prefix, word start, initials, a run, one typo, summary words), the loose ones capped, limit 10.
 * `custom` are the project/user commands from .mendcode/commands.
 */
/**
 * The commands `text` matches, best match first. Among equal matches the ones used before come first, the most used ahead
 * (`/s` with `/sessions` in the recents puts it over `/settings`); an exact name or alias still wins over a used prefix.
 */
export function slashSuggestions(text: string, custom: SlashCommand[] = [], catalog?: SlashCommand[], recents: ReadonlyArray<{ name: string; count: number; last: number }> = []): SlashCommand[] {
  const typed = /^\/(\S+)\s+([\s\S]*)$/.exec(text)
  if (typed) {
    const command = (catalog ?? slashCatalog(custom)).find((candidate) => names(candidate).includes(typed[1]!.toLowerCase()))
    if (!command || command.custom || command.ext) return []
    return argumentMatches(command.name, typed[2]!).map((option) => ({ name: option.name, group: command.group, aliases: [], summary: option.summary, ...(option.feature ? { feature: option.feature } : {}), argument: { more: option.more === true } }))
  }
  if (!text.startsWith("/") || text.startsWith("//") || /\s/.test(text)) return []
  const query = text.slice(1).toLowerCase()
  const all = catalog ?? slashCatalog(custom)
  if (!query) return [...all].sort((a, b) => a.name.localeCompare(b.name))
  const matched: Array<{ command: SlashCommand; tier: number }> = []
  for (const command of all) {
    const match = slashMatch(query, command)
    if (match) matched.push({ command, tier: match.tier })
  }
  const used = new Map(recents.map((entry) => [entry.name, entry]))
  const byUse = (a: SlashCommand, b: SlashCommand) => {
    const x = used.get(a.name), y = used.get(b.name)
    return (y?.count ?? 0) - (x?.count ?? 0) || (y?.last ?? 0) - (x?.last ?? 0)
  }
  matched.sort((a, b) => a.tier - b.tier || byUse(a.command, b.command) || a.command.name.length - b.command.name.length || a.command.name.localeCompare(b.command.name))
  const taken = SLASH_TIER_CAPS.map(() => 0)
  // A typo is a guess for a query nothing else matched by name: `/sess` is a prefix, not a slip of `/mess`.
  const guessing = !matched.some(({ tier }) => tier < SLASH_TIERS.typo)
  return matched
    .filter(({ tier }) => {
      if (tier === SLASH_TIERS.typo && !guessing) return false
      const cap = SLASH_TIER_CAPS.findIndex((entry) => entry.tiers.includes(tier))
      return cap < 0 || ++taken[cap]! <= SLASH_TIER_CAPS[cap]!.max
    })
    .slice(0, catalog ? all.length : POPUP_ROWS)
    .map((entry) => entry.command)
}

/** Custom commands and skills whose `/name` a terminal built-in already owns: the built-in wins, so these never run from the prompt. */
export function slashCollisions(custom: ReadonlyArray<{ name: string; skill?: boolean | undefined; source?: string | undefined }>): string[] {
  return custom.filter((command) => command.source !== "builtin" && SLASH_COMMANDS.some((builtin) => names(builtin).includes(command.name))).map((command) => `${command.skill ? "skill" : "command"} ${command.name}${command.source ? ` (${command.source})` : ""} is overridden by the built-in /${command.name}`)
}

/** Aliases are not duplicate menu rows. */
export function slashCatalog(custom: SlashCommand[] = []): SlashCommand[] {
  return [...SLASH_COMMANDS, ...custom.filter((c) => !SLASH_COMMANDS.some((b) => names(b).includes(c.name)))]
}

/** Index of the first suggestion shown: the window follows the selection. The app passes `POPUP_ROWS`; the mention list still uses eight. */
export function suggestionWindowStart(count: number, selected: number, rows = 8) {
  return popupWindowStart(count, selected, rows)
}

/** v1's `/` popup: a `┃` box, the selected row filled, at most ten rows. */
export function renderSuggestions(suggestions: SlashCommand[], width: number, selected = 0, maxRows = POPUP_ROWS): Line[] {
  return renderPopup({ items: suggestions.map((command) => ({ label: `/${command.name}`, note: command.summary, ...(command.mcp ? { suffix: "MCP" } : command.custom ? { suffix: ":custom" } : command.ext ? { suffix: ":ext" } : {}) })), width, selected, maxRows }).rows
}

export const DIAGNOSTIC_COMMANDS: SlashCommand[] = [
  { name: "diagnostics", group: "more", aliases: ["diag"], summary: "Inspect TUI and daemon memory" },
  { name: "snapshot", group: "more", aliases: [], summary: "Save local heap snapshots" },
]
