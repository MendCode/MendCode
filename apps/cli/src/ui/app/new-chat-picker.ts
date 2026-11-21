import { statSync } from "node:fs"
import { join, resolve } from "node:path"
import { folderChoices, looksLikePath, renderNewChatPicker, type FolderChoice } from "../../view/new-chat-picker"
import { pathMatches } from "../../view/path-arguments"
import type { Line } from "../theme"
import type { AppContext } from "./context"

/**
 * The "New chat in…" picker (docs/sidebar.md): opened by the list's `+ New chat…` row, by the `+` that ends a bot's row and by `n`.
 * It draws over the left list and takes the keyboard while it is open, as the list's search does. Loaded by its first use; closed, it
 * holds no timer and does no work. A typed path is read from the disk with the completion `/cd` uses (local terminals only).
 */
export type NewChatPicker = ReturnType<typeof createNewChatPicker>

export type PickRequest = {
  title: string
  /** The open folder first, then the others in the order to offer them. */
  folders: readonly string[]
  /** What a relative path is read from. */
  base: string
  home: string
  remote: boolean
  start(directory: string): Promise<void>
}

const QUERY_MAX = 300
/** The arrows of a terminal in application-cursor mode. */
const APPLICATION_ARROWS: Record<string, string> = { "\x1bOA": "\x1b[A", "\x1bOB": "\x1b[B" }
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/

export function createNewChatPicker(ctx: AppContext) {
  const { state, requestFrame, say } = ctx
  let request: PickRequest | undefined
  let query = ""
  let selected = 0
  let choices: FolderChoice[] = []
  /** The list's focus and selection before the picker opened, given back by Esc. */
  let before: { focus: boolean; selected: string | undefined } = { focus: false, selected: undefined }

  const expand = (typed: string, from: PickRequest) => resolve(from.base, typed === "~" ? from.home : typed.startsWith("~/") ? join(from.home, typed.slice(2)) : typed)
  const isDirectory = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }

  function compute() {
    if (!request) return
    const from = request
    const typed = query.trim()
    const path = looksLikePath(typed) && !from.remote
    const typedDirectory = path && isDirectory(expand(typed, from)) ? expand(typed, from) : undefined
    const completions = path ? pathMatches({ command: "cd", args: typed, base: from.base }).map((match) => {
      const walked = match.name.slice("cd ".length)
      return { directory: expand(walked, from), typed: walked }
    }) : []
    choices = folderChoices({ folders: from.folders, opened: from.folders[0], query: typed, home: from.home, typedDirectory, completions })
    selected = Math.max(0, Math.min(selected, choices.length - 1))
  }

  function setQuery(next: string) {
    query = Array.from(next).slice(0, QUERY_MAX).join("")
    selected = 0
    compute()
    requestFrame()
  }

  function show(next: PickRequest) {
    if (!request) before = { focus: state.sidebarFocus === true, selected: state.sidebarSelected }
    request = next
    state.sidebarFocus = true
    setQuery("")
  }

  /** Closes the picker; `restore` gives the list its focus and selection back (Esc), otherwise the prompt keeps the keyboard. */
  function close(restore: boolean) {
    if (!request) return
    request = undefined
    query = ""
    choices = []
    if (restore) {
      state.sidebarFocus = before.focus
      state.sidebarSelected = before.selected
    } else state.sidebarFocus = false
    requestFrame()
  }

  /** Starts the chat in the picked row's folder; with no row, in the typed path when a remote terminal (which reads no disk) typed one. */
  async function start(index: number) {
    const from = request
    if (!from) return
    const typed = query.trim()
    const directory = choices[index]?.directory ?? (from.remote && typed.startsWith("/") ? typed : undefined)
    if (!directory) return say(looksLikePath(typed) ? "that is not a directory" : "no folder picked · type a name or a path", "warning")
    close(false)
    await from.start(directory)
  }

  /** A click on a row. */
  async function activate(id: string) {
    const index = id.startsWith("pick:") ? Number(id.slice("pick:".length)) : Number.NaN
    if (Number.isInteger(index) && choices[index]) await start(index)
  }

  /** The picker's keys; false for a key it leaves to the screen (the mouse). */
  async function key(key: string): Promise<boolean> {
    if (!request) return false
    if (key.startsWith("\x1b[<")) return false
    const arrow = APPLICATION_ARROWS[key] ?? key
    if (key === "\x1b" || key === "\x03") close(true)
    else if (arrow === "\x1b[A" || key === "\x10") selected = choices.length ? (selected - 1 + choices.length) % choices.length : 0
    else if (arrow === "\x1b[B" || key === "\x0e") selected = choices.length ? (selected + 1) % choices.length : 0
    else if (key === "\r") await start(selected)
    else if (key === "\t") {
      // Tab walks into the picked directory, as it does after `/cd`; on a known folder it puts its path in the field to go on from.
      const choice = choices[selected]
      if (choice) setQuery(choice.typed ?? `${choice.detail.replace(/\/+$/, "")}/`)
    } else if (key === "\x7f" || key === "\b") {
      if (!query) close(true)
      else setQuery(Array.from(query).slice(0, -1).join(""))
    } else if (key === "\x15") setQuery("")
    else if (key === "\x17") setQuery(query.replace(/[^/\s]*[/\s]*$/, ""))
    else if (PRINTABLE.test(key)) setQuery(query + key)
    requestFrame()
    return true
  }

  /** A bracketed paste while the picker is open: one line added to the field (a path, usually). False when it is not open. */
  function paste(text: string): boolean {
    if (!request) return false
    const line = text.replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim()
    if (line) setQuery(query + line)
    requestFrame()
    return true
  }

  /** The sidebar's rows while the picker is open; undefined once it is not (another page, or a click that gave the prompt the keyboard, ends it). */
  function draw(options: { height: number; width: number; ascii: boolean }): { lines: Line[]; hits: Array<{ row: number; id: string }> } | undefined {
    if (!request) return undefined
    if (!state.sidebarFocus || state.page !== "chat") return void close(false)
    const drawn = renderNewChatPicker({ title: request.title, query, choices, selected, width: options.width, height: options.height, ascii: options.ascii })
    return { lines: drawn.rows, hits: drawn.hits }
  }

  return { isOpen: () => request !== undefined, show, close, key, paste, activate, draw, query: () => query, choices: () => choices }
}
