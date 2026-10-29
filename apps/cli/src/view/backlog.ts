import { BACKLOG_LIMITS, backlogOrder, type BacklogEdit, type BacklogItem, type BacklogOrigin } from "@mendcode/protocol/wire"
import type { ColorName, Glyphs, Line } from "../ui/theme"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/**
 * The project backlog's words and rows (docs/sidebar.md, "Project backlog"): what `/backlog` and the headless
 * `backlog` command parse, the plain lines both print, and the panel card. Pure data in, lines out.
 */

export const BACKLOG_USAGE = "usage: /backlog [list] · add [--file PATH] [--commit SHA] <text> · done|reopen|remove|open <id> · clear"
/** Rows of items the card shows before `+N more`. */
const CARD_ROWS = 6

export type BacklogWords =
  | { kind: "list" }
  | { kind: "change"; change: BacklogEdit }
  | { kind: "open"; id: number }
  | { kind: "error"; message: string }

const idOf = (word: string | undefined) => (word && /^#?\d{1,9}$/.test(word) ? Number(word.replace("#", "")) : undefined)

/**
 * `list`, `add [--file P] [--commit SHA] text…`, `done|reopen|remove|open <id>`, `clear`. `origin` is what the caller already
 * knows (the session the command is typed in); the flags add a file and a commit to it.
 */
export function parseBacklogWords(words: readonly string[], origin: BacklogOrigin = {}): BacklogWords {
  const [verb = "list", ...rest] = words
  if (verb === "list" || verb === "ls") return rest.length ? { kind: "error", message: "list takes no argument" } : { kind: "list" }
  if (verb === "clear" || verb === "clear-done") return rest.length ? { kind: "error", message: "clear takes no argument: it removes the finished items" } : { kind: "change", change: { op: "clear-done" } }
  if (verb === "add") {
    const from: BacklogOrigin = { ...origin }
    const text: string[] = []
    for (let at = 0; at < rest.length; at++) {
      const word = rest[at]!
      if ((word === "--file" || word === "--commit") && !text.length) {
        const value = rest[++at]
        if (!value) return { kind: "error", message: `${word} needs a value` }
        if (word === "--commit" && !/^[0-9a-fA-F]{4,64}$/.test(value)) return { kind: "error", message: "--commit needs a commit hash (4 to 64 hex digits)" }
        if (word === "--file" && value.length > BACKLOG_LIMITS.path) return { kind: "error", message: `--file takes at most ${BACKLOG_LIMITS.path} characters` }
        if (word === "--file") from.path = value
        else from.commit = value
      } else text.push(word)
    }
    const joined = text.join(" ").trim()
    if (!joined) return { kind: "error", message: "add needs the item's text" }
    if (joined.length > BACKLOG_LIMITS.text) return { kind: "error", message: `an item takes at most ${BACKLOG_LIMITS.text} characters (this one has ${joined.length})` }
    return { kind: "change", change: { op: "add", text: joined, ...(from.sessionId || from.path || from.commit ? { origin: from } : {}) } }
  }
  if (verb === "done" || verb === "reopen" || verb === "remove" || verb === "rm" || verb === "open") {
    const id = idOf(rest[0])
    if (id === undefined || rest.length !== 1) return { kind: "error", message: `${verb} needs one item number` }
    return verb === "open" ? { kind: "open", id } : { kind: "change", change: { op: verb === "rm" ? "remove" : verb, id } }
  }
  return { kind: "error", message: `unknown backlog word: ${verb.slice(0, 40)}` }
}

/** `src/store.ts · a1b2c3d · session ses_…`: where an item was born, or "" when nothing was recorded. */
export function backlogOriginText(origin: BacklogOrigin | undefined): string {
  if (!origin) return ""
  return [origin.path, origin.commit?.slice(0, 7), origin.sessionId ? `session ${origin.sessionId}` : undefined].filter(Boolean).join(" · ")
}

/** One plain line per item, open ones first: `#3 [ ] text  (origin)`. What `/backlog` lists and the headless command prints. */
export function backlogLines(items: readonly BacklogItem[]): string[] {
  return backlogOrder(items).map((item) => {
    const from = backlogOriginText(item.origin)
    return `#${item.id} [${item.done ? "x" : " "}] ${item.text}${from ? `  (${from})` : ""}`
  })
}

/** `2 open · 1 done`, the summary every surface leads with. */
export function backlogCount(items: readonly BacklogItem[]): string {
  const done = items.filter((item) => item.done).length
  return `${items.length - done} open · ${done} done`
}

/** What a change did, in one line for the toast and the headless output. */
export function backlogChangeText(change: BacklogEdit, result: { added?: number | undefined; items: readonly BacklogItem[] }, before?: readonly BacklogItem[]): string {
  if (change.op === "add") return `backlog: added #${result.added}`
  if (change.op === "clear-done") {
    const cleared = before ? before.length - result.items.length : undefined
    return cleared === undefined ? "backlog: finished items cleared" : cleared ? `backlog: cleared ${cleared} finished item${cleared === 1 ? "" : "s"}` : "backlog: nothing finished to clear"
  }
  return `backlog: #${change.id} ${change.op === "done" ? "done" : change.op === "reopen" ? "open again" : "removed"}`
}

/**
 * The panel card: the count, then one row per item (open ones first), like the todos card beside it. Past six rows finished
 * items leave first and a last line says how many are not shown. `items` undefined is the list not read yet.
 */
export function backlogCard({ items, off, width, glyphs }: { items: readonly BacklogItem[] | undefined; off?: boolean | undefined; width: number; glyphs: Glyphs }): Line[] {
  const muted = (text: string): Line => [{ text: truncateEnd(text, Math.max(1, width)), fg: "muted" }]
  if (off) return [muted("Backlog is off · /tier backlog on")]
  if (!items) return [muted("Reading the backlog…")]
  if (!items.length) return [muted("Nothing pending · /backlog add <text>")]
  const ordered = backlogOrder(items)
  const open = ordered.filter((item) => !item.done)
  const shown = (open.length >= CARD_ROWS ? open : ordered).slice(0, CARD_ROWS)
  const done = items.length - open.length
  const row = (item: BacklogItem): Line => {
    const mark: [string, ColorName] = item.done ? [glyphs.ok, "success"] : ["□", "text"]
    const head = `${mark[0]} #${item.id} `
    return [{ text: `${mark[0]} `, fg: mark[1] }, { text: `#${item.id} `, fg: "muted" }, { text: truncateEnd(item.text, Math.max(1, width - textWidth(head))), fg: item.done ? "muted" : "text" }]
  }
  return [
    [{ text: String(open.length), fg: open.length ? "text" : "success", bold: true }, { text: ` open${done ? ` · ${done} done` : ""}`, fg: "muted" }],
    ...shown.map(row),
    ...(items.length > shown.length ? [muted(`+${items.length - shown.length} more · /backlog`)] : []),
  ]
}
