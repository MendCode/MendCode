import { z } from "zod"
import { redactSecrets, type Settings } from "@mendcode/protocol"
import { defineTool, fail, truncateText } from "@mendcode/tools"
import { SECRET_KEY } from "./config-layers"
import { localOnlySettings } from "./remote-policy"

/** The question's title; the local variant names a key only a local terminal may set, and the daemon refuses its answer from anywhere else. */
export const SETTINGS_PROPOSAL = "Change MendCode settings?"
export const SETTINGS_PROPOSAL_LOCAL = "Change MendCode settings? (answer on this machine)"
export const SETTINGS_APPLY = "Apply"
export const SETTINGS_KEEP = "Don't apply"
const MAX_LINES = 24
const MAX_VALUE = 160
/** Records whose values are credentials or environment values: their names are shown, never their values. */
const VALUE_RECORDS = new Set(["env", "headers", "set"])
const HIDDEN = "[hidden]"

export const SettingsToolArgs = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("get"), keys: z.array(z.string().min(1).max(64)).max(40).optional() }),
  z.strictObject({
    action: z.literal("propose"),
    patch: z.record(z.string().min(1).max(64), z.unknown()).refine((patch) => Object.keys(patch).length > 0 && Object.keys(patch).length <= 40, "patch names 1 to 40 settings"),
    reason: z.string().trim().min(1).max(300),
  }),
])

/** Settings as a model or a card may see them: credential-like names and environment values hidden, secret-looking text masked. */
export function redactSettings(value: unknown, name = "", inValues = false): unknown {
  if (typeof value === "string") return inValues || SECRET_KEY.test(name) ? HIDDEN : redactSecrets(value).text
  if (Array.isArray(value)) return value.map((entry) => redactSettings(entry, name))
  if (value && typeof value === "object") {
    const values = VALUE_RECORDS.has(name)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, values && typeof entry !== "object" ? HIDDEN : redactSettings(entry, key, values && typeof entry === "object")]))
  }
  return value
}

const shown = (value: string | undefined) => value === undefined ? "unset" : value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value

/** Leaf path → JSON value; arrays and empty objects are one leaf. */
function leaves(value: unknown, prefix: string, into: Map<string, string>) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
    for (const [key, entry] of Object.entries(value)) leaves(entry, `${prefix}.${key}`, into)
  } else if (value !== undefined) into.set(prefix, JSON.stringify(value))
}

/** One `path: before → after` line per changed leaf of each patched key, both sides redacted; empty when nothing would change. */
export function settingsDiff(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): string[] {
  const lines: string[] = []
  for (const key of keys) {
    const was = new Map<string, string>()
    const will = new Map<string, string>()
    leaves(redactSettings(before[key], key), key, was)
    leaves(redactSettings(after[key], key), key, will)
    for (const path of new Set([...was.keys(), ...will.keys()])) if (was.get(path) !== will.get(path)) lines.push(`${path}: ${shown(was.get(path))} → ${shown(will.get(path))}`)
  }
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more changes`] : lines
}

const invalid = (error: unknown) => error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error)

/**
 * `mendcode_settings`: the model reads the daemon's settings and proposes a change; the user approves each change on a card that
 * shows it exactly (every permission mode, every tier), and only then is it saved, by the same write as `settings.set`.
 */
export function createSettingsTool(input: {
  settings(): Settings
  /** What the settings would be after `patch`, validated as `settings.set` validates it; throws when invalid. Writes nothing. */
  check(patch: Record<string, unknown>): Settings
  write(patch: Record<string, unknown>): Promise<Settings>
}) {
  return defineTool({
    name: "mendcode_settings",
    // The tool's own question is the approval: no permission mode, grant or rule answers it for the user.
    permission: "read",
    description: "MendCode's daemon settings (tier, defaultPermission, models and roles, compaction, budgets, outputStyle, experimental, features, providers, ...; keys and rows: `mendcode docs settings`). get: current saved settings, secrets hidden; keys narrows it. propose: patch is a settings.set patch: each top-level key's value replaces the whole value (get it first, then send the full object), null resets a key to its default; reason is one short line for the user. The patch is validated first; then the user sees each change as before → after and only their Apply saves it, in every permission mode. Propose only what the user asked for; never raise or remove a spend limit (budgets) unless the user asked for that exact change. Terminal look (theme, footer, prompt box) is customize_ui.",
    args: SettingsToolArgs,
    async execute(args, ctx) {
      const title = "MendCode settings"
      if (args.action === "get") {
        const current = input.settings() as Record<string, unknown>
        const picked = args.keys ? Object.fromEntries(args.keys.filter((key) => key in current).map((key) => [key, current[key]])) : current
        const output = truncateText({ text: JSON.stringify(redactSettings(picked), null, 1) })
        return { title, output: output.text || "{}", truncated: output.truncated, isError: false }
      }
      const { patch, reason } = args
      let after: Settings
      try { after = input.check(patch) } catch (error) { return fail({ title, message: `Not proposed: invalid settings. Nothing was asked or changed.\n${invalid(error).slice(0, 1500)}` }) }
      const before = input.settings() as Record<string, unknown>
      // `acpAgents` merges per agent and lives in its own file: the patch itself is what changes.
      const result: Record<string, unknown> = { ...after, ...("acpAgents" in patch ? { acpAgents: patch.acpAgents === null ? undefined : { ...(before.acpAgents as object | undefined), ...(patch.acpAgents as object) } } : {}) }
      const lines = settingsDiff(before, result, Object.keys(patch))
      if (!lines.length) return { title, output: "Already set: nothing would change, so nothing was asked.", truncated: false, isError: false }
      if (!ctx.ask) return fail({ title, message: `Not applied: no one here can approve a settings change (a headless run or a host without questions). Nothing changed. Give the user the change to make in /settings:\n${lines.join("\n")}` })
      const local = localOnlySettings(patch).length > 0
      const why = redactSecrets(reason.replace(/\s+/g, " ")).text
      const answer = await ctx.ask({
        title: local ? SETTINGS_PROPOSAL_LOCAL : SETTINGS_PROPOSAL,
        detail: `${lines.join("\n")}\n\nWhy: ${why}`,
        options: [{ label: SETTINGS_APPLY, description: "Save this change now; every terminal updates" }, { label: SETTINGS_KEEP, description: "Leave the settings as they are" }],
      })
      if (!answer.answered) return { title, output: `Not applied: ${answer.reason}. Nothing changed.`, truncated: false, isError: true }
      if (answer.text.trim() !== SETTINGS_APPLY) {
        const said = answer.text.trim() === SETTINGS_KEEP ? "the user chose not to apply it" : `the user answered instead: ${answer.text.trim().slice(0, 500)}`
        return { title, output: `Not applied: ${said}. Nothing changed; do not propose it again unless the user asks.`, truncated: false, isError: false }
      }
      if (ctx.signal.aborted) return fail({ title, message: "Not applied: the turn was cancelled. Nothing changed." })
      try { await input.write(patch) } catch (error) { return fail({ title, message: `Not applied: ${invalid(error).slice(0, 1500)}. Nothing changed.` }) }
      return { title, output: `Applied; every terminal has the new settings.\n${lines.join("\n")}`, truncated: false, isError: false }
    },
  })
}
