import type { SecretInfo } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type Glyphs, type Line } from "../ui/theme"
import { panelGrid, clip, deck, deckChrome, fit } from "./deck"
import { maskedMarker } from "./secret-markers"
import { truncateEnd } from "./session-list"
import { todayTimeOrDateTime } from "./time"
import { textWidth, wrap } from "./wrap"

/**
 * /secrets: the secrets pasted into this session (kind, last characters, when). `enter` reveals the value of the selected
 * one and it shows only while that row stays selected: moving, pressing enter again or leaving the page hides it. The value
 * lives in the page state alone; it is never logged, never put in a toast and never written anywhere.
 */
export type SecretsPageState = {
  selected: number
  /** The marker number `x` was pressed on once; a second `x` on it forgets the secret. */
  confirm: number | null
  revealed: { n: number; value: string } | null
}

export type SecretsPageAction = { type: "none" } | { type: "close" } | { type: "reveal"; n: number } | { type: "forget"; n: number }

const NONE: SecretsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const HINTS = "↑↓ select · enter reveal · x forget · esc back"
const MAX_VALUE_ROWS = 6
const MAX_KIND = 28

export function createSecretsPageState(): SecretsPageState {
  return { selected: 0, confirm: null, revealed: null }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

/** Handles one raw key. Returns the same state object when nothing changed. */
export function secretsPageKey(state: SecretsPageState, key: string, secrets: readonly SecretInfo[]): { state: SecretsPageState; action: SecretsPageAction } {
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  const selected = clamp(state.selected, secrets.length)
  const current = secrets[selected]
  const same = (next: SecretsPageState) => (next.selected === state.selected && next.confirm === state.confirm && next.revealed === state.revealed ? state : next)
  const direction = UP.has(key) ? -1 : DOWN.has(key) ? 1 : 0
  if (direction !== 0) {
    const next = clamp(selected + direction, secrets.length)
    if (next === selected) return { state: same({ ...state, selected, confirm: null }), action: NONE }
    return { state: { selected: next, confirm: null, revealed: null }, action: NONE }
  }
  if (!current) return { state: same({ ...state, selected, confirm: null }), action: NONE }
  if (key === "\r") {
    if (state.revealed?.n === current.n) return { state: { selected, confirm: null, revealed: null }, action: NONE }
    return { state: { selected, confirm: null, revealed: null }, action: { type: "reveal", n: current.n } }
  }
  if (key === "x") {
    if (state.confirm === current.n) return { state: { selected, confirm: null, revealed: null }, action: { type: "forget", n: current.n } }
    return { state: { selected, confirm: current.n, revealed: state.revealed }, action: NONE }
  }
  return { state: same({ ...state, selected, confirm: null }), action: NONE }
}

/** The state with the value of secret `n` shown (the reply of `secrets.reveal`); ignored when another row is selected by then. */
export function secretsRevealed(state: SecretsPageState, secrets: readonly SecretInfo[], n: number, value: string): SecretsPageState {
  return secrets[clamp(state.selected, secrets.length)]?.n === n ? { ...state, revealed: { n, value } } : state
}

/** Printable text only: a value could hold terminal escapes, which must never reach the screen as such. */
function printable(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
}

function valueRows(value: string, width: number): Line[] {
  const room = Math.max(1, width - 2)
  // Only what can be seen is wrapped: a value may be 16 KiB (a private key) and the pane shows a few rows.
  const pieces = printable(value.slice(0, MAX_VALUE_ROWS * room * 2)).split("\n").flatMap((row) => (row === "" ? [""] : wrap(row, room)))
  const shown = pieces.slice(0, MAX_VALUE_ROWS)
  const rows: Line[] = shown.map((text) => clip([{ text: `  ${text}`, fg: "warning" }], width))
  if (pieces.length > MAX_VALUE_ROWS) rows.push(clip([{ text: `  … ${pieces.length - MAX_VALUE_ROWS} more rows`, fg: "muted" }], width))
  return rows
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderSecretsPage(input: { secrets: readonly SecretInfo[]; state: SecretsPageState; width: number; height: number; now: number; glyphs?: Glyphs }): Line[] {
  const { secrets, state, width, now } = input
  const height = Math.max(0, input.height)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 2)
  const summary = `${secrets.length} ${secrets.length === 1 ? "secret" : "secrets"}`
  const frame = (body: Line[]) => deck({ page: "Secrets", subtitle: "this session", summary, body, hints: HINTS, width, height })
  if (secrets.length === 0) {
    return frame([
      clip([{ text: "no secrets in this session", fg: "muted" }], inner),
      [],
      clip([{ text: "a key, token or password you paste becomes ‹secret:N›; the model never sees its value", fg: "muted" }], inner),
    ])
  }
  const selected = clamp(state.selected, secrets.length)
  const current = secrets[selected]!
  const markerWidth = Math.max(...secrets.map((secret) => textWidth(`‹secret:${secret.n}›`)))
  const kindWidth = Math.max(4, Math.min(MAX_KIND, Math.floor(inner / 3), Math.max(...secrets.map((secret) => textWidth(secret.kind)))))
  const rows: Line[] = secrets.map((secret, index) => {
    const on = index === selected
    const marker = `‹secret:${secret.n}›`
    return fit(
      [
        on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
        { text: marker.padEnd(markerWidth), fg: on ? "primary" : "body", bold: on },
        { text: "  " },
        { text: truncateEnd(secret.kind, kindWidth).padEnd(kindWidth), fg: on ? "text" : "muted" },
        { text: "  " },
        { text: `··${secret.tail}`, fg: "body" },
        { text: `  ${todayTimeOrDateTime(secret.createdAt, now)}`, fg: "muted" },
      ],
      inner,
    )
  })
  const room = Math.max(0, height - deckChrome(HINTS, width))
  const detail: Line[] = [[]]
  if (state.confirm === current.n) detail.push(clip([{ text: `press x again to forget ${maskedMarker(current.tail)} · its marker stops resolving`, fg: "warning" }], inner))
  else if (state.revealed?.n === current.n) detail.push(clip([{ text: "value · hidden again when you move or leave", fg: "muted" }], inner), ...valueRows(state.revealed.value, inner))
  else detail.push(clip([{ text: "enter reveals the value on screen only", fg: "muted" }], inner))
  if (width >= 110) {
    return frame(panelGrid({ width: inner, heights: [room], rows: [[
      { title: "Secrets", weight: 2, body: rows, scroll: Math.max(0, selected + 2 - (room - 2)) },
      { title: `‹secret:${current.n}› · ${current.kind}`, weight: 3, body: (w) => [
        [{ text: `··${current.tail} · ${todayTimeOrDateTime(current.createdAt, now)}`, fg: "muted" }],
        ...(state.confirm === current.n ? valueRows(`press x again to forget ${maskedMarker(current.tail)} · its marker stops resolving`, w).map((row) => row.map((span) => ({ ...span, fg: "warning" as const }))) : state.revealed?.n === current.n ? [[{ text: "value · hidden again when you move or leave", fg: "muted" } as const], ...valueRows(state.revealed.value, w)] : [[{ text: "enter reveals the value on screen only", fg: "muted" } as const]]),
      ] },
    ]] }))
  }
  const listRoom = Math.max(1, room - detail.length)
  const offset = Math.min(Math.max(0, selected - listRoom + 1), Math.max(0, rows.length - listRoom))
  return frame([...rows.slice(offset, offset + listRoom), ...detail])
}
