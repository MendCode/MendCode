import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { EXTENSION_API_VERSION, HOOK_TIMEOUT_MS } from "@mendcode/extension-api"
import { preflightModule } from "@mendcode/extension-api/preflight"
import type { Extension, MessageStyle, MessageRole, MessageData, MessageRenderer, MarkdownTransformer, PromptChrome, PromptRenderer, PromptContext, PendingComment, ExtensionWidget, ExtensionPage, ExtensionModal, SlotContext, SlotName, SlotRenderer, ToolRenderer, TuiActions, TuiExtensionAPI } from "@mendcode/extension-api"
import { FOOTER_ROWS_MAX, tuiProblems, type PrecedenceClaim, type PrecedenceSurface } from "@mendcode/protocol/wire"
import { activeTheme, type Line, type Span } from "../ui/theme"
import { clean, themeLines } from "./sanitize"
import { clip, fit } from "../view/deck"
import type { ExtensionFile, ExtensionSource } from "./discover"
import type { ToolView } from "./hooks"
import { toolMatch, type ToolArgs } from "./tool-args"
import { parseKeySpec, type ExtensionKey } from "./keybindings"
import { adaptRowPlugin } from "./plugin-adapter"
import { isViewSlot, VIEW_SLOT_NAMES, type ViewSlot } from "@mendcode/extension-api/views"
import { createViewRegistry, type ViewRegistry } from "./views"
import type { CustomViews } from "../view/views"
import type { SessionStats, UsageSnapshot } from "@mendcode/extension-api"
import { computeSessionStats, EMPTY_USAGE } from "../view/session-stats"
import { NO_USAGE } from "../view/usage-snapshot"

/** What `api.stats()` answers when the app gave the runtime no stats source (tests, a headless load). */
/** How long a reload waits for the disposers of the copy it replaces (a process an extension stops) before the new copy starts. */
export const DISPOSE_WAIT_MS = 2_000
const NO_STATS: SessionStats = computeSessionStats({ usage: EMPTY_USAGE })

/**
 * The terminal half of the extension contract: loads `tui(api)` of each module, keeps what it registers and draws it
 * safely. Loaded with a dynamic import, and only when extension files exist, so a terminal without extensions never
 * parses this module. Every call into extension code is wrapped: a slot, tool renderer, transform or page that throws
 * is disabled for the session and reported once; it never reaches the frame.
 */

export const SLOT_NAMES: ReadonlySet<string> = new Set<SlotName>([
  "header.replace", "footer.replace", "footer.left", "footer.right", "welcome.replace", "welcome.below", "prompt.above", "prompt.below", "prompt.replace", "working.replace",
])
/** These slots take the place of what MendCode draws (the last extension that answers wins); the rest add to it. */
const REPLACE_SLOTS: ReadonlySet<string> = new Set<SlotName>(["header.replace", "footer.replace", "welcome.replace", "working.replace", "prompt.replace"])
/** Rows an extension's footer slot may return: the ceiling `footerRows` shares (the footer then cuts them to a quarter of the terminal's height). */
export const MAX_FOOTER_ROWS = FOOTER_ROWS_MAX
const MESSAGE_ROLES = new Set<string>(["user", "assistant", "tool", "meta"])

const COMMAND_NAME = /^[a-z0-9][a-z0-9:_-]*$/i
const PAGE_ID = /^[\w.:-]+$/
/** A renderer's output is cut to this many rows before it is fitted, so a runaway list costs nothing. */
const MAX_ROWS = 200
const GAP: Span = { text: "  " }
/** A module whose import never settles is given up on, so one extension cannot hold the whole load. */
const IMPORT_TIMEOUT_MS = 10_000

export type ExtensionProblem = { extension: string; message: string }
export type ExtensionConflictNote = { winner: string; loser: string; message: string }
/** What one extension registered in the terminal: slot names, key specs, `/commands`, page and modal ids, actions, tool renderers, markdown transforms. */
export type TerminalRegistration = { name: string; slots: string[]; keys: string[]; commands: string[]; pages: string[]; modals?: string[]; actions?: string[]; renderers: string[]; transforms: number }
export type LoadedExtension = { name: string; file: string; source: ExtensionSource; pkg?: string; tui: boolean; daemon: boolean; enabled?: boolean }

type Owned = { owner: string; disabled: boolean }
type SlotEntry = Owned & { name: SlotName; render: SlotRenderer }
type ToolEntry = Owned & { tool: string; render: ToolRenderer }
type MessageStyleEntry = Owned & { role: MessageRole; style: MessageStyle }
type MarkdownEntry = Owned & { role: MessageRole; transform: MarkdownTransformer }
type CommandEntry = { owner: string; name: string; description: string; run: (args: string, actions: TuiActions) => void }
type PageEntry = Owned & { id: string; page: ExtensionPage }
type ModalEntry = Owned & { id: string; modal: ExtensionModal }
type ActionEntry = { owner: string; id: string; title: string; description: string; run: (actions: TuiActions) => void }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160)

/** A short single-line label (a command summary, a page title). */
const oneLine = (text: unknown) => clean(text).trim().slice(0, 120)

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took longer than ${ms} ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** What the file is called in a problem line: the folder of `name/index.ts`, else the file without its extension. */
function labelOf(file: string) {
  const base = path.basename(file)
  return /^index\.(ts|js)$/.test(base) ? path.basename(path.dirname(file)) : base.replace(/\.(ts|js)$/, "")
}

