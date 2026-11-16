import type { BotInfo } from "@mendcode/protocol"
import { BOT_COLORS, BOT_SHAPES, type BotColor, type BotShape } from "../../../../packages/packages/src/agents"
import type { Line, Span } from "../ui/theme"
import { botFace, CARD_COLS } from "./bot-face"
import { faceLook } from "./bot-look"
import { clip, panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"

/**
 * The form of experimental bots (docs/agents.md): `/bot new`, the bot page's Edit and `/bot edit` open it, `/bot delete` and the page's
 * Delete open its confirmation. The same shape as the loops form (`loop-form.ts`): pure state, one raw key in, the next state and what the
 * app should do out, and a render of exactly the rows asked for. Loaded by the first of those, never at start.
 */

export const BOT_PERMISSIONS = ["plan", "ask", "smart", "edits", "full"] as const
export type BotPermission = (typeof BOT_PERMISSIONS)[number]
export const BOT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RESERVED = ["build", "plan"]
export const MAX_PROMPT = 16_000
const MAX_AVATAR_PATH = 4_096

export type BotFormRow = "name" | "color" | "shape" | "face" | "avatar" | "prompt" | "editor" | "model" | "permission" | "buttons"

export type BotFormState = {
  mode: "create" | "edit"
  name: string
  color: BotColor | "auto"
  shape: BotShape | "auto"
  face: "generated" | "image"
  avatar: string
  /** The personality: the body of the agent file. Lines stay in the value; the row shows them joined. */
  prompt: string
  /** Carried from a model draft; absent means the daemon keeps the file's own (edit) or writes the plain one (create). */
  description?: string
  /** A catalog model id, or "" for the session's own. */
  model: string
  permission: BotPermission
  /** The catalog the model row cycles through, after "session default". */
  models: readonly string[]
  /** Agent names a new bot may not take (the form says so before the daemon has to). */
  taken: readonly string[]
  /** `$VISUAL` or `$EDITOR` is set: the personality can also be opened in it. */
  editor: boolean
  row: number
  button: number
  /** Rows the user changed: their problems show at once; every row's shows after a save was tried. */
  touched: readonly BotFormRow[]
  attempted: boolean
  error?: string
  /** What a delete would do, while the confirmation is open. */
  confirm?: { memory: boolean } | undefined
  /** Where the page goes when it closes. */
  returnTo: "chat" | "bot"
  /** The confirmation was the reason the page opened: cancelling it closes the page. */
  deleteOnly?: boolean
  /** Set while a save, a delete or the editor runs: keys wait. */
  busy?: string | undefined
  /** Shown on the confirmation: the file the delete removes and how many sessions stay. */
  file?: string
  sessions: number
}

export type BotFormAction =
  | { type: "none" }
  | { type: "cancel" }
  | { type: "editor" }
  | { type: "save" }
  | { type: "delete"; memory: boolean }

type Common = { models?: readonly string[]; taken?: readonly string[]; editor?: boolean; returnTo?: "chat" | "bot" }

const base = ({ models = [], taken = [], editor = false, returnTo = "chat" }: Common): Omit<BotFormState, "mode" | "name" | "color" | "shape" | "face" | "avatar" | "prompt" | "model" | "permission" | "sessions"> => ({ models, taken, editor, row: 0, button: 0, touched: [], attempted: false, returnTo })

/** A new bot. `draft` is what the model wrote for `-d`: the form shows it to confirm. */
export function newBotForm({ name = "", draft, ...rest }: Common & { name?: string; draft?: { name: string; description: string; prompt: string; shape?: BotShape | undefined; color?: BotColor | undefined } }): BotFormState {
  return {
    ...base(rest), mode: "create", name: draft?.name ?? name, color: draft?.color ?? "auto", shape: draft?.shape ?? "auto", face: "generated", avatar: "",
    prompt: draft?.prompt ?? "", ...(draft ? { description: draft.description } : {}), model: "", permission: "smart", sessions: 0,
    row: name || draft ? 1 : 0,
  }
}

/** An existing bot, prefilled from its list entry and the body of its file. */
export function editBotForm({ bot, prompt, ...rest }: Common & { bot: BotInfo; prompt: string }): BotFormState {
  const sessions = bot.projects.reduce((sum, project) => sum + project.sessions.length, 0)
  return {
    ...base(rest), mode: "edit", name: bot.name, color: bot.identity.color ?? "auto", shape: bot.identity.shape ?? "auto", face: bot.identity.avatar ? "image" : "generated", avatar: bot.identity.avatar ?? "",
    prompt, model: bot.model ?? "", permission: bot.permission ?? "smart", sessions, file: bot.file, row: 1,
  }
}

/** The delete confirmation of an existing bot, with nothing else on the page. */
export function deleteBotForm(input: Common & { bot: BotInfo; prompt?: string }): BotFormState {
  return { ...editBotForm({ ...input, prompt: input.prompt ?? "" }), confirm: { memory: false }, deleteOnly: true }
}

/** The personality in an agent file's text: what follows the frontmatter. */
export const botPromptOf = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim()

export function botFormRows(form: BotFormState): BotFormRow[] {
  return ["name", "color", "shape", "face", ...(form.face === "image" ? ["avatar" as const] : []), "prompt", ...(form.editor ? ["editor" as const] : []), "model", "permission", "buttons"]
}
const rowAt = (form: BotFormState): BotFormRow => {
  const rows = botFormRows(form)
  return rows[Math.max(0, Math.min(form.row, rows.length - 1))]!
}
/** The buttons of the last row, in order. */
export const botFormButtons = (form: BotFormState): Array<"save" | "delete" | "cancel"> => ["save", ...(form.mode === "edit" ? ["delete" as const] : []), "cancel"]

/** What is wrong with each row now; the form shows a row's problem once it was touched or a save was tried. */
export function botFormProblems(form: BotFormState): Partial<Record<BotFormRow, string>> {
  const problems: Partial<Record<BotFormRow, string>> = {}
  if (form.mode === "create") {
    if (!form.name) problems.name = "a bot needs a name"
    else if (!BOT_NAME.test(form.name)) problems.name = "lowercase letters, digits, _ and - only (at most 64)"
    else if (RESERVED.includes(form.name) || form.taken.includes(form.name)) problems.name = `${form.name} is already an agent name`
  }
  if (form.face === "image") {
    const path = form.avatar.trim()
    if (!path) problems.avatar = "name a .png or .webp file, or use the generated face"
    else if (path.length > MAX_AVATAR_PATH) problems.avatar = "that path is too long"
    else if (!/\.(png|webp)$/i.test(path)) problems.avatar = "the image must be a .png or .webp file"
  }
  if (form.prompt.length > MAX_PROMPT) problems.prompt = `the personality takes at most ${MAX_PROMPT} characters (this one has ${form.prompt.length})`
  return problems
}

const shown = (form: BotFormState, row: BotFormRow) => form.attempted || form.touched.includes(row)

/** The command fields the daemon's `bot.save` takes, once the form has no problem. */
export function botSaveFields(form: BotFormState) {
  return {
    name: form.name, create: form.mode === "create", prompt: form.prompt, permission: form.permission,
    ...(form.description !== undefined ? { description: form.description } : {}),
    ...(form.shape !== "auto" ? { shape: form.shape } : {}), ...(form.color !== "auto" ? { color: form.color } : {}),
    ...(form.face === "image" && form.avatar.trim() ? { avatar: form.avatar.trim() } : {}),
    ...(form.model ? { model: form.model } : {}),
  }
}

const UP = new Set(["\x1b[A", "\x1bOA", "\x1b[Z"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\t"])
const LEFT = new Set(["\x1b[D", "\x1bOD"])
const RIGHT = new Set(["\x1b[C", "\x1bOC"])
const TEXT_ROWS = new Set<BotFormRow>(["name", "avatar", "prompt"])
const TEXT_LIMIT: Partial<Record<BotFormRow, number>> = { name: 64, avatar: MAX_AVATAR_PATH, prompt: MAX_PROMPT + 200 }

function cycle<T>(list: readonly T[], current: T, direction: 1 | -1): T {
  const at = list.indexOf(current)
  return list[(at + direction + list.length) % list.length]!
}

function touch(form: BotFormState, row: BotFormRow): BotFormState {
  const { error: _error, ...rest } = form
  return { ...rest, touched: form.touched.includes(row) ? form.touched : [...form.touched, row] }
}

function change(form: BotFormState, row: BotFormRow, direction: 1 | -1): BotFormState {
  const next = touch(form, row)
  switch (row) {
    case "color": return { ...next, color: cycle<BotColor | "auto">(["auto", ...BOT_COLORS], form.color, direction) }
    case "shape": return { ...next, shape: cycle<BotShape | "auto">(["auto", ...BOT_SHAPES], form.shape, direction) }
    case "face": return { ...next, face: form.face === "generated" ? "image" : "generated" }
    case "model": return { ...next, model: cycle(["", ...form.models], form.model, direction) }
    case "permission": return { ...next, permission: cycle(BOT_PERMISSIONS, form.permission, direction) }
    case "buttons": return { ...form, button: (form.button + direction + botFormButtons(form).length) % botFormButtons(form).length }
    default: return form
  }
}

function typed(form: BotFormState, row: BotFormRow, update: (value: string) => string): BotFormState {
  const key = row === "name" ? "name" : row === "avatar" ? "avatar" : "prompt"
  return { ...touch(form, row), [key]: update(form[key]).slice(0, TEXT_LIMIT[row] ?? 200) }
}

/** The keys of the delete confirmation: `y` confirms, `m` flips the memory choice, Esc cancels; Enter and everything else do nothing. */
function confirmKey(form: BotFormState, key: string): { form: BotFormState | undefined; action: BotFormAction } {
  if (key === "\x1b") return form.deleteOnly ? { form: undefined, action: { type: "cancel" } } : { form: { ...form, confirm: undefined }, action: { type: "none" } }
  if (key === "m") return { form: { ...form, confirm: { memory: !form.confirm!.memory } }, action: { type: "none" } }
  if (key === "y") return { form: { ...form, busy: "deleting…" }, action: { type: "delete", memory: form.confirm!.memory } }
  return { form, action: { type: "none" } }
}

/** One raw key: the form to keep (undefined closes the page) and what the app should do. */
export function botFormKey(form: BotFormState, key: string): { form: BotFormState | undefined; action: BotFormAction } {
  const NONE: BotFormAction = { type: "none" }
  if (form.busy) return { form, action: NONE }
  if (form.confirm) return confirmKey(form, key)
  const rows = botFormRows(form)
  const row = rowAt(form)
  const move = (index: number) => ({ form: { ...form, row: Math.max(0, Math.min(index, rows.length - 1)) }, action: NONE })
  if (key === "\x1b") return { form: undefined, action: { type: "cancel" } }
  if (UP.has(key)) return move(form.row - 1)
  if (DOWN.has(key)) return move(form.row + 1)
  if (row === "buttons") {
    if (LEFT.has(key) || RIGHT.has(key)) return { form: change(form, row, RIGHT.has(key) ? 1 : -1), action: NONE }
    if (key !== "\r") return { form, action: NONE }
    const button = botFormButtons(form)[form.button]!
    if (button === "cancel") return { form: undefined, action: { type: "cancel" } }
    if (button === "delete") return { form: { ...form, confirm: { memory: false } }, action: NONE }
    const problems = botFormProblems(form)
    const first = rows.findIndex((candidate) => problems[candidate] !== undefined)
    if (first >= 0) return { form: { ...form, attempted: true, row: first }, action: NONE }
    return { form: { ...form, attempted: true, busy: form.mode === "create" ? "creating…" : "saving…" }, action: { type: "save" } }
  }
  if (row === "editor" && key === "\r") return { form: { ...form, busy: "editing…" }, action: { type: "editor" } }
  if (key === "\r") return move(form.row + 1)
  if (row === "name" && form.mode === "edit") return { form, action: NONE }
  if (TEXT_ROWS.has(row)) {
    if (key === "\x7f" || key === "\b") return { form: typed(form, row, (value) => value.slice(0, -1)), action: NONE }
    if (key === "\x15") return { form: typed(form, row, () => ""), action: NONE }
    // A name is lowercase: typing a capital makes the letter that would pass.
    if (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(key)) return { form: typed(form, row, (value) => value + (row === "name" ? key.toLowerCase() : key)), action: NONE }
    return { form, action: NONE }
  }
  if (LEFT.has(key)) return { form: change(form, row, -1), action: NONE }
  if (RIGHT.has(key) || key === " ") return { form: change(form, row, 1), action: NONE }
  return { form, action: NONE }
}

const LABEL: Record<BotFormRow, string> = { name: "Name", color: "Color", shape: "Shape", face: "Face", avatar: "Image", prompt: "Personality", editor: "", model: "Model", permission: "Permission", buttons: "" }
const LABEL_WIDTH = 13
/** The word for each theme color role, as `/bot new -d a calm green reviewer` reads it. */
export const COLOR_WORD: Record<BotColor, string> = { primary: "primary", secondary: "gray", accent: "purple", success: "green", warning: "amber", error: "red", info: "blue" }

function hintFor(form: BotFormState, row: BotFormRow): string {
  switch (row) {
    case "name": return form.mode === "edit" ? "a bot's name stays; /bot duplicate makes a copy under another" : "lowercase letters, digits, _ and -; the agent name /agent uses"
    case "color": return form.color === "auto" ? "auto takes the color from the name; ← → picks one" : `${form.color} in your theme`
    case "shape": return form.shape === "auto" ? "auto takes the shape from the name; ← → picks one" : "the outline of its face"
    case "face": return form.face === "generated" ? "drawn from the name, shape and color" : "your own picture, shown where the terminal draws images"
    case "avatar": return "a .png or .webp (at most 1 MiB, 512 px) in the bot's folder or the data folder"
    case "prompt": return form.prompt.includes("\n") ? "several lines are kept; typing adds to the end" : "how it behaves, in a sentence or a few; empty uses a plain description"
    case "editor": return "opens the personality in your editor and takes the result back"
    case "model": return "the model its sessions use; session default follows the session"
    case "permission": return { plan: "plans and reads, no edits", ask: "asks before every edit and command", smart: "edits inside the project; asks before deleting, secrets, sudo", edits: "edits freely; asks before commands", full: "no questions asked" }[form.permission]
    case "buttons": return botFormButtons(form)[form.button] === "delete" ? "asks again before anything is removed" : "←→ picks a button · enter presses it"
  }
}

function valueSpans({ form, row, on, room, ascii }: { form: BotFormState; row: BotFormRow; on: boolean; room: number; ascii: boolean }): Span[] {
  const [open, close] = ascii ? ["< ", " >"] : ["‹ ", " ›"]
  const choice = (spans: Span[]): Span[] => [{ text: open, fg: "muted" }, ...spans, { text: close, fg: "muted" }]
  const text = (value: string, placeholder: string): Span[] => {
    const flat = value.replace(/\n/g, ascii ? " / " : " ↵ ")
    const line = flat === "" ? placeholder : flat
    const tail = textWidth(line) > room - 1 ? `…${line.slice(line.length - (room - 2))}` : line
    return [{ text: tail, fg: value === "" ? "muted" : "text", bold: on && value !== "" }, ...(on ? [{ text: ascii ? "|" : "▏", fg: "primary" as const }] : [])]
  }
  switch (row) {
    case "name": return form.mode === "edit" ? [{ text: form.name, fg: "text" }, { text: "  (fixed)", fg: "muted" }] : text(form.name, "required")
    case "color": {
      const look = faceLook({ name: form.name || "bot", shape: undefined, color: form.color === "auto" ? undefined : form.color })
      return choice([{ text: ascii ? "# " : "■ ", fg: look.color }, { text: form.color === "auto" ? `auto (${COLOR_WORD[look.color]})` : COLOR_WORD[form.color], fg: "text", bold: on }])
    }
    case "shape": {
      const look = faceLook({ name: form.name || "bot", shape: form.shape === "auto" ? undefined : form.shape, color: undefined })
      return choice([{ text: form.shape === "auto" ? `auto (${look.shape})` : form.shape, fg: "text", bold: on }])
    }
    case "face": return [{ text: form.face === "generated" ? (ascii ? "(*) generated  ( ) image path" : "(•) generated  ( ) image path") : (ascii ? "( ) generated  (*) image path" : "( ) generated  (•) image path"), fg: "text", bold: on }]
    case "avatar": return text(form.avatar, "face.png")
    case "prompt": return text(form.prompt, "optional")
    case "editor": return [{ text: "open in $EDITOR", fg: on ? "primary" : "muted", bold: on }]
    case "model": return choice([{ text: truncateEnd(form.model || "session default", Math.max(1, room - 4)), fg: form.model ? "text" : "muted", bold: on }])
    case "permission": return [{ text: BOT_PERMISSIONS.map((value) => `${value === form.permission ? (ascii ? "(*)" : "(•)") : "( )"} ${value}`).join("  "), fg: "text", bold: on }]
    case "buttons": {
      const label = { save: form.mode === "create" ? "Create" : "Save", delete: "Delete", cancel: "Cancel" }
      return botFormButtons(form).flatMap((button, index): Span[] => {
        const active = on && index === form.button
        return [{ text: `[ ${label[button]} ]`, fg: active ? (button === "delete" ? "error" : "primary") : button === "delete" ? "error" : "text", bold: active }, { text: "  " }]
      })
    }
  }
}

/** The face and what it looks like now, at the top of the form: it changes as the shape, color and name do. */
function previewLines({ form, inner, ascii }: { form: BotFormState; inner: number; ascii: boolean }): Line[] {
  const look = faceLook({ name: form.name || "bot", shape: form.shape === "auto" ? undefined : form.shape, color: form.color === "auto" ? undefined : form.color })
  const face = botFace({ name: form.name || "bot", shape: look.shape, color: look.color, state: "idle", size: "card", capability: { ascii }, label: "idle" })
  const room = Math.max(1, inner - CARD_COLS - 2)
  const text: Line[] = [
    [{ text: truncateEnd(form.name || "(no name yet)", room), fg: form.name ? "text" : "muted", bold: true }],
    [{ text: truncateEnd(`${look.shape} · ${COLOR_WORD[look.color]}${form.face === "image" ? " · your image" : ""}`, room), fg: "muted" }],
    [{ text: truncateEnd(form.mode === "create" ? "a new bot" : "editing a bot", room), fg: "muted" }],
  ]
  return face.lines.map((line, index): Line => [...line, { text: "  " }, ...(text[index] ?? [])])
}

function confirmLines({ form, inner, ascii }: { form: BotFormState; inner: number; ascii: boolean }): Line[] {
  const memory = form.confirm!.memory
  const dash = ascii ? "-" : "•"
  const plain = (text: string, fg: Span["fg"] = "text", bold = false): Line[] => wrap(text, inner).map((line): Line => [{ text: line, fg, bold }])
  return [
    ...plain(`Delete bot ${form.name}?`, "error", true),
    [],
    ...plain(`${dash} its agent file is removed${form.file ? `: ${form.file}` : ""}`),
    ...plain(memory ? `${dash} its memory folder (bots/${form.name}) is removed too` : `${dash} its memory folder (bots/${form.name}) is kept; press m to remove it as well`, memory ? "warning" : "text"),
    ...plain(`${dash} its ${form.sessions === 1 ? "1 session" : `${form.sessions} sessions`} and conversations are never deleted: they stay in /sessions as normal sessions`),
    [],
    [{ text: "y", fg: "error", bold: true }, { text: " delete    ", fg: "text" }, { text: "m", fg: "primary", bold: true }, { text: ` memory: ${memory ? "remove" : "keep"}    `, fg: "text" }, { text: "esc", fg: "primary", bold: true }, { text: " cancel", fg: "text" }],
    ...(form.busy ? [[], [{ text: form.busy, fg: "muted" } as Span]] as Line[] : []),
    ...(form.error ? [[], [{ text: truncateEnd(`${ascii ? "x" : "✗"} ${form.error}`, inner), fg: "error" } as Span]] as Line[] : []),
  ]
}

const HINTS = ["↑↓ row · ←→ change · type to edit · enter next · esc cancel", "↑↓ · ←→ · enter · esc cancel", "esc cancel"]

/** Exactly `height` lines of at most `width` cells. */
export function renderBotForm({ form, width, height, ascii = false }: { form: BotFormState; width: number; height: number; ascii?: boolean }): Line[] {
  if (height <= 0) return []
  const inner = Math.max(1, width - 4)
  const title = `Bots · ${form.confirm ? "Delete" : form.mode === "create" ? "New" : "Edit"}`
  const room = Math.max(0, height - 2)
  if (form.confirm) {
    const hints = form.busy ? "esc cancel" : "y delete · m memory · esc cancel"
    return pickerFrame(title, hints, width, height, panelGrid({ width, compact: false, padding: true, heights: [room], maxColumns: 1, rows: [[{ title: form.name, body: confirmLines({ form, inner, ascii }), active: true }]] }))
  }
  const rows = botFormRows(form)
  const focused = rowAt(form)
  const problems = botFormProblems(form)
  const valueRoom = Math.max(8, inner - 2 - LABEL_WIDTH)
  const body: Line[] = [...previewLines({ form, inner, ascii }), []]
  let focusRow = 0
  rows.forEach((row) => {
    const on = row === focused
    if (row === "buttons") body.push([])
    if (on) focusRow = body.length
    const marker: Span = on ? { text: ascii ? "> " : "❯ ", fg: "primary", bold: true } : { text: "  " }
    const wrong = problems[row] !== undefined && shown(form, row)
    body.push(clip([marker, { text: LABEL[row].padEnd(LABEL_WIDTH), fg: wrong ? "error" : on ? "primary" : "text", bold: on }, ...valueSpans({ form, row, on, room: valueRoom, ascii }), ...(wrong ? [{ text: ascii ? " x" : " ✗", fg: "error" as const }] : [])], inner))
    if (wrong) body.push(clip([{ text: `  ${" ".repeat(LABEL_WIDTH)}` }, { text: problems[row]!, fg: "error" }], inner))
  })
  const hint = wrap(hintFor(form, focused), Math.max(8, inner - 2)).slice(0, 2)
  body.push([], ...hint.map((text): Line => [{ text: `  ${text}`, fg: "muted", dim: true }]))
  if (form.busy) body.push([{ text: form.busy, fg: "muted" }])
  else if (form.error) body.push([{ text: truncateEnd(`${ascii ? "x" : "✗"} ${form.error}`, inner), fg: "error" }])
  const hints = HINTS.find((text) => textWidth(text) <= Math.max(20, width - 2))!
  const scroll = Math.max(0, focusRow + 5 - room)
  return pickerFrame(title, hints, width, height, panelGrid({ width, compact: false, padding: true, heights: [room], maxColumns: 1, rows: [[{ title: form.mode === "create" ? "New bot" : form.name, body, scroll, active: true }]] }), form.error ?? "")
}
