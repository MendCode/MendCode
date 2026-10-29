import { featureOn, SLASH_GROUPS, type TierSettings } from "@mendcode/protocol/wire"
import type { SlashMenuContext, SlashMenuItem } from "@mendcode/extension-api"
import type { Line, Span } from "../ui/theme"
import type { TuiProfile } from "./tui-profile"
import { gatedMatches, slashCatalog, slashSuggestions, tierListed, type SlashCommand } from "./commands"
import { userAliases } from "./slash-aliases"
import { slashMatch } from "./slash-match"
import type { SlashRecent } from "./slash-recents"
import { clip, fit } from "./deck"
import { lineWidth, onColor } from "./panel-box"
import { popupWindowStart, POPUP_ROWS } from "./popup"
import { textWidth, truncateEnd } from "./wrap"
import { fuzzyScore } from "./fuzzy"
import { DEFAULT_BINDINGS, hintKey, keyName, type Bindings } from "../ui/keymap"
import { keyText } from "../ui/key-labels"

const commandActions: Record<string, string> = {
  undo: "message.undo", redo: "message.redo", timeline: "session.timeline", history: "session.history",
  variants: "variant.list", extensions: "extensions.open", export: "session.export", sidebar: "sidebar.toggle",
  panel: "panel.toggle", diagram: "diagram.open", messages: "messages.open", voice: "voice.toggle",
  editor: "editor.open", copy: "message.copy", scratch: "scratch.edit", find: "transcript.find",
  "prompt-history": "history.search", shortcuts: "shortcuts.toggle", backtrack: "backtrack.open",
  agent: "agent.picker", stash: "stash.list", drafts: "drafts.restore", scrollbar: "scrollbar.toggle",
  username: "username.toggle", "terminal-title": "terminal-title.toggle", tips: "tips.toggle",
  thinking: "thinking.toggle", "sticky-prompt": "sticky-prompt.toggle",
}

function commandShortcut(command: SlashCommand, bindings: Bindings): string | undefined {
  const actions = new Set([command.name, commandActions[command.name], ...[command.name, ...command.aliases].map((name) => `command:${name}`)])
  for (const [seq, bound] of bindings.direct) if ("action" in bound && actions.has(bound.action) && keyName(seq)) return hintKey(bindings, bound.action, keyName(seq))
  for (const [key, bound] of bindings.leader) if ("action" in bound && actions.has(bound.action)) return `${keyName(bindings.leaderKey) ?? bindings.leaderKey} ${keyName(key) ?? key}`
  for (const [seq, action] of bindings.inline) if (!bindings.direct.has(seq) && actions.has(action)) return keyName(seq)
  return undefined
}

export type SlashMenuState = { group: number; expanded: string[] }
export const createSlashMenuState = (): SlashMenuState => ({ group: 0, expanded: [] })
/** `gated` marks the one row of a command typed exactly while its feature is off: the row says how to turn it on and never runs. */
export type MenuModel = SlashMenuContext & { catalog: SlashCommand[]; items: Array<SlashMenuItem & { command?: SlashCommand; gated?: string }> }

export function menuCatalog(custom: SlashCommand[], profile: TuiProfile, settings: TierSettings): SlashCommand[] {
  const mine = userAliases(profile.slashCommands, custom)
  return slashCatalog(custom).filter((command) => (!command.feature || featureOn(settings, command.feature)) && (!command.mcp || featureOn(settings, "mcp")) && tierListed(command, settings, profile.slashCommands)).map((command) => {
    const pref = profile.slashCommands.find((entry) => entry.name === command.name)
    const aliases = [...mine].filter(([, target]) => target === command.name).map(([alias]) => alias)
    return { ...command, group: pref?.group ?? command.group, ...(aliases.length ? { aliases: [...command.aliases, ...aliases] } : {}) }
  })
}

