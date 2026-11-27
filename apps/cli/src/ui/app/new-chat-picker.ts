import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { completeTab, eraseBack, expandTyped, goUp, isGitRepo, kindOfPath, lastSegment, nameToCreate, parseBrowse, rankNames, readDirectories, usualRoot } from "../../view/new-chat-browse"
import { folderChoices, looksLikePath, renderNewChatPicker, type FolderChoice } from "../../view/new-chat-picker"
import type { Line } from "../theme"
import type { AppContext } from "./context"

/**
 * The "New chat in…" picker (docs/sidebar.md): opened by the list's `+ New chat…` row, by the `+` that ends a bot's row and by `n`.
 * It draws over the left list and takes the keyboard while it is open, as the list's search does. Loaded by its first use; closed, it
 * holds no timer and does no work. Text that starts like a path browses the disk (local terminals only): each directory is read once,
 * on the key press that needs it and bounded, kept until the picker closes, and never read while a frame is drawn.
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
  /** The listed folders that hold a chat the sync hub owns: only these can be the hub's projects (a folder deleted or moved on this machine is not). */
  hubFolders?: ReadonlySet<string>
  /** The name of the sync hub this machine works with, asked only when some listed folder is not on this machine. */
  hubName?(): Promise<string | undefined>
  start(directory: string): Promise<void>
}

const QUERY_MAX = 300
const MAX_SHOWN = 60
const MAX_CACHED = 64
/** The arrows of a terminal in application-cursor mode. */
const APPLICATION_ARROWS: Record<string, string> = { "\x1bOA": "\x1b[A", "\x1bOB": "\x1b[B", "\x1bOC": "\x1b[C", "\x1bOD": "\x1b[D" }
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/

