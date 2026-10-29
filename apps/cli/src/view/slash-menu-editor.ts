import { SLASH_GROUPS, type SlashGroupId, type SlashPreference } from "@mendcode/protocol/wire"
import { SLASH_COMMANDS, type SlashCommand } from "./commands"
import type { TuiProfile } from "./tui-profile"
import type { Line } from "../ui/theme"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { fit } from "./deck"

export type SlashEditorState = { selected: number; rename?: string }
/** A command is hidden when the user said so (`hidden`), else when the tier does not list it. */
const hiddenNow = (command: SlashCommand, pref: SlashPreference | undefined) => pref?.hidden ?? command.tierHidden === true
function ordered(profile: TuiProfile, commands: readonly SlashCommand[]) {
  return [...commands].sort((a, b) => (profile.slashCommands.find((entry) => entry.name === a.name)?.order ?? 10000) - (profile.slashCommands.find((entry) => entry.name === b.name)?.order ?? 10000) || a.name.localeCompare(b.name))
}
export function slashEditorKey(state: SlashEditorState, key: string, profile: TuiProfile, commands: readonly SlashCommand[] = SLASH_COMMANDS): { state: SlashEditorState; patch?: Partial<TuiProfile>; close?: boolean } {
  const list = ordered(profile, commands)
  const command = list[Math.min(state.selected, list.length - 1)]
  if (!command) return { state, close: true }
  const pref = profile.slashCommands.find((entry) => entry.name === command.name) ?? { name: command.name }
  const group = pref.group ?? command.group
  if (state.rename !== undefined) {
    if (key === "\x1b") return { state: { selected: state.selected } }
    if (key === "\x7f") return { state: { ...state, rename: state.rename.slice(0, -1) } }
    if (key === "\r") return state.rename.trim() ? { state: { selected: state.selected }, patch: { slashGroups: [...profile.slashGroups.filter((entry) => entry.id !== group), { id: group, label: state.rename.trim() }] } } : { state }
    return { state: /^[^\x00-\x1f\x7f-\x9f]+$/u.test(key) ? { ...state, rename: (state.rename + key).slice(0, 24) } : state }
  }
  if (key === "\x1b") return { state, close: true }
  if (["\x1b[A", "\x1b[B"].includes(key)) return { state: { selected: Math.max(0, Math.min(list.length - 1, state.selected + (key === "\x1b[A" ? -1 : 1))) } }
  if (key === "r") return { state: { ...state, rename: profile.slashGroups.find((entry) => entry.id === group)?.label ?? group } }
  if (["K", "J", "\x1b[1;2A", "\x1b[1;2B"].includes(key)) {
    const target = Math.max(0, Math.min(list.length - 1, state.selected + (key === "K" || key.endsWith("A") ? -1 : 1)))
    const next = [...list]
    const moved = next[state.selected]!
    next[state.selected] = next[target]!
    next[target] = moved
    const prefs: SlashPreference[] = next.map((command, order) => ({ ...profile.slashCommands.find((entry) => entry.name === command.name), name: command.name, order }))
    return { state: { selected: target }, patch: { slashCommands: [...profile.slashCommands.filter((entry) => !next.some((command) => command.name === entry.name)), ...prefs] } }
  }
  let patch: SlashPreference | undefined
  if (key === "h") {
    // `hidden` is written only when it differs from what the tier lists, so a command flipped back follows the tier again.
    const { hidden: _kept, ...rest } = pref
    const next = !hiddenNow(command, pref)
    patch = next === (command.tierHidden === true) ? rest : { ...rest, hidden: next }
  }
  if (key === "p") patch = { ...pref, pinned: !pref.pinned }
  if (key === "\x1b[C" || key === "\x1b[D") {
    const groups = SLASH_GROUPS.filter((group) => group !== "recent")
    patch = { ...pref, group: groups[(groups.indexOf(group as Exclude<SlashGroupId, "recent">) + (key === "\x1b[C" ? 1 : groups.length - 1)) % groups.length]! }
  }
  return { state, ...(patch ? { patch: { slashCommands: [...profile.slashCommands.filter((entry) => entry.name !== command.name), patch] } } : {}) }
}
export function renderSlashEditor(input: { state: SlashEditorState; profile: TuiProfile; commands?: readonly SlashCommand[]; width: number; height: number }): Line[] {
  const list = ordered(input.profile, input.commands ?? SLASH_COMMANDS)
  const body: Line[] = list.map((command, index) => {
    const pref = input.profile.slashCommands.find((entry) => entry.name === command.name)
    const group = pref?.group ?? command.group
    const label = input.profile.slashGroups.find((entry) => entry.id === group)?.label ?? group
    return fit([{ text: index === input.state.selected ? "> " : "  ", fg: "primary" }, { text: `/${command.name.padEnd(22)} `, fg: index === input.state.selected ? "primary" : "text" }, { text: `${label}  ${command.setting ? "setting" : hiddenNow(command, pref) ? pref?.hidden === undefined ? "hidden by tier" : "hidden" : "shown"}${pref?.pinned ? " / pinned" : ""}`, fg: "muted" }], input.width - 4)
  })
  if (input.state.rename !== undefined) body.splice(input.state.selected + 1, 0, [{ text: `Group name: ${input.state.rename}_`, fg: "primary" }])
  const hints: Line[] = input.state.rename !== undefined
    ? [[{ text: "type name / enter save / esc cancel", fg: "muted" }]]
    : [[{ text: "left/right group / h hide / p pin / r rename", fg: "muted" }], [{ text: "up/down select / J K order / esc back", fg: "muted" }]]
  return appearancePage({ title: "Customize commands", hints: "esc back", body: [...focusedWindow(body, input.state.selected + Number(input.state.rename !== undefined), Math.max(1, input.height - hints.length - 2)), ...hints], width: input.width, height: input.height })
}
