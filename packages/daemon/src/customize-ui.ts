import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, watch, writeFileSync } from "node:fs"
import { watchTree } from "./watch-tree"
import path from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { TUI_DEFAULTS, TuiProfilePatch, describeProfileKey, findProfileKeys } from "@mendcode/protocol"
import type { GlobalEventDraft } from "@mendcode/kernel"
import { defineTool, fail } from "@mendcode/tools"
import { createTuiControl } from "./tui-control"
import { PROGRAM_NAME } from "@mendcode/program"

export type UiReloadReport = { revision: number; errors: string[]; terminalValidation: "complete" | "pending" }
export const CustomizeUiArgs = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keys"), query: z.string().max(200).optional() }),
  z.strictObject({ action: z.literal("settings"), values: TuiProfilePatch }),
  z.strictObject({ action: z.literal("write"), file: z.string().max(128), content: z.string().max(65536) }),
  z.strictObject({ action: z.literal("edit"), file: z.string().max(128), old: z.string().min(1).max(65536), new: z.string().max(65536) }),
  z.strictObject({ action: z.literal("reload") }),
])

export function writeUiExtension(dir: string, file: string, content: string, edit?: { old: string; new: string }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.(?:ts|js)$/.test(file)) throw new Error("Use a flat .ts or .js filename under user extensions; paths are forbidden")
  const data = realpathSync(dir)
  const root = path.join(data, "extensions")
  if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) throw new Error("User extensions must be a real directory, not a symlink")
  mkdirSync(root, { recursive: true })
  if (realpathSync(root) !== root) throw new Error("Extensions directory escaped the data directory")
  const target = path.join(root, file)
  let output = content
  if (existsSync(target) || (() => { try { lstatSync(target); return true } catch { return false } })()) {
    const entry = lstatSync(target)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("Extension target must be a regular unlinked file")
    const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error("Invalid extension file")
      if (edit) {
        const current = readFileSync(descriptor, "utf8")
        if (current.split(edit.old).length !== 2) throw new Error("Edit old text must occur exactly once")
        output = current.replace(edit.old, edit.new)
      }
    } finally { closeSync(descriptor) }
  } else if (edit) throw new Error("Cannot edit a missing extension")
  if (Buffer.byteLength(output) > 65536) throw new Error("Extension exceeds 64 KiB")
  const temporary = path.join(root, `${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(descriptor, output) } finally { closeSync(descriptor) }
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error("Extensions directory changed during write")
  renameSync(temporary, target)
  return target
}

function safeProfileStorage(dir: string) {
  for (const relative of ["tui", "tui/profile.json", "tui/backups"]) {
    const target = path.join(dir, relative)
    let entry
    try { entry = lstatSync(target) } catch { continue }
    if (entry.isSymbolicLink() || entry.isFile() && entry.nlink !== 1) throw new Error("TUI settings storage must not contain links")
  }
}

const realHome = (home: string) => { try { return realpathSync(home) } catch { return path.resolve(home) } }

/**
 * A project that holds the data directory could ship the UI code this tool then loads. The user's home folder (or a folder
 * above it) is not such a project: a session opened there is the user's own, and the data directory lives in it by default.
 */
export function outsideProject(dir: string, directory: string, home = homedir()) {
  const project = realpathSync(directory)
  const above = path.relative(project, realHome(home))
  if (!above || !above.startsWith("..") && !path.isAbsolute(above)) return
  const relative = path.relative(project, realpathSync(dir))
  if (!relative || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("User UI data must be outside the project directory")
}

/** At most this many project folders (`.mendcode`, `.claude`, `.agents` of trusted projects) are watched at once. */
export const MAX_WATCHED_PROJECT_FOLDERS = 16
const PROJECT_FOLDERS = [".mendcode", ".claude", ".agents"]
/**
 * Paths whose change reloads: extension modules, and skills, commands and agents (markdown), in a layer's own folders and in
 * its packages (`packages/<name>/…`). Anything else under a watched folder (databases, logs, scratch files) is ignored.
 */
export const RELOAD_PATH = /(?:^|\/)(?:extensions\/(?:[^/]+\/)*[^/]+\.(?:ts|js)|(?:skills|commands|command|agents)\/(?:[^/]+\/)*[^/]+\.md)$/
const RELOAD_FOLDERS = new Set(["extensions", "skills", "commands", "command", "agents"])
const KEYBINDINGS_FILE = "keybindings.json"

/** The directories of a layer that can hold a reloading file: `packages`, each `packages/<name>`, and the reload folders of the layer and of every package, at any depth. */
export function reloadDescends(relative: string): boolean {
  const parts = relative.split("/")
  if (parts[0] === "packages") {
    if (parts.length <= 2) return true
    parts.splice(0, 2)
  }
  return RELOAD_FOLDERS.has(parts[0]!)
}

/**
 * How a layer's folder is watched. `native` is `fs.watch(…, { recursive: true })`, which macOS and Windows implement for a whole
 * subtree; `tree` watches the relevant directories one by one (watch-tree.ts), which is what inotify needs: Linux defaults to it,
 * and `MENDCODE_UI_WATCH=native|tree` overrides the choice.
 */
export type UiWatchMode = "native" | "tree"
export function defaultUiWatchMode(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): UiWatchMode {
  const forced = env.MENDCODE_UI_WATCH
  if (forced === "native" || forced === "tree") return forced
  return platform === "linux" ? "tree" : "native"
}

function watchReloadRoot({ root, mode, onChange, onError }: { root: string; mode: UiWatchMode; onChange: (relative: string | undefined) => void; onError: () => void }): { close(): void } {
  if (mode === "tree") return watchTree({ root, descend: reloadDescends, onChange })
  const native = watch(root, { recursive: true }, (_event, filename) => onChange(filename ? String(filename).replaceAll("\\", "/") : undefined))
  native.on("error", onError)
  return native
}

export function createUiReload(input: {
  dir: string
  emit: (event: GlobalEventDraft) => void
  load: (directory: string) => Promise<string[]>
  /** Projects whose own folders are watched too: the daemon offers the ones trusted for project resources, never an untrusted one. */
  projects?: () => string[]
  watchMode?: UiWatchMode
}) {
  const watchMode = input.watchMode ?? defaultUiWatchMode()
  let revision = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: { close(): void } | undefined
  const projectWatchers = new Map<string, { watcher: { close(): void }; project: string }>()
  const changed = new Set<string>()
  let chain = Promise.resolve()
  const clients = new Map<object, number>()
  const waiters = new Map<number, { remaining: Set<object>; errors: string[]; finish: () => void }>()
  function report(client: object, generation: number, errors: string[]) {
    clients.set(client, Date.now())
    const pending = waiters.get(generation)
    if (!pending || !pending.remaining.delete(client)) return
    pending.errors.push(...errors)
    if (!pending.remaining.size) pending.finish()
  }
  async function perform(directory: string): Promise<UiReloadReport> {
    if (stopped) throw new Error("Extension reload service stopped")
    const errors = await input.load(directory)
    const generation = ++revision
    const remaining = new Set(clients.keys())
    let complete = false
    if (remaining.size) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => finish(), 1000)
        const finish = () => {
          complete = remaining.size === 0
          clearTimeout(timeout)
          waiters.delete(generation)
          resolve()
        }
        waiters.set(generation, { remaining, errors, finish })
        input.emit({ type: "extensions.changed", revision: generation })
      })
    } else input.emit({ type: "extensions.changed", revision: generation })
    return { revision: generation, errors: [...new Set(errors)].slice(0, 64), terminalValidation: complete ? "complete" : "pending" }
  }
  function reload(directory: string) {
    const pending = chain.then(() => perform(directory))
    chain = pending.then(() => {}, () => {})
    return pending
  }
  /** One debounce for every watcher: a burst of edits (a git checkout, an editor's save dance) is one reload per directory. */
  function schedule(directory: string) {
    changed.add(directory)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const directories = [...changed]
      changed.clear()
      for (const target of directories) void reload(target).catch(() => {})
    }, 80)
  }
  function watchFolder(folder: string, project: string) {
    try {
      const folderWatcher = watchReloadRoot({
        root: folder,
        mode: watchMode,
        onChange: (relative) => {
          if (relative && !RELOAD_PATH.test(relative)) return
          schedule(project)
        },
        onError: () => { folderWatcher.close(); projectWatchers.delete(folder) },
      })
      projectWatchers.set(folder, { watcher: folderWatcher, project })
    } catch { /* A folder that vanished between the check and the watch is picked up by the next sync. */ }
  }
  /** Makes the watched project folders match `projects()`: new ones start, ones no longer offered (trust withdrawn) stop. Bounded. */
  function sync() {
    if (stopped || !watcher) return
    const wanted = new Map<string, string>()
    for (const project of input.projects?.() ?? []) {
      for (const name of PROJECT_FOLDERS) {
        const folder = path.join(project, name)
        if (wanted.size < MAX_WATCHED_PROJECT_FOLDERS && !wanted.has(folder) && existsSync(folder)) wanted.set(folder, project)
      }
    }
    for (const [folder, entry] of projectWatchers) if (!wanted.has(folder)) { entry.watcher.close(); projectWatchers.delete(folder) }
    for (const [folder, project] of wanted) if (!projectWatchers.has(folder)) watchFolder(folder, project)
  }
  function start() {
    if (watcher || stopped) return
    watcher = watchReloadRoot({
      root: input.dir,
      mode: watchMode,
      onChange: (relative) => {
        // `keybindings.json` of the data dir: the terminal reads it again on the same `extensions.changed`, so an edited key is live.
        if (relative && !RELOAD_PATH.test(relative) && relative !== KEYBINDINGS_FILE) return
        schedule(input.dir)
      },
      onError: () => { watcher?.close(); watcher = undefined },
    })
    sync()
  }
  return {
    reload, report, start, sync,
    /** Folders under watch: the data dir plus the project folders. */
    watching: () => (watcher ? 1 : 0) + projectWatchers.size,
    forget: (client: object) => {
      clients.delete(client)
      for (const pending of waiters.values()) if (pending.remaining.delete(client) && !pending.remaining.size) pending.finish()
    },
    exportLook: async (directory: string) => {
      outsideProject(input.dir, directory)
      safeProfileStorage(input.dir)
      const profile = createTuiControl(input.dir).run({ operation: "profile" }).profile
      const file = `look-${randomUUID()}.ts`
      const target = writeUiExtension(input.dir, file, `export default { name: ${JSON.stringify(file.slice(0, -3))}, tui(api) { api.settings.set(${JSON.stringify(profile, null, 2)}) } }\n`)
      return { file: target, ...await reload(directory) }
    },
    stop: () => {
      stopped = true
      clearTimeout(timer)
      watcher?.close()
      for (const entry of projectWatchers.values()) entry.watcher.close()
      projectWatchers.clear()
      for (const pending of waiters.values()) pending.finish()
      clients.clear()
    },
  }
}

const FOOTER_SLOT = /["'`]footer\.(?:replace|left|right)["'`]/

/**
 * What a model must hear after it set `footerRows`: a `text:<name>` with no `footerText` entry draws nothing. Read from the saved profile.
 */
export function footerRowNotes(profile: Record<string, unknown>): string[] {
  const rows = Array.isArray(profile.footerRows) ? (profile.footerRows as unknown[]).flat().filter((entry): entry is string => typeof entry === "string") : []
  if (!rows.length) return []
  const texts = profile.footerText && typeof profile.footerText === "object" ? Object.keys(profile.footerText) : []
  const notes = rows.filter((entry) => entry.startsWith("text:") && !texts.includes(entry.slice(5))).map((entry) => `${entry} draws nothing: footerText has no "${entry.slice(5)}"${texts.length ? ` (it has ${texts.join(", ")})` : ""}; set footerText {"${entry.slice(5)}":"..."}`)
  return notes
}

/**
 * The user extensions that fill a footer slot and are still on, by the name `/extensions` switches them with (the name the module
 * declares, the file's name when it declares none). They draw over or beside `footerRows`, so setting rows switches them off.
 */
export function footerExtensions(dir: string, profile: Record<string, unknown>): string[] {
  const disabled = Array.isArray(profile.disabledUiExtensions) ? profile.disabledUiExtensions.filter((entry): entry is string => typeof entry === "string") : []
  const found: string[] = []
  const root = path.join(dir, "extensions")
  let files: string[] = []
  try { files = readdirSync(root).filter((name) => /\.(?:ts|js)$/.test(name)).sort().slice(0, 64) } catch { /* no user extensions */ }
  for (const name of files) {
    let source = ""
    try { const stat = lstatSync(path.join(root, name)); if (stat.isFile() && stat.size <= 65536) source = readFileSync(path.join(root, name), "utf8") } catch { continue }
    if (!FOOTER_SLOT.test(source)) continue
    const id = /\bname:\s*["'`]([^"'`]{1,100})["'`]/.exec(source)?.[1] ?? name.replace(/\.(?:ts|js)$/, "")
    if (!disabled.includes(id) && !found.includes(id)) found.push(id)
  }
  return found
}

/**
 * What the model reads, in every balanced and full request (it is listed without a search there): what nearly every request needs (find
 * a key, set it) comes first, the extension contract is one line and the rest of it is `mendcode docs extensions`.
 */
export const CUSTOMIZE_UI_DESCRIPTION = [
  "Change what the user sees in this MendCode terminal (their screen, not project code): any bar, panel, sidebar, prompt box, footer, message label, start screen, logo, scroll button, thinking block, theme or color. A request about one of those means this terminal unless the user names project files: apply it yourself now; never tell the user to do it.",
  "keys: query is a few English words for the part (\"top bar\", \"footer\", \"prompt border\"); returns the matching keys: what each changes, type, values, default, current value. Use it when unsure of a key.",
  "settings: values {key: value}, applied live, e.g. {\"showTopbar\":false} removes the whole row above a session ({\"contextBar\":\"off\"} only its context bar; the start screen's first row is homeHeader: change only the part asked for), {\"panelHeader\":false} the panel's first row, {\"showStatus\":false} the footer, {\"promptBorder\":\"rounded\"}, {\"theme\":\"paper\"}. A bad key or value changes nothing, names the nearest keys. quotaRefresh spends real quota: only when asked.",
  `write/edit/reload: code, only for what no key does: a module in <data dir>/extensions (write: flat name.ts|js and the whole content; edit: file, old unique literal, new), run with the user's privileges after approval. Contract: export default {name:'unique',tui(api){...}}; api.settings.set(key,value), api.messageStyle(role,{icon,label,lead}), api.renderMessage(role,fn), api.slot(name,ctx=>lines), api.view(slot,fn), api.widget, api.page; lines are arrays of spans {text,fg,bg,bold,dim}. Read ${PROGRAM_NAME} docs extensions before writing one. Result errors: fix with edit, then reload.`,
].join("\n")

/** `keys`: the keys a query names (or every key name without one), each with what it changes and its values now. */
export function profileKeysReport(profile: Record<string, unknown>, query: string | undefined) {
  const found = query?.trim() ? findProfileKeys(query, 8) : []
  if (found.length) return { keys: found.map((key) => describeProfileKey(key, profile)), next: "customize_ui settings with the key that fits; call keys again with other words if none does" }
  return { ...(query?.trim() ? { none: `no key matches "${query}"` } : {}), names: Object.keys(TUI_DEFAULTS), next: "call keys with words for the part to see what a key changes" }
}

export function createCustomizeUiTool(dir: string, reload: (directory: string) => Promise<UiReloadReport>, emit: (event: GlobalEventDraft) => void) {
  return defineTool({
    name: "customize_ui",
    permission: "write",
    description: CUSTOMIZE_UI_DESCRIPTION,
    args: CustomizeUiArgs,
    // Looking keys up changes nothing: it never waits for an approval.
    permissionFor: (args) => (args.action === "keys" ? "read" : "write"),
    async execute(action, ctx) {
      try {
        if (action.action === "keys") {
          safeProfileStorage(dir)
          return { title: "Customize UI keys", output: JSON.stringify(profileKeysReport(createTuiControl(dir).run({ operation: "profile" }).profile as Record<string, unknown>, action.query)), truncated: false, isError: false }
        }
        outsideProject(dir, ctx.cwd)
        let file: string | undefined
        let notes: string[] = []
        if (action.action === "settings") {
          safeProfileStorage(dir)
          const result = createTuiControl(dir).run({ operation: "apply", profile: action.values })
          emit({ type: "tui.changed", profile: result.profile as Record<string, never> })
          let profile = result.profile as Record<string, unknown>
          // Rows the caller just set are what the user asked to see: a user extension that draws the footer would cover them, so it
          // is switched off in the same call (the file stays, /extensions turns it back on) and the result says so.
          const inTheWay = Array.isArray(action.values.footerRows) && action.values.footerRows.length && !("disabledUiExtensions" in action.values) ? footerExtensions(dir, profile) : []
          if (inTheWay.length) {
            const off = [...(Array.isArray(profile.disabledUiExtensions) ? profile.disabledUiExtensions as string[] : []), ...inTheWay]
            profile = createTuiControl(dir).run({ operation: "apply", profile: { disabledUiExtensions: off } }).profile as Record<string, unknown>
            emit({ type: "tui.changed", profile: profile as Record<string, never> })
            notes.push(`switched off extension ${inTheWay.join(", ")}: it drew the footer over these rows. Its file stays; the user turns it back on in /extensions. Tell the user.`)
          }
          if ("footerRows" in action.values || "footerText" in action.values) notes.push(...footerRowNotes(profile))
        } else if (action.action === "write" || action.action === "edit") {
          file = writeUiExtension(dir, action.file, action.action === "write" ? action.content : "", action.action === "edit" ? { old: action.old, new: action.new } : undefined)
        }
        const result = await reload(ctx.cwd)
        return { title: "Customize UI", output: JSON.stringify({ ...(file ? { file } : {}), ...result, ...(notes.length ? { notes } : {}) }), truncated: false, isError: result.errors.length > 0 }
      } catch (error) { return fail({ title: "customize_ui", message: String(error) }) }
    },
  })
}