export function slashMenuModel(input: { text: string; custom: SlashCommand[]; profile: TuiProfile; settings: TierSettings; recents: readonly SlashRecent[]; state: SlashMenuState; selected: number; width: number; height: number; ascii: boolean; bindings?: Bindings }): MenuModel | undefined {
  const argumentWords = /^\/[^\s/]+\s/.test(input.text)
  if (!/^\/[^\s/]*$/.test(input.text) && !argumentWords) return undefined
  const { profile, state } = input
  const catalog = menuCatalog(input.custom, profile, input.settings).map((command) => {
    const shortcut = commandShortcut(command, input.bindings ?? DEFAULT_BINDINGS)
    return { ...command, ...(shortcut ? { shortcut: keyText(shortcut) } : {}) }
  })
  const query = input.text.slice(1)
  const groups = SLASH_GROUPS.map((id) => ({ id, label: profile.slashGroups.find((group) => group.id === id)?.label ?? id }))
  const group = groups[state.group % groups.length]!.id
  const layout = profile.slashMenu === "columns" && input.width < 90 ? "groups" : profile.slashMenu
  const visible = catalog.filter((command) => !command.setting && !profile.slashCommands.find((entry) => entry.name === command.name)?.hidden)
  const ordered = (commands: SlashCommand[]) => commands.sort((a, b) => {
    const x = profile.slashCommands.find((entry) => entry.name === a.name)
    const y = profile.slashCommands.find((entry) => entry.name === b.name)
    return Number(!!y?.pinned) - Number(!!x?.pinned) || (x?.order ?? 10000) - (y?.order ?? 10000) || a.name.localeCompare(b.name)
  })
  // Pins, last-used, then frequency; seed an unused data dir with useful essentials.
  const recentNames = [...profile.slashCommands.filter((entry) => entry.pinned).sort((a, b) => (a.order ?? 10000) - (b.order ?? 10000)).map((entry) => entry.name), ...[...input.recents].sort((a, b) => b.last - a.last).slice(0, 4).map((entry) => entry.name), ...[...input.recents].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 8).map((entry) => entry.name), "new", "sessions", "model", "changes", "context", "settings"]
  const recent = [...new Set(recentNames)].flatMap((name) => { const command = visible.find((entry) => entry.name === name); return command ? [command] : [] }).slice(0, 12)
  const suggested = !input.recents.length && !profile.slashCommands.some((entry) => entry.pinned && visible.some((command) => command.name === entry.name))
  const commandsFor = (id: string) => id === "recent" ? recent : ordered(visible.filter((command) => command.group === id))
  const commandItem = (command: SlashCommand): MenuModel["items"][number] => ({ kind: "command", label: `/${command.name}`, group: command.group, command })
  let items: MenuModel["items"]
  if (argumentWords) {
    items = slashSuggestions(input.text, input.custom, catalog, input.recents).filter((command) => !command.feature || featureOn(input.settings, command.feature)).map(commandItem)
    if (!items.length) return undefined
  }
  else if (query) items = [...slashSuggestions(input.text, input.custom, catalog, input.recents).map(commandItem), ...gatedMatches(query, input.settings, input.custom).map(({ command, hint }) => ({ ...commandItem({ ...command, summary: hint }), gated: hint }))]
  else if (layout === "flat") items = ordered(visible).map(commandItem)
  else if (layout === "groups") items = [...recent.map(commandItem), ...groups.filter((entry) => entry.id !== "recent").flatMap((entry): MenuModel["items"] => {
    const commands = commandsFor(entry.id)
    const expanded = state.expanded.includes(entry.id)
    return [{ kind: "group", label: entry.label, group: entry.id, count: commands.length, expanded, preview: commands.slice(0, 3).map((command) => command.name).join(", ") }, ...(expanded ? commands.map((command) => ({ ...commandItem(command), indented: true })) : [])]
  })]
  else items = commandsFor(group).map(commandItem)
  return { catalog, query, selection: Math.max(0, Math.min(input.selected, Math.max(0, items.length - 1))), group, groups: groups.map((entry) => ({ ...entry, count: commandsFor(entry.id).length })), suggested, items, layout, width: input.width, height: input.height, ascii: input.ascii }
}

