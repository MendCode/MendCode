import { clip, deck, deckChrome, fit, panelGrid } from "./deck"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import { truncateEnd } from "./session-list"
import { todayTimeOrDateTime } from "./time"
import { textWidth, wrap } from "./wrap"

export type EnvScope = "session" | "project" | "global"
export type EnvInfo = { name: string; scope: EnvScope; updatedAt: number }
export type EnvironmentPageState = {
  entries: EnvInfo[]; selected: number; encrypted?: boolean | undefined; native?: boolean | undefined
  /** The `engineEnvironment` setting: Claude Code, Codex, pi and ACP get the credentials too. */
  engines?: boolean | undefined
  encryptionTarget?: boolean | undefined; encryptionPending?: number | undefined
  loading: boolean; busy: boolean; error: string; scope: EnvScope
  edit?: { name: string; value: string; field: "name" | "value" } | undefined
  import?: { path: string; digest?: string | undefined; names?: string[] | undefined } | undefined
  confirm?: "remove" | "privacy" | "import" | undefined
}
export const createEnvironmentPageState = (): EnvironmentPageState => ({ entries: [], selected: 0, loading: true, busy: false, error: "", scope: "project" })

const HINTS = "↑↓ select · a add · e replace · x remove · i import .env · p encryption · r reload · esc back"
const EDIT_HINTS = "tab field · ctrl+s scope · enter next/save · esc cancel"
const IMPORT_HINTS = "type dotenv path · ctrl+s scope · enter preview · esc cancel"
const CONFIRM_HINTS = "y confirm · esc cancel"
const SCOPE_TONE: Record<EnvScope, ColorName> = { session: "info", project: "accent", global: "synType" }
const LABEL = 13

/** One `label  value` row of a panel; the value takes the tone, the label stays quiet. */
const fact = (label: string, value: string, width: number, fg: ColorName = "body"): Line[] =>
  wrap(value, Math.max(8, width - LABEL)).map((line, index) => [{ text: (index ? "" : label).padEnd(LABEL), fg: "muted" }, { text: line, fg }])
const prose = (text: string, width: number, fg: ColorName = "muted"): Line[] => wrap(text, Math.max(1, width)).map((line) => [{ text: line, fg }])

/** The state of chat encryption in one word and one colour: `incomplete` is a change that stopped half way. */
function encryption(state: EnvironmentPageState): { label: string; fg: ColorName; storage: string } {
  if (state.encryptionPending) return { label: `INCOMPLETE · ${state.encryptionPending} pending · target ${state.encryptionTarget ? "ON" : "OFF"}`, fg: "warning", storage: "mixed until it finishes" }
  return state.encrypted ? { label: "ON · AES-256-GCM", fg: "success", storage: "encrypted files" } : { label: "OFF · readable SQLite", fg: "muted", storage: "other local tools can read it" }
}

