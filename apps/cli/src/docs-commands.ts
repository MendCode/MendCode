import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { SLASH_GROUPS, TIERS, featureOn, isTier, slashProfileProblems, slashTier, type SlashPreference, type Tier, type TierSettings } from "@mendcode/protocol/wire"
import { SLASH_COMMANDS, parseSlash, takesArguments, tierListed, type SlashCommand } from "./view/commands"
import { removedAliasHint, userAliasProblems } from "./view/slash-aliases"
import { readTuiProfile } from "./view/tui-profile"

/**
 * The live part of the `commands` card: the built-in commands THIS install offers (its tier, its feature switches), grouped as the
 * menu groups them, what the user's profile changed, their own commands and what the next tier adds. Reads files and the daemon's
 * settings that the caller passes in; nothing here writes or starts a process.
 */
export type CommandsContext = { dataDir: string; cwd: string; settings: Record<string, unknown> | undefined; detail?: string | undefined }

/** Summaries are listed with the names while the whole list stays under this many characters; past it the names go alone and one command's detail is a lookup away. */
export const SUMMARY_BUDGET = 2_000

/** The profile's list is repeated verbatim (the model sends the whole list back) while it stays this short. */
const JSON_BUDGET = 1_500
/** Names the next tier would add, listed up to here (balanced adds over a hundred to minimalist). */
const ADDS_SHOWN = 60

const GROUPS = SLASH_GROUPS.filter((group) => group !== "recent")

function tierSettings(settings: Record<string, unknown> | undefined): TierSettings {
  if (!settings) return {}
  const features = settings.features && typeof settings.features === "object" && !Array.isArray(settings.features) ? settings.features as TierSettings["features"] : undefined
  return { ...(isTier(settings.tier) ? { tier: settings.tier } : {}), ...(features ? { features } : {}) }
}

/** What the menu offers: the tier lists it and its feature, if it has one, is on. Setting rows are offered too, by search only. */
const offered = (settings: TierSettings, prefs: readonly SlashPreference[]) => SLASH_COMMANDS.filter((command) => (!command.feature || featureOn(settings, command.feature)) && tierListed(command, settings, prefs))

const label = (command: SlashCommand) => command.aliases.length ? `${command.name}=${command.aliases.join("=")}` : command.name

/** The profile's `slashCommands` as the terminal reads them, and the problem when the file holds a list the terminal would drop. */
function profileOf(dataDir: string): { prefs: SlashPreference[]; file: string; exists: boolean; problem: string | undefined } {
  const file = path.join(dataDir, "tui", "profile.json")
  const exists = existsSync(file) && statSync(file).isFile()
  let problem: string | undefined
  if (exists) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
      if (raw && typeof raw === "object" && "slashCommands" in raw) problem = slashProfileProblems("slashCommands", raw.slashCommands)[0]
    } catch { problem = "profile.json is not valid JSON" }
  }
  return { prefs: readTuiProfile(dataDir).slashCommands, file, exists, problem }
}

/** The names of the user's own commands in one place: the `commands` folder (a subfolder is `folder:name`) and the `command` map of a mendcode.json. */
function commandNames(folder: string, config: string): string[] {
  const names = new Set<string>()
  const walk = (directory: string, prefix: string, depth: number) => {
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue
        if (entry.isDirectory()) { if (depth < 3) walk(path.join(directory, entry.name), `${prefix}${entry.name}:`, depth + 1) }
        else if (/\.(?:md|json)$/.test(entry.name)) names.add(prefix + entry.name.replace(/\.(?:md|json)$/, ""))
      }
    } catch { /* no folder: none */ }
  }
  walk(folder, "", 0)
  try {
    const map = (JSON.parse(readFileSync(config, "utf8")) as { command?: Record<string, unknown> }).command
    if (map && typeof map === "object" && !Array.isArray(map)) for (const name of Object.keys(map)) names.add(name)
  } catch { /* no mendcode.json, or not valid: none */ }
  return [...names].sort()
}

/** Where the user's commands live and what they are called: the data dir's, then the project's when it is another folder. */
function ownCommands(context: Pick<CommandsContext, "dataDir" | "cwd">) {
  const user = { where: path.join(context.dataDir, "commands"), names: commandNames(path.join(context.dataDir, "commands"), path.join(context.dataDir, "mendcode.json")) }
  const same = path.resolve(context.cwd) === path.resolve(context.dataDir)
  const project = same ? undefined : { where: path.join(context.cwd, ".mendcode", "commands"), names: commandNames(path.join(context.cwd, ".mendcode", "commands"), path.join(context.cwd, "mendcode.json")) }
  return { places: [user, ...(project ? [project] : [])], names: [...user.names, ...(project?.names ?? [])] }
}

/** The commands of one group in the order the menu shows them: pinned, then `order`, then name. */
function inOrder(commands: SlashCommand[], prefs: readonly SlashPreference[]) {
  const pref = (command: SlashCommand) => prefs.find((entry) => entry.name === command.name)
  return [...commands].sort((a, b) => Number(!!pref(b)?.pinned) - Number(!!pref(a)?.pinned) || (pref(a)?.order ?? 10_000) - (pref(b)?.order ?? 10_000) || a.name.localeCompare(b.name))
}