export function createNewChatPicker(ctx: AppContext) {
  const { state, requestFrame, say } = ctx
  let request: PickRequest | undefined
  let query = ""
  let selected = 0
  let choices: FolderChoice[] = []
  /** The list's focus and selection before the picker opened, given back by Esc. */
  let before: { focus: boolean; selected: string | undefined } = { focus: false, selected: undefined }
  /** Incremented by every query, so a directory read that finishes after a newer key is dropped. */
  let generation = 0
  let hub: { name: string; folders: ReadonlySet<string> } | undefined
  let browseRoot: string | undefined
  /** The directory a `+ create folder` row waits to make, after its first Enter. */
  let confirming: string | undefined
  /** The names the last typed path read from the disk that start with what is typed: what Tab completes. */
  let prefixed: string[] = []
  const listings = new Map<string, Promise<string[]>>()
  const gits = new Map<string, Promise<boolean>>()

  const browsing = () => request !== undefined && !request.remote && looksLikePath(query)
  const listing = (directory: string) => {
    let found = listings.get(directory)
    if (!found) {
      if (listings.size >= MAX_CACHED) listings.clear()
      found = readDirectories(directory)
      listings.set(directory, found)
    }
    return found
  }
  const gitOf = (directory: string) => {
    let found = gits.get(directory)
    if (!found) {
      if (gits.size >= MAX_CACHED * 4) gits.clear()
      found = isGitRepo(directory)
      gits.set(directory, found)
    }
    return found
  }

  /** What the typed path offers from the disk: its directory, those that continue it, and the folder it would create. */
  async function browse(typed: string, from: PickRequest) {
    const { head, partial } = parseBrowse(typed)
    const directory = expandTyped({ typed: head, base: from.base, home: from.home })
    const target = expandTyped({ typed, base: from.base, home: from.home })
    const [names, kind] = await Promise.all([listing(directory), kindOfPath(target)])
    const { ranked, prefixCount } = rankNames({ names, partial })
    const shown = ranked.slice(0, MAX_SHOWN)
    const [typedGit, ...flags] = await Promise.all([kind === "directory" ? gitOf(target) : false, ...shown.map((name) => gitOf(join(directory, name)))])
    return {
      prefixed: ranked.slice(0, prefixCount),
      found: {
        ...(kind === "directory" ? { typedDirectory: target, typedGit } : {}),
        completions: shown.map((name, index) => ({ directory: join(directory, name), typed: `${head}${name}/`, git: flags[index] === true })),
        prefixCount,
        ...(kind === undefined && nameToCreate(typed) ? { create: target } : {}),
      },
    }
  }

  /** The newest rebuild of the rows. A key or a click waits for it (`settled`): the rows of an older query are never acted on. */
  let refreshing: Promise<void> = Promise.resolve()
  async function settled() {
    for (let current = refreshing; ; current = refreshing) {
      await current
      if (current === refreshing) return
    }
  }

  /** Rebuilds the rows for the field; a typed path waits for its directory, and a newer key makes the older answer void. */
  function refresh(focus?: string) {
    const run = rebuild(focus)
    refreshing = run
    return run
  }
  async function rebuild(focus?: string) {
    const from = request
    if (!from) return
    const mine = ++generation
    const typed = query.trim()
    let next: FolderChoice[]
    if (looksLikePath(typed) && !from.remote) {
      const read = await browse(typed, from)
      if (mine !== generation || request !== from) return
      prefixed = read.prefixed
      next = folderChoices({ folders: from.folders, opened: from.folders[0], query: typed, home: from.home, ...read.found })
    } else {
      prefixed = []
      next = folderChoices({ folders: from.folders, opened: from.folders[0], query: typed, home: from.home, hub, browseRoot })
    }
    choices = next
    const named = focus === undefined ? -1 : choices.findIndex((choice) => choice.typed !== undefined && lastSegment(choice.directory) === focus)
    selected = named >= 0 ? named : Math.max(0, Math.min(selected, choices.length - 1))
    requestFrame()
  }

  /** The field takes this text; the first row is picked, or the folder named `focus` (the one `←` came out of). */
  function setQuery(next: string, focus?: string) {
    query = Array.from(next).slice(0, QUERY_MAX).join("")
    selected = 0
    confirming = undefined
    return refresh(focus)
  }

  /** Marks the listed folders that are not on this machine with the hub's name: asked once the picker is up, and only when one is missing. */
  async function markHub(from: PickRequest) {
    if (from.remote || !from.hubName) return
    const candidates = from.hubFolders ? from.folders.filter((folder) => from.hubFolders!.has(folder)) : from.folders
    const missing = (await Promise.all(candidates.map(async (folder) => await stat(folder).then(() => undefined, () => folder)))).filter((folder): folder is string => folder !== undefined)
    if (!missing.length || request !== from) return
    const name = await from.hubName().catch(() => undefined)
    if (!name || request !== from) return
    hub = { name, folders: new Set(missing) }
    if (!browsing()) await refresh()
  }

  function show(next: PickRequest) {
    if (!request) before = { focus: state.sidebarFocus === true, selected: state.sidebarSelected }
    request = next
    hub = undefined
    browseRoot = next.remote ? undefined : usualRoot({ folders: next.folders, home: next.home })
    state.sidebarFocus = true
    void setQuery("")
    void markHub(next).catch(() => {})
  }

  /** Closes the picker; `restore` gives the list its focus and selection back (Esc), otherwise the prompt keeps the keyboard. */
  function close(restore: boolean) {
    if (!request) return
    request = undefined
    generation++
    query = ""
    choices = []
    prefixed = []
    hub = undefined
    confirming = undefined
    listings.clear()
    gits.clear()
    if (restore) {
      state.sidebarFocus = before.focus
      state.sidebarSelected = before.selected
    } else state.sidebarFocus = false
    requestFrame()
  }

  /**
   * Enter or a click on a row. A folder starts the chat in it; `Browse folders…` opens the usual code root in the field; a
   * `+ create folder` row asks once more, and makes the folder (with its parents) only on the second Enter. With no row, a remote
   * terminal (which reads no disk) starts in the typed absolute path.
   */
  async function start() {
    await settled()
    const from = request
    if (!from) return
    const typed = query.trim()
    const choice = choices[selected]
    if (choice?.kind === "browse") return void await setQuery(choice.typed ?? "~/")
    if (choice?.kind === "create") {
      if (confirming !== choice.directory) {
        confirming = choice.directory
        return requestFrame()
      }
      try { await mkdir(choice.directory, { recursive: true }) }
      catch (error) {
        confirming = undefined
        return say(`could not create ${choice.detail} · ${error instanceof Error ? error.message.replace(/^[A-Z]+: /, "") : "unknown error"}`, "warning")
      }
    } else confirming = undefined
    const directory = choice?.directory ?? (from.remote && typed.startsWith("/") ? typed : undefined)
    if (!directory) return say(looksLikePath(typed) ? "that is not a directory" : "no folder picked · type a name or a path", "warning")
    close(false)
    await from.start(directory)
  }

  /** A click on a row. */
  async function activate(id: string) {
    const index = id.startsWith("pick:") ? Number(id.slice("pick:".length)) : Number.NaN
    const row = choices[index]
    if (!Number.isInteger(index) || !row) return
    await settled()
    // The rows were rebuilt for a newer query while the click waited: the row that was clicked is no longer there.
    const now = choices[index]
    if (!now || now.kind !== row.kind || now.directory !== row.directory) return
    // The clicked row becomes the picked one first, so a creation row's confirmation (drawn only on the picked row) is the one the next click confirms.
    selected = index
    await start()
  }

  /** What Tab and `→` put in the field to go into a row: a directory's path, the root of `Browse folders…`; nothing for a hub folder or a folder to create. */
  const enterTarget = (choice: FolderChoice | undefined) => !choice || choice.hub || choice.kind === "create" ? undefined : choice.typed ?? `${choice.detail.replace(/\/+$/, "")}/`

  /** The picker's keys; false for a key it leaves to the screen (the mouse). */
  async function key(key: string): Promise<boolean> {
    if (!request) return false
    if (key.startsWith("\x1b[<")) return false
    // Rows of an older query (a pasted path still being read) are never acted on: the key waits for the newest rows.
    await settled()
    if (!request) return true
    const arrow = APPLICATION_ARROWS[key] ?? key
    const waiting = confirming !== undefined
    if (key !== "\r") confirming = undefined
    if (key === "\x1b" || key === "\x03") { if (waiting) requestFrame(); else close(true) }
    else if (arrow === "\x1b[A" || key === "\x10") selected = choices.length ? (selected - 1 + choices.length) % choices.length : 0
    else if (arrow === "\x1b[B" || key === "\x0e") selected = choices.length ? (selected + 1) % choices.length : 0
    else if (key === "\r") await start()
    else if (key === "\t") {
      // Tab completes the typed name, then walks into the picked directory, as it does after `/cd`; on a known folder it puts its path in the field to go on from.
      const choice = choices[selected]
      if (browsing()) {
        const { head, partial } = parseBrowse(query.trim())
        const picked = choice?.kind === "path" && choice.typed !== undefined ? lastSegment(choice.directory) : undefined
        const next = completeTab({ head, partial, prefixed, picked })
        if (next !== undefined) await setQuery(next)
      } else {
        const next = enterTarget(choice)
        if (next !== undefined) await setQuery(next)
      }
    } else if (arrow === "\x1b[C") {
      const next = enterTarget(choices[selected])
      if (next !== undefined) await setQuery(next)
    } else if (arrow === "\x1b[D") {
      const up = browsing() ? goUp({ typed: query, home: request.home }) : undefined
      if (up !== undefined) await setQuery(up, lastSegment(query))
    } else if (key === "\x7f" || key === "\b") {
      if (!query) close(true)
      else {
        const erased = browsing() ? eraseBack({ typed: query, home: request.home }) : undefined
        if (erased !== undefined) await setQuery(erased, lastSegment(query))
        else await setQuery(Array.from(query).slice(0, -1).join(""))
      }
    } else if (key === "\x15") await setQuery("")
    else if (key === "\x17") await setQuery(query.replace(/[^/\s]*[/\s]*$/, ""))
    else if (PRINTABLE.test(key)) await setQuery(query + key)
    requestFrame()
    return true
  }

  /** A bracketed paste while the picker is open: one line added to the field (a path, usually). False when it is not open. */
  function paste(text: string): boolean {
    if (!request) return false
    const line = text.replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim()
    if (line) void setQuery(query + line)
    requestFrame()
    return true
  }

  /** The sidebar's rows while the picker is open; undefined once it is not (another page, or a click that gave the prompt the keyboard, ends it). */
  function draw(options: { height: number; width: number; ascii: boolean }): { lines: Line[]; hits: Array<{ row: number; id: string }> } | undefined {
    if (!request) return undefined
    if (!state.sidebarFocus || state.page !== "chat") return void close(false)
    const waiting = confirming !== undefined && choices[selected]?.kind === "create" && choices[selected]?.directory === confirming
    const drawn = renderNewChatPicker({ title: request.title, query, choices, selected, width: options.width, height: options.height, ascii: options.ascii, confirming: waiting, browsing: browsing() })
    return { lines: drawn.rows, hits: drawn.hits }
  }

  return { isOpen: () => request !== undefined, show, close, key, paste, activate, draw, query: () => query, choices: () => choices }
}