export type ExtensionRuntimeOptions = {
  /** Schedules a frame (the app coalesces them). */
  redraw(): void
  /** A problem was recorded (load failure, a renderer disabled…); the app shows a toast once per extension. */
  onProblem?(problem: ExtensionProblem): void
  /** Registrations or disabled renderers changed what the transcript and the keymap should do. */
  onChange?(): void
  /** Built-in `/command` names; an extension command with one of them is ignored. */
  reservedCommands?: ReadonlySet<string>
  /** How a module is imported; tests and the loader both use the default. */
  importModule?(url: string): Promise<unknown>
  /** How long `tui(api)` may take before the extension is given up on (HOOK_TIMEOUT_MS by default). */
  timeoutMs?: number
  settings?: { get(key?: string): unknown; set(values: Record<string, unknown>): void }
  /** The live session stats `api.stats()` and `api.onStats()` read (the app's stats hub); without it `stats()` is the empty snapshot and `onStats` never fires. */
  stats?: { read(): SessionStats; subscribe(listener: (stats: SessionStats) => void): () => void }
  /** What `api.usage()` reads (context, tokens, provider quota); without it `usage()` answers that nothing is known. */
  usage?: { read(): UsageSnapshot }
  disabled?: readonly string[]
  revision?: number
  navigate?(id: string): void
  plugin?: import("./plugin-adapter").RowPluginContext
}