/** Wrap whole tabs; on short screens scroll the header to the active tab's row. */
function tabRows(ctx: SlashMenuContext): Line[] {
  const width = Math.max(1, ctx.width - 4)
  const rows: Line[] = [[]]
  for (const group of ctx.groups) {
    const active = group.id === ctx.group
    const count = ` ${group.count ?? ctx.catalog.filter((command) => !command.setting && command.group === group.id).length}`
    const name = group.id === "recent" && ctx.suggested ? "suggested" : group.label
    const clipped = truncateEnd(ctx.ascii ? name.replace(/[^\x20-\x7e]/g, ".") : name, Math.max(1, width - textWidth(count) - (active ? 2 : 0)))
    const label = ctx.ascii ? clipped.replace(/…/g, ".") : clipped
    const tab: Line = [{ text: active ? `[${label}]` : label, fg: active ? "primary" : "muted", bold: active }, { text: count, fg: "muted", dim: true }]
    let row = rows.at(-1)!
    if (row.length && lineWidth(row) + 2 + lineWidth(tab) > width) { row = []; rows.push(row) }
    if (row.length) row.push({ text: "  " })
    row.push(...tab)
  }
  const capacity = Math.max(0, ctx.height - 2)
  const activeRow = rows.findIndex((row) => row.some((span) => span.bold))
  return rows.slice(Math.max(0, activeRow - capacity + 1), Math.max(0, activeRow - capacity + 1) + capacity)
}

/** Shared geometry for keyboard selection, built-in views and mouse hit testing. */
export function slashMenuWindow(ctx: SlashMenuContext) {
  const header = ctx.query ? 0 : ctx.layout === "tabs" ? tabRows(ctx).length : ctx.layout === "groups" ? Math.min(1, Math.max(0, ctx.height - 2)) : 0
  const rows = Math.max(1, Math.min(POPUP_ROWS, ctx.height - header - 1))
  return { header, rows, first: popupWindowStart(ctx.items.length, ctx.selection, rows) }
}

function matched(text: string, query: string, fg: NonNullable<Span["fg"]>): Line {
  if (!query || fuzzyScore(query, text) === undefined) return [{ text, fg }]
  let index = 0
  return [...text].map((char): Span => {
    const hit = index < query.length && char.toLowerCase() === query[index]?.toLowerCase()
    if (hit) index++
    return { text: char, fg: hit ? "primary" : fg, ...(hit ? { bold: true, underline: true } : {}) }
  })
}