/** What the left panel is doing: the list, or one of the steps that replace it. */
function work(state: EnvironmentPageState, glyphs: Glyphs, now: number): { title: string; body: (width: number) => Line[]; scroll?: number } {
  const scope: Line = [{ text: "Scope".padEnd(LABEL), fg: "muted" }, { text: state.scope, fg: SCOPE_TONE[state.scope], bold: true }, { text: "  ctrl+s cycles", fg: "muted" }]
  if (state.confirm === "privacy") {
    const on = state.encryptionTarget ?? state.encrypted
    return { title: on ? "Turn encryption off" : "Turn encryption on", body: (width) => [
      ...prose(on ? "Disable encryption? Other local tools can read the database again." : "Encrypt existing and future chats? Local analyzers will no longer read SQLite directly.", width, "warning"),
      [],
      ...prose("Back up keys/chats.key separately. Same-user programs with that key can decrypt.", width),
      ...prose("Exports, previous backups, provider copies and adapter-owned logs are not encrypted.", width),
    ] }
  }
  if (state.confirm === "import") return { title: "Import .env", body: (width) => [
    ...prose(`Import ${state.import?.names?.length ?? 0} variables into ${state.scope}? Existing names in this scope are replaced.`, width, "warning"),
    [],
    ...prose((state.import?.names ?? []).join(", "), width, "primary"),
    [],
    ...prose("Source .env remains unchanged and readable. Values are literal; no variable expansion.", width),
  ] }
  if (state.import) return { title: "Import .env", body: (width) => [
    [{ text: "Dotenv file".padEnd(LABEL), fg: "muted" }, { text: `${state.import!.path}_`, fg: "primary" }],
    scope,
    [],
    ...prose("Choose a file inside this project. Preview lists names only, never values.", width),
  ] }
  if (state.confirm === "remove") return { title: "Remove credential", body: (width) => prose(`Remove ${state.entries[state.selected]?.name ?? "credential"}? New commands will no longer receive it.`, width, "warning") }
  if (state.edit) {
    const edit = state.edit
    const field = (on: boolean, label: string, value: string, set: boolean): Line => [
      on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
      { text: label.padEnd(LABEL - 2), fg: on ? "text" : "muted" },
      { text: value, fg: set ? "primary" : "muted" },
    ]
    return { title: "Credential", body: (width) => [
      field(edit.field === "name", "Name", edit.name || "MY_API_KEY", !!edit.name),
      field(edit.field === "value", "Value", edit.value ? "•••••••• (set)" : "(paste here, hidden)", !!edit.value),
      [{ text: "  " }, ...scope.map((span, index) => (index === 0 ? { ...span, text: "Scope".padEnd(LABEL - 2) } : span))],
      [],
      ...prose("Saving authorizes tools in this scope to use the credential.", width, "warning"),
    ] }
  }
  if (!state.entries.length) return { title: "Credentials", body: (width) => [
    [{ text: "none yet", fg: "muted" }],
    [],
    ...prose("a adds one · i imports a .env file · none is ever written", width),
  ] }
  const nameWidth = Math.max(...state.entries.map((entry) => textWidth(entry.name)))
  return { title: "Credentials", scroll: state.selected, body: (width) => state.entries.map((entry, index) => {
    const on = index === state.selected
    const room = Math.max(8, width - 2 - 2 - 7 - 2 - 12)
    return fit([
      on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
      { text: truncateEnd(entry.name, room).padEnd(Math.min(nameWidth, room)), fg: on ? "primary" : "body", bold: on },
      { text: "  " },
      { text: entry.scope.padEnd(7), fg: SCOPE_TONE[entry.scope] },
      { text: `  ${todayTimeOrDateTime(entry.updatedAt, now)}`, fg: "muted" },
    ], width)
  }) }
}

export function renderEnvironmentPage(state: EnvironmentPageState | undefined, width: number, height: number, options: { glyphs?: Glyphs; now?: number } = {}): Line[] {
  const glyphs = options.glyphs ?? defaultGlyphs()
  const hints = state?.import && !state.confirm ? IMPORT_HINTS : state?.edit ? EDIT_HINTS : state?.confirm ? CONFIRM_HINTS : HINTS
  const inner = Math.max(1, width - 2)
  const count = state?.entries.length ?? 0
  const frame = (body: Line[], status?: { label: string; tone: "warn" | "error" }) => deck({ page: "Environment & privacy", subtitle: "local credentials", summary: `${count} configured`, ...(status ? { status } : {}), body, hints, width, height })
  if (!state || state.loading) return frame([clip([{ text: "loading credentials…", fg: "muted" }], inner)])
  const room = Math.max(0, height - deckChrome(hints, width))
  const left = work(state, glyphs, options.now ?? Date.now())
  const lock = encryption(state)
  const privacy = (panelWidth: number): Line[] => [
    ...wrap(`Chat encryption: ${lock.label}`, Math.max(8, panelWidth)).map((line): Line => [{ text: line, fg: lock.fg, bold: true }]),
    ...fact("Chats", lock.storage, panelWidth),
    ...fact("Credentials", "always encrypted", panelWidth),
    ...fact("Model sees", "names, never values", panelWidth),
    ...fact("Given to", state.engines === false ? "native shell tools only" : "shells of every engine", panelWidth),
    ...fact("Order", "session › project › global", panelWidth),
    [],
    ...(state.native === false ? [...prose("This engine cannot use the vault automatically. Select a native model.", panelWidth, "warning"), []] : []),
    ...prose(state.encrypted ? "p turns it off for all local chats and attachments." : "Off by default in every tier. p turns it on for all local chats and attachments.", panelWidth),
  ]
  const notes: Line[] = [
    ...(state.busy ? [clip([{ text: "saving…", fg: "muted" }], inner)] : []),
    ...(state.error ? prose(state.error, inner, "warning") : []),
  ]
  // Side by side only where the privacy facts fit their column; stacked below that, each at the full width.
  const wide = width >= 110
  const grid = panelGrid({ width: inner, ...(wide ? { heights: [Math.max(3, room - notes.length)] } : { maxColumns: 1 }), rows: [[
    { title: left.title, weight: 3, body: left.body, active: true, ...(left.scroll !== undefined ? { scroll: Math.max(0, left.scroll + 2 - (room - notes.length - 2)) } : {}) },
    { title: "Privacy", weight: 2, body: privacy },
  ]] })
  return frame([...grid, ...notes], state.encryptionPending ? { label: "encryption incomplete", tone: "warn" } : undefined)
}