export function createExtensionRuntime(options: ExtensionRuntimeOptions) {
  const reserved = options.reservedCommands ?? new Set<string>()
  const importModule = options.importModule ?? ((url: string) => import(url))
  const loaded: LoadedExtension[] = []
  const problems: ExtensionProblem[] = []
  /** Modules that could not be used (import error, wrong shape, `tui()` threw): the candidate of a reload is judged by these. */
  const failed: Array<{ file: string; extension: string; message: string }> = []
  /** An extension command, page or name that another extension replaced; `winner` is the one still working. */
  const conflicts: ExtensionConflictNote[] = []
  const seen = new Set<string>()
  const slots: SlotEntry[] = []
  const tools: ToolEntry[] = []
  const markdowns: MarkdownEntry[] = []
  const messageStyles: MessageStyleEntry[] = []
  const messages: Array<Owned & { role: MessageRole; render: MessageRenderer }> = []
  const prompts: Array<Owned & { render: PromptRenderer }> = []
  const chrome: Array<Owned & { value: PromptChrome }> = []
  const widgets: Array<Owned & { surface: "tray" | "sidebar"; id: string; widget: ExtensionWidget }> = []
  const commentTransforms: Array<Owned & { transform: (message: string, context: { readonly comments: readonly PendingComment[]; readonly note: string }) => string | undefined }> = []
  const disposers: Array<{ owner: string; dispose(): void | Promise<void> }> = []
  const starters: Array<{ owner: string; start(): void }> = []
  let started = false
  const keys: ExtensionKey[] = []
  const commands: CommandEntry[] = []
  const pages: PageEntry[] = []
  const modals: ModalEntry[] = []
  const actionEntries: ActionEntry[] = []
  /** Everything an extension registered that another one could also register, for the precedence report. Resolved by `claims()` from the load order. */
  const claimed: Array<{ surface: PrecedenceSurface; name: string; owner: string }> = []
  const viewRegistry = createViewRegistry({ problem: (owner, text) => problem(owner, text), changed: () => changed() })
  let generation = 0
  let loading = false
  let disposed = false
  const theme = () => Object.freeze({ name: activeTheme().name, colors: Object.freeze({ ...activeTheme().colors }) })
  const context = (message: MessageData, width: number) => Object.freeze({ message: Object.freeze({ ...message, ...(message.meta ? { meta: Object.freeze({ ...message.meta }) } : {}) }), width, theme: theme() })

  function problem(extension: string, message: string) {
    const entry = { extension, message }
    problems.push(entry)
    options.onProblem?.(entry)
  }

  /** A module that cannot be used: a problem, and a failure the app weighs before it swaps this runtime in. */
  function broken(file: ExtensionFile, extension: string, message: string) {
    failed.push({ file: file.file, extension, message })
    problem(extension, message)
  }

  function changed() {
    generation++
    if (!loading) {
      options.onChange?.()
      options.redraw()
    }
  }

  /** Runs extension code; a throw disables the entry (when it has a flag) and records one problem. */
  function guard<T>(entry: { owner: string; disabled?: boolean }, what: string, work: () => T): T | undefined {
    try {
      return work()
    } catch (error) {
      if (entry.disabled === false) entry.disabled = true
      generation++
      problem(entry.owner, `${what} ${entry.disabled === undefined ? "failed" : "disabled"}: ${messageOf(error)}`)
      // The entry is gone from this frame on; the app repaints without it.
      options.onChange?.()
      return undefined
    }
  }

  function removeOwner(owner: string) {
    for (let index = starters.length - 1; index >= 0; index--) if (starters[index]!.owner === owner) starters.splice(index, 1)
    for (let index = disposers.length - 1; index >= 0; index--) if (disposers[index]!.owner === owner) {
      const entry = disposers.splice(index, 1)[0]!
      guard(entry, "dispose", entry.dispose)
    }
    viewRegistry.removeOwner(owner)
    for (let i = claimed.length - 1; i >= 0; i--) if (claimed[i]!.owner === owner) claimed.splice(i, 1)
    for (const list of [slots, tools, markdowns, pages, modals, messageStyles, messages, prompts, chrome, widgets, commentTransforms] as Owned[][])
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.owner === owner) list.splice(i, 1)
    for (const list of [keys, commands, actionEntries] as Array<Array<{ owner: string }>>) for (let i = list.length - 1; i >= 0; i--) if (list[i]!.owner === owner) list.splice(i, 1)
  }

  function makeApi(owner: string, dir: string): TuiExtensionAPI {
    const fail = (message: string): never => {
      throw new TypeError(`[EXT]: ${message}`)
    }
    let accepting = true
    let alive = true
    const pendingSettings: Record<string, unknown> = {}
    function get(): Record<string, unknown>
    function get(key: string): unknown
    function get(key?: string): unknown {
      return key === undefined ? { ...(options.settings?.get() as Record<string, unknown> ?? {}), ...pendingSettings } : Object.hasOwn(pendingSettings, key) ? pendingSettings[key] : options.settings?.get(key)
    }
    const check = () => { if (disposed || !accepting) fail("registration after tui() settled") }
    const set = (key: string | Record<string, unknown>, value?: unknown) => {
      if (disposed || !alive) fail("extension was disposed or failed")
      const patch = typeof key === "string" ? { [key]: value } : key
      const errors = tuiProblems(patch)
      if (errors.length) fail(errors.join("; "))
      if (!options.settings) fail("settings are unavailable")
      if (accepting) Object.assign(pendingSettings, patch)
      else options.settings!.set(patch)
    }
    const api: TuiExtensionAPI = {
      version: EXTENSION_API_VERSION,
      dir,
      slot(name, render) {
        check()
        if (!SLOT_NAMES.has(name) && !/^sidebar:[a-zA-Z0-9_-]+$/.test(name)) fail(`unknown slot "${String(name)}"`)
        if (typeof render !== "function") fail(`slot ${name} needs a function`)
        slots.push({ owner, name, render, disabled: false })
        changed()
      },
      renderTool(tool, render) {
        check()
        if (typeof tool !== "string" || !tool) fail("renderTool needs a tool name")
        if (tool.indexOf("*") !== -1 && tool.indexOf("*") !== tool.length - 1) fail(`renderTool ${tool}: "*" may only end the name ("mcp__*", "*")`)
        if (typeof render !== "function") fail(`renderTool ${tool} needs a function`)
        tools.push({ owner, tool, render, disabled: false })
        changed()
      },
      messageStyle(role, style) {
        check()
        if (!MESSAGE_ROLES.has(role)) fail("unknown message role")
        if (!style || typeof style !== "object") fail("messageStyle needs an object")
        const safe: MessageStyle = {}
        for (const field of ["icon", "lead"] as const) if (typeof style[field] === "string") safe[field] = oneLine(style[field]).slice(0, 4)
        for (const field of ["label", "tint"] as const) if (typeof style[field] === "boolean") safe[field] = style[field]
        if (typeof style.label === "string") safe.label = oneLine(style.label)
        if (style.layout === "quiet" || style.layout === "classic") safe.layout = style.layout
        messageStyles.push({ owner, role, style: safe, disabled: false })
        changed()
      },
      renderMessage(role, render) {
        check()
        if (!MESSAGE_ROLES.has(role) || typeof render !== "function") fail("renderMessage needs a role and function")
        messages.push({ owner, role, render, disabled: false })
        changed()
      },
      markdown(roleOrTransform: MessageRole | ((text: string) => string), renderer?: MarkdownTransformer) {
        check()
        const role = typeof roleOrTransform === "function" ? "assistant" : roleOrTransform
        const transform = typeof roleOrTransform === "function" ? roleOrTransform : renderer
        if (!MESSAGE_ROLES.has(role)) fail("unknown markdown role")
        if (typeof transform !== "function") fail("markdown needs a function")
        markdowns.push({ owner, role, transform: transform!, disabled: false })
        changed()
      },
      prompt: {
        replace(render) {
          check()
          if (typeof render !== "function") fail("prompt.replace needs a function")
          prompts.push({ owner, render, disabled: false })
          changed()
        },
        chrome(value) {
          check()
          if (!value || typeof value !== "object") fail("prompt.chrome needs an object")
          const patch = { ...(value.lead !== undefined ? { promptLead: value.lead } : {}), ...(value.border !== undefined ? { promptBorder: value.border } : {}), ...(value.preset !== undefined ? { promptChrome: value.preset } : {}) }
          if (tuiProblems(patch).length) fail("invalid prompt chrome")
          chrome.push({ owner, value: { ...value, ...(value.lead !== undefined ? { lead: oneLine(value.lead) } : {}) }, disabled: false })
          changed()
        },
      },
      widget(surface, id, widget) {
        check()
        if (!["tray", "sidebar"].includes(surface) || !/^[\w-]+$/.test(id) || typeof widget?.title !== "string" || typeof widget.render !== "function") fail("invalid widget")
        widgets.push({ owner, surface, id, widget: { title: oneLine(widget.title), render: widget.render }, disabled: false })
        claimed.push({ surface: "widgets", name: `${surface}:${id}`, owner })
        changed()
      },
      settings: { get, set },
      onDispose(dispose) { check(); if (typeof dispose !== "function") fail("onDispose needs a function"); disposers.push({ owner, dispose }) },
      onStart(start) { check(); if (typeof start !== "function") fail("onStart needs a function"); starters.push({ owner, start }) },
      key(key, run) {
        check()
        if (typeof run !== "function") fail("key needs a function")
        const parsed = parseKeySpec(String(key))
        if (!parsed.ok) return problem(owner, `key ${parsed.error}`)
        keys.push({ spec: String(key), run, owner })
        claimed.push({ surface: "keybindings", name: String(key).toLowerCase(), owner })
        changed()
      },
      command(name, description, run) {
        check()
        if (typeof run !== "function") fail("command needs a function")
        const command = String(name).replace(/^\//, "").toLowerCase()
        if (!COMMAND_NAME.test(command)) return problem(owner, `command "${String(name)}" is not a valid name`)
        if (reserved.has(command)) return problem(owner, `command /${command} is built in and cannot be replaced`)
        for (let i = commands.length - 1; i >= 0; i--) if (commands[i]!.name === command) {
          const [replaced] = commands.splice(i, 1)
          if (replaced!.owner !== owner) conflicts.push({ winner: owner, loser: replaced!.owner, message: `/${command} of ${replaced!.owner} is replaced by ${owner}, which loads later` })
        }
        commands.push({ owner, name: command, description: oneLine(description), run })
        claimed.push({ surface: "commands", name: `/${command}`, owner })
        changed()
      },
      page(id, page) {
        check()
        if (typeof id !== "string" || !PAGE_ID.test(id)) fail(`page id "${String(id)}" is not valid`)
        if (typeof page?.render !== "function" || typeof page.title !== "string") fail(`page ${id} needs a title and render()`)
        for (let i = pages.length - 1; i >= 0; i--) if (pages[i]!.id === id) {
          const [replaced] = pages.splice(i, 1)
          if (replaced!.owner !== owner) conflicts.push({ winner: owner, loser: replaced!.owner, message: `page ${id} of ${replaced!.owner} is replaced by ${owner}, which loads later` })
        }
        pages.push({ owner, id, page, disabled: false })
        claimed.push({ surface: "pages", name: id, owner })
        changed()
      },
      modal(id, modal) {
        check()
        if (typeof id !== "string" || !PAGE_ID.test(id)) fail(`modal id "${String(id)}" is not valid`)
        if (typeof modal?.render !== "function" || typeof modal.title !== "string") fail(`modal ${id} needs a title and render()`)
        if (modal.onKey !== undefined && typeof modal.onKey !== "function") fail(`modal ${id}: onKey must be a function`)
        if (modal.width !== undefined && typeof modal.width !== "function" && (typeof modal.width !== "number" || !Number.isFinite(modal.width) || modal.width <= 0)) fail(`modal ${id}: width must be a positive number or a function`)
        for (let i = modals.length - 1; i >= 0; i--) if (modals[i]!.id === id) {
          const [replaced] = modals.splice(i, 1)
          if (replaced!.owner !== owner) conflicts.push({ winner: owner, loser: replaced!.owner, message: `modal ${id} of ${replaced!.owner} is replaced by ${owner}, which loads later` })
        }
        modals.push({ owner, id, modal, disabled: false })
        claimed.push({ surface: "pages", name: `modal:${id}`, owner })
        changed()
      },
      action(id, run, settings) {
        check()
        if (typeof id !== "string" || !PAGE_ID.test(id)) fail(`action id "${String(id)}" is not valid`)
        if (typeof run !== "function") fail(`action ${id} needs a function`)
        for (let i = actionEntries.length - 1; i >= 0; i--) if (actionEntries[i]!.id === id) {
          const [replaced] = actionEntries.splice(i, 1)
          if (replaced!.owner !== owner) conflicts.push({ winner: owner, loser: replaced!.owner, message: `action ${id} of ${replaced!.owner} is replaced by ${owner}, which loads later` })
        }
        const title = typeof settings?.title === "string" && oneLine(settings.title) ? oneLine(settings.title) : id
        actionEntries.push({ owner, id, title, description: typeof settings?.description === "string" ? oneLine(settings.description) : "", run })
        claimed.push({ surface: "commands", name: `action:${id}`, owner })
        changed()
      },
      view(name: string, render: unknown) {
        check()
        const legacy = name === "slashMenu"
        const slot = legacy ? "slash.menu" : name
        if (!isViewSlot(slot)) fail(`unknown view slot "${String(name)}" (known: ${VIEW_SLOT_NAMES.join(", ")})`)
        if (typeof render !== "function") fail(`view ${String(name)} needs a function`)
        viewRegistry.register(owner, slot as ViewSlot, render as (input: never) => unknown, legacy)
        claimed.push({ surface: "views", name: slot, owner })
      },
      redraw() {
        if (!disposed) options.redraw()
      },
      comments: {
        beforeSend(transform) {
          check()
          if (typeof transform !== "function") fail("comments.beforeSend needs a function")
          commentTransforms.push({ owner, transform, disabled: false })
        },
      },
      stats: () => options.stats?.read() ?? NO_STATS,
      usage: () => options.usage?.read() ?? NO_USAGE,
      onStats(listener) {
        if (disposed || !alive) fail("extension was disposed or failed")
        if (typeof listener !== "function") fail("onStats needs a function")
        if (!options.stats) return () => {}
        const entry = { owner, disabled: false }
        const stop = options.stats.subscribe((stats) => {
          if (!entry.disabled && !disposed) guard(entry, "stats listener", () => listener(stats))
        })
        disposers.push({ owner, dispose: stop })
        return stop
      },
    }
    return Object.assign(api, { seal(success: boolean) {
      accepting = false
      alive = success
      if (success && Object.keys(pendingSettings).length) options.settings?.set({ ...pendingSettings })
      for (const key of Object.keys(pendingSettings)) delete pendingSettings[key]
    } })
  }

  async function loadOne(file: ExtensionFile) {
    const label = labelOf(file.file)
    let mod: unknown
    try {
      if (file.plugin?.error) throw new Error(file.plugin.error)
      if (!file.plugin && !options.importModule) {
        // A syntax error or a missing import is found without importing: the runtime would remember the failed import and refuse the fix.
        const bad = preflightModule(file.file)
        if (bad) throw new Error(bad)
      }
      if (options.revision !== undefined && !options.importModule) {
        const cache = createRequire(import.meta.url).cache
        for (const key of Object.keys(cache)) if (key === file.file || key.startsWith(file.dir + path.sep)) delete cache[key]
      }
      mod = await withTimeout(Promise.resolve(importModule(pathToFileURL(file.file).href + (options.revision === undefined ? "" : `?ui=${options.revision}`))), IMPORT_TIMEOUT_MS)
    } catch (error) {
      return broken(file, label, `failed to load: ${messageOf(error)}`)
    }
    const extension = (file.plugin ? adaptRowPlugin(mod as Record<string, unknown>, file, options.navigate, options.plugin) : (mod as { default?: unknown } | null)?.default) as Partial<Extension> | null | undefined
    if (typeof extension !== "object" || extension === null) return broken(file, label, "default export must be { name, tui? }")
    const name = typeof extension.name === "string" ? clean(extension.name).trim() : ""
    if (!name || name.length > 64) return broken(file, label, "extension needs a name (1-64 characters)")
    if (extension.tui !== undefined && typeof extension.tui !== "function") return broken(file, name, "tui must be a function")
    if (extension.daemon !== undefined && typeof extension.daemon !== "function") return broken(file, name, "daemon must be a function")
    if (seen.has(name)) return problem(name, `another extension is already called ${name}; ${label} skipped`)
    seen.add(name)
    const enabled = !options.disabled?.includes(name)
    if (enabled && typeof extension.tui === "function") {
      const api = makeApi(name, file.dir) as TuiExtensionAPI & { seal(success: boolean): void }
      try {
        // Only `tui` runs here; the daemon half belongs to the daemon.
        await withTimeout(Promise.resolve(extension.tui(api)), options.timeoutMs ?? HOOK_TIMEOUT_MS)
        api.seal(true)
      } catch (error) {
        api.seal(false)
        removeOwner(name)
        return broken(file, name, `tui() failed: ${messageOf(error)}`)
      }
    }
    loaded.push({ name, file: file.file, source: file.source, ...(file.pkg ? { pkg: file.pkg } : {}), tui: typeof extension.tui === "function", daemon: typeof extension.daemon === "function", enabled })
  }

  const loadedFiles = new Set<string>()

  return {
    loaded: loaded as readonly LoadedExtension[],
    problems: problems as readonly ExtensionProblem[],
    failed: failed as ReadonlyArray<{ file: string; extension: string; message: string }>,
    conflicts: conflicts as readonly ExtensionConflictNote[],
    /** Safe to call more than once: each disposer runs the first time only. */
    async dispose() {
      disposed = true
      starters.length = 0
      const pending = disposers.splice(0).map((entry) => guard(entry, "dispose", entry.dispose)).filter((result): result is Promise<void> => result instanceof Promise)
      viewRegistry.clear()
      claimed.length = 0
      for (const list of [slots, tools, markdowns, messageStyles, messages, prompts, chrome, widgets, keys, commands, pages, modals, actionEntries]) list.length = 0
      // An extension that stops a process waits for it; a stuck one does not hold the copy that replaces it for more than this.
      if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref?.())])
    },
    /** This copy is live (the one it replaced is disposed): what extensions asked to start now starts, once. */
    start() {
      if (started || disposed) return
      started = true
      for (const entry of starters.splice(0)) guard({ ...entry, disabled: false }, "start", entry.start)
    },
    /** Bumps whenever a renderer or transform is added, removed or disabled. */
    get generation() {
      return generation
    },
    /** False until some extension registered something: the frame code checks this first and does nothing more. */
    get active() {
      return !disposed && slots.length + tools.length + messageStyles.length + messages.length + prompts.length + chrome.length + widgets.length + markdowns.length + keys.length + commands.length + pages.length + modals.length + actionEntries.length + viewRegistry.size > 0
    },
    /** Imports each module (once per file, in order) and runs its `tui`. Notifies once at the end. */
    async load(files: readonly ExtensionFile[]) {
      loading = true
      try {
        for (const file of files) {
          if (loadedFiles.has(file.file)) continue
          loadedFiles.add(file.file)
          await loadOne(file)
        }
      } finally {
        loading = false
      }
      changed()
    },
    keys: (): readonly ExtensionKey[] => keys,
    /** What the loaded extensions registered, ranked by load order (the daemon's layer order, later wins): input of the precedence report. */
    claims(): PrecedenceClaim[] {
      return claimed.flatMap(({ surface, name, owner }) => {
        const rank = loaded.findIndex((extension) => extension.name === owner)
        const extension = loaded[rank]
        return extension ? [{ surface, name, rank, layer: extension.pkg ? `package ${extension.source}:${extension.pkg}` : extension.source }] : []
      })
    },
    /** What each loaded extension registered in this terminal (for `/extensions`); a slot or renderer an error disabled says so. */
    registrations(): TerminalRegistration[] {
      const flag = (entry: Owned) => (entry.disabled ? " (disabled)" : "")
      return loaded.map((extension) => ({
        name: extension.name,
        slots: slots.filter((entry) => entry.owner === extension.name).map((entry) => `${entry.name}${flag(entry)}`),
        keys: keys.filter((entry) => entry.owner === extension.name).map((entry) => entry.spec),
        commands: commands.filter((entry) => entry.owner === extension.name).map((entry) => `/${entry.name}`),
        pages: pages.filter((entry) => entry.owner === extension.name).map((entry) => `${entry.id}${flag(entry)}`),
        modals: modals.filter((entry) => entry.owner === extension.name).map((entry) => `${entry.id}${flag(entry)}`),
        actions: actionEntries.filter((entry) => entry.owner === extension.name).map((entry) => entry.id),
        renderers: [...viewRegistry.status().filter((entry) => entry.owner === extension.name).map((entry) => `view:${entry.slot}${entry.tripped ? " (disabled)" : ""}`), ...tools.filter((entry) => entry.owner === extension.name).map((entry) => `${entry.tool}${flag(entry)}`), ...messageStyles.filter((entry) => entry.owner === extension.name).map((entry) => `messageStyle:${entry.role}${flag(entry)}`), ...messages.filter((entry) => entry.owner === extension.name).map((entry) => `message:${entry.role}${flag(entry)}`), ...prompts.filter((entry) => entry.owner === extension.name).map((entry) => `prompt.replace${flag(entry)}`), ...widgets.filter((entry) => entry.owner === extension.name).map((entry) => `${entry.surface}:${entry.id}${flag(entry)}`)],
        transforms: markdowns.filter((entry) => entry.owner === extension.name).length,
      }))
    },
    commands: (): ReadonlyArray<{ name: string; description: string }> => commands.map(({ name, description }) => ({ name, description })),
    /**
     * The view-slot registry (docs/views.md): `has`/`call` are what the view host uses; `status` and `reset` feed
     * `/customize` → Views. Faults open a circuit breaker per view; nothing a view does reaches a frame.
     */
    views: { has: viewRegistry.has, call: viewRegistry.call, status: viewRegistry.status, reset: viewRegistry.reset } satisfies CustomViews & { status: ViewRegistry["status"]; reset: ViewRegistry["reset"] },
    hasSlot: (name: SlotName) => slots.some((entry) => entry.name === name && !entry.disabled),

    /** Lines for a slot, theme-mapped and fitted to `ctx.width`; undefined when no extension draws there (keep the default). */
    slot(name: SlotName, ctx: SlotContext): Line[] | undefined {
      const entries = slots.filter((entry) => entry.name === name && !entry.disabled)
      if (entries.length === 0) return undefined
      const frozen = Object.freeze({ ...ctx })
      const cap = Math.max(1, Math.min(MAX_ROWS, ctx.height))
      const draw = (entry: SlotEntry) => guard(entry, `slot ${name}`, () => {
        const result = entry.render(frozen)
        return result === undefined ? undefined : themeLines(result, cap)
      })
      if (REPLACE_SLOTS.has(name)) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const lines = draw(entries[i]!)
          if (lines) return lines.map((line) => fit(line, ctx.width))
        }
        return undefined
      }
      const out = entries.flatMap((entry) => draw(entry) ?? [])
      return out.length > 0 ? out.map((line) => fit(line, ctx.width)) : undefined
    },

    /** One row for `footer.left` / `footer.right`: the first line of each extension, side by side, at most `ctx.width` cells. */
    row(name: SlotName, ctx: SlotContext): Line | undefined {
      const entries = slots.filter((entry) => entry.name === name && !entry.disabled)
      if (entries.length === 0) return undefined
      const frozen = Object.freeze({ ...ctx })
      const parts = entries.flatMap((entry) => {
        const lines = guard(entry, `slot ${name}`, () => {
          const result = entry.render(frozen)
          return result === undefined ? undefined : themeLines(result, 1)
        })
        return lines?.[0]?.length ? [lines[0]] : []
      })
      if (parts.length === 0) return undefined
      return clip(parts.flatMap((part, index) => (index ? [GAP, ...part] : part)), ctx.width)
    },

    /** A replacement card body for a tool, clipped to `view.width`; undefined keeps the default card. */
    tool(view: ToolView): Line[] | undefined {
      // Exact names first, then the longest `prefix*`, then `*`; among equals the later registration wins. A renderer that
      // answers undefined passes the call to the next one.
      const candidates = tools
        .map((entry, index) => ({ entry, index, rank: entry.disabled ? -1 : toolMatch(entry.tool, view.tool) }))
        .filter((candidate) => candidate.rank >= 0)
        .sort((a, b) => b.rank - a.rank || b.index - a.index)
      if (!candidates.length) return undefined
      const args: ToolArgs = view.input ? Object.freeze({ detail: view.detail, ...view.input }) : Object.freeze({ detail: view.detail })
      for (const { entry } of candidates) {
        const lines = guard(entry, `renderTool ${entry.tool}`, () => {
          const result = entry.render({
            tool: view.tool,
            detail: view.detail,
            args,
            final: view.input !== undefined,
            output: view.output,
            status: view.status === "running" ? "running" : view.status === "ok" || view.status === undefined ? "ok" : "error",
            width: view.width,
            expanded: view.expanded,
          })
          return result === undefined ? undefined : themeLines(result, MAX_ROWS)
        })
        if (lines) return lines.map((line) => clip(line, view.width))
      }
      return undefined
    },

    messageStyle(role: MessageRole): MessageStyle | undefined {
      const entries = messageStyles.filter((entry) => !entry.disabled && entry.role === role)
      return entries.length ? Object.assign({}, ...entries.map((entry) => entry.style)) : undefined
    },
    /** Assistant markdown through every transform, in load order. */
    markdown(text: string, message: MessageData = { role: "assistant", text }, width = 80): string {
      let out = text
      for (const entry of markdowns) {
        if (entry.disabled || entry.role !== message.role) continue
        const next = guard(entry, "markdown transform", () => {
          const result = entry.transform(out, context(message, width))
          if (typeof result !== "string") throw new TypeError(`expected a string, got ${typeof result}`)
          return result
        })
        if (next !== undefined) out = next
      }
      return out
    },
    message(message: MessageData, width: number): Line[] | undefined {
      for (const entry of messages.toReversed()) {
        if (entry.disabled || entry.role !== message.role) continue
        const result = guard(entry, `renderMessage ${message.role}`, () => {
          const rows = entry.render(context(message, width))
          return rows === undefined ? undefined : themeLines(rows, MAX_ROWS).map((row) => clip(row, width))
        })
        if (result !== undefined) return result
      }
      return undefined
    },
    /** The comments message through every `comments.beforeSend`, in load order; undefined when none changed it. A transform that throws is disabled. */
    commentEnvelope({ message, comments, note }: { message: string; comments: readonly PendingComment[]; note: string }): string | undefined {
      let out = message
      const context = Object.freeze({ comments: Object.freeze(comments.map((comment) => Object.freeze({ ...comment }))), note })
      for (const entry of commentTransforms) {
        if (entry.disabled) continue
        const next = guard(entry, "comments.beforeSend", () => {
          const result = entry.transform(out, context)
          if (result !== undefined && typeof result !== "string") throw new TypeError(`expected a string or undefined, got ${typeof result}`)
          return result
        })
        if (next !== undefined) out = next
      }
      return out === message ? undefined : out
    },
    promptChrome(): PromptChrome { return Object.assign({}, ...chrome.filter((entry) => !entry.disabled).map((entry) => entry.value)) },
    prompt(ctx: Omit<PromptContext, "theme">) {
      for (const entry of prompts.toReversed()) {
        if (entry.disabled) continue
        const result = guard(entry, "prompt.replace", () => {
          const raw = entry.render(Object.freeze({ ...ctx, lines: Object.freeze([...ctx.lines]), cursor: Object.freeze({ ...ctx.cursor }), theme: theme() }))
          if (raw === undefined) return undefined
          const lines = themeLines(raw.lines, Math.min(8, ctx.height)).map((row) => fit(row, ctx.width))
          if (!Number.isInteger(raw.cursor?.row) || !Number.isInteger(raw.cursor?.col) || raw.cursor.row < 0 || raw.cursor.row >= lines.length || raw.cursor.col < 0 || raw.cursor.col >= ctx.width) throw new TypeError("invalid prompt cursor")
          return { lines, cursor: { ...raw.cursor } }
        })
        if (result !== undefined) return result
      }
      return undefined
    },
    widgets(surface: "tray" | "sidebar", ctx: SlotContext, ids?: readonly string[]) {
      return widgets.filter((entry) => !entry.disabled && entry.surface === surface && (!ids || ids.includes(entry.id))).flatMap((entry) => {
        const body = guard(entry, `widget ${entry.id}`, () => themeLines(entry.widget.render(Object.freeze({ ...ctx })) ?? [], Math.min(8, ctx.height)).map((row) => fit(row, ctx.width)))
        return body ? [{ id: entry.id, title: entry.widget.title, body }] : []
      })
    },
    hasWidgets: (surface: "tray" | "sidebar") => widgets.some((entry) => entry.surface === surface && !entry.disabled),
    footerRows(name: "footer.left" | "footer.right", ctx: SlotContext): Line[] {
      const parts = slots.filter((entry) => entry.name === name && !entry.disabled).flatMap((entry) => {
        const rows = guard(entry, `slot ${name}`, () => { const result = entry.render(Object.freeze({ ...ctx })); return result === undefined ? undefined : themeLines(result, MAX_FOOTER_ROWS) })
        return rows ? [rows] : []
      })
      return Array.from({ length: Math.min(MAX_FOOTER_ROWS, Math.max(0, ...parts.map((rows) => rows.length))) }, (_, row) => clip(parts.flatMap((part, index) => part[row] ? [...(index ? [GAP] : []), ...part[row]!] : []), ctx.width))
    },

    hasCommand: (name: string) => commands.some((candidate) => candidate.name === name.toLowerCase()),

    /** Runs a terminal `/name args`; false when no extension has that command. */
    runCommand(name: string, args: string, actions: TuiActions): boolean {
      const entry = commands.find((candidate) => candidate.name === name.toLowerCase())
      if (!entry) return false
      guard(entry, `/${entry.name}`, () => entry.run(args, actions))
      return true
    },

    /** Runs an extension key's function, keeping a throw away from the prompt. */
    runKey(key: { run: (actions: TuiActions) => void; owner: string }, actions: TuiActions) {
      guard({ owner: key.owner }, "key", () => key.run(actions))
    },

    hasPage: (id: string) => pages.some((entry) => entry.id === id && !entry.disabled),
    pageTitle: (id: string) => {
      const title = pages.find((entry) => entry.id === id)?.page.title
      return title === undefined ? undefined : oneLine(title)
    },

    /** The page's body; undefined when it is gone or threw (the app closes it). */
    renderPage(id: string, ctx: SlotContext): Line[] | undefined {
      const entry = pages.find((candidate) => candidate.id === id && !candidate.disabled)
      if (!entry) return undefined
      const frozen = Object.freeze({ ...ctx })
      const lines = guard(entry, `page ${id}`, () => themeLines(entry.page.render(frozen), Math.max(1, ctx.height)))
      return lines?.map((line) => clip(line, ctx.width))
    },

    /** Forwards a key to the open page; true when the page handled it. */
    pageKey(id: string, key: string, controls: { close(): void; redraw(): void }): boolean {
      const entry = pages.find((candidate) => candidate.id === id && !candidate.disabled)
      if (!entry?.page.onKey) return false
      return guard(entry, `page ${id} onKey`, () => entry.page.onKey!(key, controls) === true) === true
    },

    hasModal: (id: string) => modals.some((entry) => entry.id === id && !entry.disabled),
    /** The modal's title and requested width on this terminal, read when it is drawn; undefined when it is gone or disabled (a width function that throws disables it). */
    modalInfo(id: string, screen: SlotContext["screen"] & { breakpoint: SlotContext["breakpoint"] }): { title: string; width?: number } | undefined {
      const entry = modals.find((candidate) => candidate.id === id && !candidate.disabled)
      if (!entry) return undefined
      const wanted = entry.modal.width
      const width = typeof wanted === "function" ? guard(entry, `modal ${id} width`, () => {
        const value = wanted(Object.freeze({ ...screen }))
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`expected a positive number, got ${String(value)}`)
        return value
      }) : wanted
      if (entry.disabled) return undefined
      return { title: oneLine(entry.modal.title) || id, ...(width !== undefined ? { width } : {}) }
    },
    /** The modal's body at `ctx.width` × `ctx.height`; undefined when it is gone or threw (the app closes it). */
    renderModal(id: string, ctx: SlotContext): Line[] | undefined {
      const entry = modals.find((candidate) => candidate.id === id && !candidate.disabled)
      if (!entry) return undefined
      const frozen = Object.freeze({ ...ctx })
      const lines = guard(entry, `modal ${id}`, () => themeLines(entry.modal.render(frozen), Math.max(1, ctx.height)))
      return lines?.map((line) => clip(line, ctx.width))
    },
    /** Forwards a key to the open modal; true when it handled it. A throw disables the modal. */
    modalKey(id: string, key: string, controls: TuiActions & { close(): void; redraw(): void }): boolean {
      const entry = modals.find((candidate) => candidate.id === id && !candidate.disabled)
      if (!entry?.modal.onKey) return false
      return guard(entry, `modal ${id} onKey`, () => entry.modal.onKey!(key, controls) === true) === true
    },

    /** The named actions, in load order (a later registration of an id replaced the earlier one). */
    actions: (): ReadonlyArray<{ id: string; title: string; description: string }> => actionEntries.map(({ id, title, description }) => ({ id, title, description })),
    hasAction: (id: string) => actionEntries.some((entry) => entry.id === id),
    /** Runs a named action; false when no extension has it. A throw is reported and the action stays. */
    runAction(id: string, actions: TuiActions): boolean {
      const entry = actionEntries.find((candidate) => candidate.id === id)
      if (!entry) return false
      guard(entry, `action ${id}`, () => entry.run(actions))
      return true
    },
  }
}

export type ExtensionRuntime = ReturnType<typeof createExtensionRuntime>