/** All built-in layouts implement the extension's slashMenu view contract. */
export function renderSlashMenu(ctx: SlashMenuContext): Line[] {
  if (ctx.height <= 0 || ctx.width <= 0) return []
  const { header, rows, first } = slashMenuWindow(ctx)
  const width = Math.max(1, ctx.width - 4)
  const columns = !ctx.query && ctx.layout === "columns"
  const leftWidth = columns ? Math.min(24, Math.max(14, ...ctx.groups.map((group) => textWidth(group.label) + 3))) : 0
  const bodyWidth = width - leftWidth
  // Argument rows carry the command's name before the word (`/experimental async_tools`), so their column may be wider.
  const argumentRows = ctx.items.some((item) => (item.command as { argument?: unknown } | undefined)?.argument)
  const labelWidth = Math.min(argumentRows ? 40 : 24, Math.floor(bodyWidth * (argumentRows ? 0.5 : 0.38)), Math.max(8, ...ctx.items.map((item) => textWidth(item.label) + (item.kind === "group" || item.indented ? 4 : 2))))
  const rail = ctx.ascii ? "|" : "┃"
  const cut = (text: string, room: number) => {
    const clipped = truncateEnd(ctx.ascii ? text.replace(/[^\x20-\x7e]/g, ".") : text, Math.max(0, room))
    return ctx.ascii ? clipped.replace(/…/g, ".") : clipped
  }
  const wrapRow = (line: Line): Line => fit([{ text: "  " }, ...fit(line, width), { text: "  " }], ctx.width)
  const body = ctx.items.slice(first, first + rows).map((item, offset): Line => {
    const on = first + offset === ctx.selection
    const setting = item.command?.setting
    const groupName = ctx.groups.find((group) => group.id === item.group)?.label ?? item.group
    const source = item.command?.mcp ? "MCP" : item.command?.ext ? ":ext" : item.command?.custom ? ":custom" : ""
    const right = setting ? `${groupName} / setting` : ctx.query ? `${groupName}${source ? " " + source : ""}` : source
    const suffixRoom = Math.max(0, bodyWidth - labelWidth - 5)
    const shortcut = cut(item.command?.shortcut ?? "", suffixRoom)
    const metadata = cut(right, Math.max(0, Math.min(24, suffixRoom - textWidth(shortcut) - (shortcut ? 3 : 0))))
    const suffix = [metadata, shortcut].filter(Boolean).join(ctx.ascii ? " / " : " · ")
    const label = cut(`${item.kind === "group" ? ctx.ascii ? item.expanded ? "v " : "> " : item.expanded ? "▾ " : "▸ " : item.indented ? "  " : ""}${item.label}`, Math.max(1, labelWidth - 2))
    const gated = "gated" in item && typeof item.gated === "string"
    const alias = ctx.query && item.command && !gated ? slashMatch(ctx.query.toLowerCase(), item.command)?.via : undefined
    const note = item.kind === "group" ? `${item.count}  ${item.preview ?? ""}` : `${alias ? alias + " / " : ""}${item.command?.summary ?? ""}`
    const spans: Line = [{ text: `${rail} `, fg: "border" }, ...matched(label, ctx.query, setting || gated ? "muted" : "text"), { text: " ".repeat(Math.max(1, labelWidth - textWidth(label))) }, ...matched(cut(note, Math.max(0, bodyWidth - labelWidth - textWidth(suffix) - 4)), ctx.query, "muted")]
    if (suffix) spans.push({ text: " ".repeat(Math.max(1, bodyWidth - lineWidth(spans) - textWidth(suffix) - 1)) + suffix + " ", fg: "muted", dim: true })
    const fitted = fit(spans, bodyWidth).map((span): Span => ({ ...span, bg: "element", ...(on ? { ...onColor("primary"), bold: true, ...(setting ? { dim: true } : {}), ...(span.fg === "muted" ? { dim: true } : {}) } : {}) }))
    // Group metadata remains muted even on a selected search row.
    if (ctx.query && right) fitted[fitted.length - 1] = { ...fitted[fitted.length - 1]!, dim: true }
    return fitted
  })
  if (!body.length) body.push(fit([{ text: `${rail} No commands`, fg: "muted", bg: "element" }], bodyWidth))
  const result: Line[] = []
  if (header && ctx.layout === "tabs") result.push(...tabRows(ctx))
  else if (header) result.push([{ text: ctx.suggested ? "suggested" : "recent", fg: "primary" }, { text: " / groups", fg: "muted" }])
  if (columns) {
    for (let y = 0; y < Math.max(ctx.groups.length, body.length); y++) {
      const group = ctx.groups[y]
      result.push([...fit(group ? [{ text: ` ${cut(group.id === "recent" && ctx.suggested ? "suggested" : group.label, leftWidth - 1)}`, fg: group.id === ctx.group ? "primary" : "muted", bold: group.id === ctx.group }] : [], leftWidth), ...(body[y] ?? fit([], bodyWidth))])
    }
  } else result.push(...body)
  const total = ctx.items.length
  const counter = total ? `${first + 1}${ctx.ascii ? "-" : "–"}${Math.min(total, first + rows)} of ${total}` : "0 of 0"
  const hints = ctx.query || ctx.layout === "flat" ? ctx.ascii ? "up/down move | enter run" : "↑↓ move · enter run" : ctx.layout === "groups" ? ctx.ascii ? "up/down | right open | enter" : "↑↓ move · → open · enter run" : ctx.ascii ? "left/right group | up/down | tab complete | enter" : "←→ group · ↑↓ move · tab complete · enter run"
  const rule = ctx.ascii ? "-" : "─"
  const footer = clip([{ text: `${rule} ${counter} ${rule} `, fg: "border" }, { text: hints, fg: "muted" }], width)
  return [...result.slice(0, Math.max(0, ctx.height - 1)), footer].map(wrapRow)
}