function groupLines(commands: SlashCommand[], prefs: readonly SlashPreference[]): string[] {
  const placed = commands.filter((command) => !command.setting).map((command) => ({ command, group: prefs.find((entry) => entry.name === command.name)?.group ?? command.group }))
  const state = (command: SlashCommand) => {
    const pref = prefs.find((entry) => entry.name === command.name)
    return `${pref?.pinned ? " (pinned)" : ""}${pref?.hidden === true ? " (hidden)" : ""}`
  }
  const lines = (withSummary: boolean) => GROUPS.map((group) => `${group}: ${inOrder(placed.filter((entry) => entry.group === group).map((entry) => entry.command), prefs).map((command) => withSummary ? `/${label(command)}${state(command)} ${command.summary}` : `${label(command)}${state(command)}`).join(withSummary ? "; " : ", ") || "none"}`)
  const long = lines(true)
  return long.join("\n").length <= SUMMARY_BUDGET ? long : lines(false)
}

/** One command, for `docs commands <name>`: its summary, group, alias, tier and feature, and what the profile says about it. */
function detailLines(word: string, settings: TierSettings, prefs: readonly SlashPreference[]): string[] {
  const name = word.replace(/^\//, "").toLowerCase()
  const command = parseSlash(`/${name}`)?.command ?? SLASH_COMMANDS.find((entry) => prefs.find((pref) => pref.name === entry.name)?.aliases?.includes(name))
  if (!command) return [removedAliasHint(`/${name}`) ?? `no built-in command or alias named ${name}: a command of yours is a file in the commands folders (docs commands lists them)`]
  const pref = prefs.find((entry) => entry.name === command.name)
  const here = offered(settings, prefs).some((entry) => entry.name === command.name)
  const own = pref?.aliases?.length ? ` · your aliases ${pref.aliases.map((alias) => `/${alias}`).join(", ")}` : ""
  return [
    `/${command.name}${command.aliases.length ? ` (alias ${command.aliases.map((alias) => `/${alias}`).join(", ")})` : ""}: ${command.summary}${takesArguments(command) ? " · takes arguments" : ""}${own}`,
    `group ${pref?.group ?? command.group}${pref?.group ? ` (yours; built-in: ${command.group})` : ""} · ${command.setting ? `a setting row: found by typing, opens /settings ${command.setting}` : `listed from ${slashTier(command.name)}`}${command.feature ? ` · needs the ${command.feature} feature (${featureOn(settings, command.feature) ? "on" : "off"})` : ""} · ${here ? "offered here" : "not offered here"}`,
    `your profile entry: ${pref ? JSON.stringify(pref) : "none"}`,
  ]
}

export function commandsLines(context: CommandsContext): string[] {
  const settings = tierSettings(context.settings)
  const profile = profileOf(context.dataDir)
  if (context.detail) return detailLines(context.detail, settings, profile.prefs)
  const mine = offered(settings, profile.prefs)
  const next: Tier | undefined = settings.tier ? TIERS[TIERS.indexOf(settings.tier) + 1] : undefined
  const names = new Set(mine.map((command) => command.name))
  const more = next ? offered({ ...settings, tier: next }, profile.prefs).filter((command) => !names.has(command.name)) : []
  const hidden = profile.prefs.filter((entry) => entry.hidden === true).map((entry) => entry.name)
  const pinned = profile.prefs.filter((entry) => entry.pinned).map((entry) => entry.name)
  const moved = profile.prefs.filter((entry) => entry.group).map((entry) => `${entry.name}->${entry.group}`)
  const aliases = profile.prefs.flatMap((entry) => (entry.aliases ?? []).map((alias) => `${alias}->${entry.name}`))
  const rows = mine.filter((command) => command.setting)
  const own = ownCommands(context)
  const json = JSON.stringify(profile.prefs)
  const tier =context.settings ? (settings.tier ? `${settings.tier} (/tier changes it)` : "none set (every built-in whose feature is on is offered)") : "not known (no daemon is running: shown as if none were set)"
  const yours = [hidden.length ? `hidden: ${hidden.join(", ")}` : "", pinned.length ? `pinned: ${pinned.join(", ")}` : "", moved.length ? `moved: ${moved.join(", ")}` : "", aliases.length ? `aliases: ${aliases.join(", ")}` : ""].filter(Boolean)
  return [
    `tier: ${tier} · ${mine.length - rows.length} commands in the menu, grouped as the menu groups them (name=alias)`,
    ...groupLines(mine, profile.prefs),
    ...(rows.length ? [`setting rows, found by typing, each opens its setting: ${rows.map(label).join(", ")}`] : []),
    `your profile, ${profile.file}${profile.exists ? "" : " (not written yet)"}: ${yours.join(" · ") || "nothing changed in the commands"}`,
    `slashCommands now: ${json.length <= JSON_BUDGET ? json : `${profile.prefs.length} entries, too long to repeat here: read the file`}`,
    ...(profile.problem ? [`problem: slashCommands in that file is ignored (${profile.problem})`] : []),
    ...userAliasProblems(profile.prefs, own.names.map((name) => ({ name }))).map((problem) => `problem: ${problem}`),
    ...own.places.map((place) => `your commands, ${place.where}: ${place.names.join(", ") || "none"}`),
    next ? `the next tier (${next}) would add ${more.length}: ${more.slice(0, ADDS_SHOWN).map((command) => command.name).join(", ") || "nothing"}${more.length > ADDS_SHOWN ? `, and ${more.length - ADDS_SHOWN} more` : ""}` : settings.tier ? `${settings.tier} is the highest tier` : "no tier is set, so there is no next one",
    "one command in detail: {{program}} docs commands <name>",
  ]
}
