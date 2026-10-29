import type { createSession } from "./session"
import type { createPrompt } from "./prompt"
import { DEFAULT_COMPACT_AT_TOKENS } from "@mendcode/protocol/wire"
import { contextLimit } from "../../view/context-meter"
import type { CustomToolsReport } from "@mendcode/protocol"
import { DEFAULT_BINDINGS, keyName } from "../keymap"
import { breakpointOf } from "../breakpoints"
import { modalCard, modalLayout, type CardOverlay } from "../../view/modal-card"
import type { SlotContext, TuiActions } from "@mendcode/extension-api"
import { activationManifests, canonicalDirectory, discoverExtensions } from "../../extensions/discover"
import { buildBindings, readKeybindings } from "../../extensions/keybindings"
import type { HelpExtensions } from "../../view/help-page"
import { SLASH_COMMANDS } from "../../view/commands"
import { slotRows } from "../../view/prompt-chrome"
import { pluginFrame, pluginChrome } from "../../view/plugin-chrome"
import type { Line } from "../theme"
import type { AppContext } from "./context"
import { BUSY } from "./constants"
import { readTuiProfile, type TuiProfile } from "../../view/tui-profile"
import type { ProfileLayers } from "./profile-layers"
import { footerRowBudget } from "../../view/footer-rows"
import { usageInForce } from "./usage-in-force"

export function createExtensions(ctx: AppContext, actions: {
  recordSlash?: (name: string) => void
  loadBranch: ReturnType<typeof createSession>["loadBranch"]
  sessionTitle: () => string
  runSlash: (text: string) => Promise<boolean>
  syncMentions: ReturnType<typeof createPrompt>["syncMentions"]
  changeProfile: (patch: Partial<TuiProfile>) => void
  /** The profile layers (resolved after the app is composed): activation overlay, extension requests and what the user kept. */
  profileLayers: () => ProfileLayers
  /** Asks the daemon for theme files again (a package's theme edited, turned on or off). */
  refreshThemes: () => void
  /** Opens a file in the viewer (`api.openFile`); the viewer refuses what is outside the workspace or not a file. */
  openFile: (path: string, lines?: { from: number; to?: number }) => void
}) {
  const { input, state, now, editor, keybindingFile, say, fail, report, requestFrame } = ctx
  const { loadBranch, sessionTitle, runSlash, syncMentions } = actions

  function slotState(): SlotContext["state"] {
    if (state.connection !== "connected") return "offline"
    const localState = state.transcript.foreground
    if (localState === "waiting_approval" || localState === "queued") return "waiting"
    return BUSY.has(localState) ? "working" : "idle"
  }

  /** What a slot renderer sees: a snapshot of the screen and session; `height` is the rows available to that slot. */
  function slotContext(width: number, height: number): SlotContext {
    if (state.gitBranch === undefined && !state.branchRequested) {
      state.branchRequested = true
      void loadBranch()
    }
    const model = state.effectiveModel?.model ?? usageInForce(state)?.model
    const tokens = usageInForce(state)?.contextTokens
    const title = sessionTitle()
    const screen = input.screen.size
    return {
      width: Math.max(0, width),
      height: Math.max(0, height),
      breakpoint: breakpointOf(screen.width),
      screen: Object.freeze({ width: screen.width, height: screen.height }),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(title ? { title } : {}),
      directory: input.directory ?? "",
      ...(state.gitBranch ? { branch: state.gitBranch } : {}),
      ...(model ? { model } : {}),
      ...(state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
      state: slotState(),
      stats: ctx.stats.read(),
      usage: ctx.usage.read(),
      ...(tokens !== undefined ? { context: Math.max(0, Math.min(1, tokens / contextLimit(usageInForce(state), state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS))) } : {}),
      now: now(),
    }
  }

  /** `footer.left` / `footer.right` / `footer.replace` for the row that is the footer of this view, theme spans already. */
  function footerSlots(width: number): { left?: Line; right?: Line; replace?: Line; rows?: Array<{ left?: Line; right?: Line; replace?: Line }> } | undefined {
    if (!state.ext || !extOn()) return undefined
    // At most the rows the footer may take on this terminal (a quarter of its height, up to the shared ceiling).
    const room = footerRowBudget(input.screen.size.height)
    const replace = state.ext.slot("footer.replace", slotContext(width, room))
    if (replace) return { replace: replace[0] ?? [], rows: replace.slice(1, room).map((row) => ({ replace: row })) }
    // The two sides share the row: each may take up to half of it, which is the width the renderer is told.
    const side = slotContext(Math.max(0, Math.floor((width - 2) / 2)), room)
    const left = state.ext.footerRows("footer.left", side)
    const right = state.ext.footerRows("footer.right", side)
    const rows = Array.from({ length: Math.min(room, Math.max(left.length, right.length)) }, (_, index) => ({ ...(left[index] ? { left: left[index] } : {}), ...(right[index] ? { right: right[index] } : {}) }))
    return rows.length ? { ...rows[0], rows: rows.slice(1) } : undefined
  }

  /** Rows an extension adds above or below the prompt, as many as the screen can spare. */
  function promptSlotRows(name: "prompt.above" | "prompt.below", width: number, height: number): Line[] {
    if (!state.ext || !extOn()) return []
    const room = height >= 20 ? 3 : height >= 14 ? 1 : 0
    return room > 0 ? slotRows(state.ext.slot(name, slotContext(width, room)) ?? [], width, room) : []
  }

  /** Why the last reload kept the previous extensions (one line per module that failed to load again). */
  let keptNotes: string[] = []

  function extensionProblemLines(): string[] {
    return [...keybindingFile.problems, ...state.extKeyProblems, ...(state.activation?.problems ?? []), ...(state.activation?.result.conflicts ?? []).map((line) => `packages: ${line}`), ...keptNotes, ...(state.ext?.conflicts ?? []).map((entry) => entry.message), ...(state.ext?.problems ?? []).map((problem) => `${problem.extension}: ${problem.message}`)]
  }

  /** One toast for everything that went wrong at startup; later problems toast once per extension. */
  function announceExtensionProblems() {
    state.extAnnounced = true
    for (const problem of state.ext?.problems ?? []) extToldAbout.add(problem.extension)
    const lines = extensionProblemLines()
    if (lines.length > 0) say(lines.length === 1 ? lines[0]! : `${lines.length} extension problems · /help`, "warning")
  }

  /**
   * `keybindings.json`, with the enabled packages' keybindings over it: a key the user chose by hand after a package took it
   * (the keymap editor, or `keep mine`) stays theirs, so it is applied again last.
   */
  function fileEntries() {
    const packages = state.activation?.keybindings ?? []
    if (packages.length === 0) return keybindingFile.entries
    const mine = (spec: string) => state.keptKeys.has(`keybindings:${spec}`)
    return [...keybindingFile.entries.filter((entry) => !mine(entry.spec)), ...packages.filter((entry) => !mine(entry.spec)), ...keybindingFile.entries.filter((entry) => mine(entry.spec))]
  }

  function rebuildBindings() {
    const keys = state.ext?.keys() ?? []
    const entries = fileEntries()
    if (entries.length === 0 && keys.length === 0) {
      state.bindings = DEFAULT_BINDINGS
      state.extKeyProblems = []
      return
    }
    const built = buildBindings({ file: entries, extensions: keys })
    state.bindings = built.bindings
    state.extKeyProblems = built.problems
  }

  /** The keymap editor changed `keybindings.json`: read it again and rebuild the live keys. */
  function reloadKeybindings() {
    if (!input.dataDir) return
    const fresh = readKeybindings(input.dataDir)
    // A key the keymap editor changed while a package binds it is the user's from now on.
    const before = new Map(keybindingFile.entries.map((entry) => [entry.spec, JSON.stringify(entry.action)]))
    const changed = fresh.entries.filter((entry) => before.get(entry.spec) !== JSON.stringify(entry.action)).map((entry) => entry.spec)
    if (changed.length && actions.profileLayers().keepKeybindings(changed)) requestFrame()
    keybindingFile.entries = fresh.entries
    keybindingFile.problems = fresh.problems
    rebuildBindings()
  }

  function helpExtensions(): HelpExtensions | undefined {
    const loaded = (state.ext?.loaded ?? []).map((entry) => ({ name: entry.name, detail: `${entry.source}${entry.pkg ? `:${entry.pkg}` : ""} · ${entry.tui ? "terminal" : "daemon only"}` }))
    if (state.extSkipped > 0) loaded.push({ name: "project", detail: `${state.extSkipped} extension${state.extSkipped === 1 ? "" : "s"} not loaded: directory not trusted (project tools trust covers them: /tools, t)` })
    const problems = extensionProblemLines()
    return loaded.length > 0 || problems.length > 0 ? { loaded, problems } : undefined
  }

  /** The project's extensions load only where its custom tools are trusted: the daemon's own trust list, else what `tools.list` reports. */
  const projectTrustedBySettings = () => input.directory !== undefined && (state.settingsNow.trustedToolDirs ?? []).includes(canonicalDirectory(input.directory))

  async function projectTrustedByDaemon() {
    const reply = await input.send({ type: "tools.list", directory: input.directory ?? "" })
    const projectTools = reply.ok ? ((reply.result as CustomToolsReport | undefined)?.tools ?? []).filter((tool) => tool.source === "project") : []
    return projectTools.length > 0 && projectTools.every((tool) => tool.trusted)
  }

  /**
   * The enabled packages' activation profiles (docs/packages.md): computed from their manifests, layered over the user's profile and
   * keybindings, never saved. Returns the look modules of packages that do not own the look (the loaders skip them). The activation
   * code loads only when an enabled package declares one.
   */
  async function syncActivation(): Promise<string[]> {
    if (!input.dataDir) return []
    const layers = actions.profileLayers()
    const manifests = activationManifests({ dataDir: input.dataDir, directory: input.directory, disabled: state.settingsNow.disabledPackages })
    if (manifests.length === 0) {
      if (state.activation) {
        state.activation = undefined
        layers.sync()
        rebuildBindings()
      }
      return []
    }
    // A project package's activation applies only where its code may run: the same trust as project tools.
    const projectTrusted = manifests.some((entry) => entry.source === "project") && (projectTrustedBySettings() || (await projectTrustedByDaemon()))
    const { loadActivation } = await import("../../extensions/activation")
    state.activation = loadActivation({ manifests, dataDir: input.dataDir, directory: input.directory, projectTrusted, base: readTuiProfile(input.dataDir) })
    state.keptKeys = new Set(state.activation.result.kept)
    state.keptValues = { ...state.activation.result.keptValues }
    layers.sync()
    rebuildBindings()
    // A package theme file may have been edited: ask for the theme files again.
    if (state.activation.result.overlay.theme) actions.refreshThemes()
    return state.activation.result.suppressed
  }

  let revision = 0
  async function loadExtensions(reportedRevision = 0) {
    if (input.remote || input.pure || !input.dataDir) return
    const suppressed = await syncActivation()
    const all = discoverExtensions({ dataDir: input.dataDir, directory: input.directory, disabled: state.settingsNow.disabledPackages, disabledResources: [...(state.settingsNow.disabledPackageResources ?? []), ...suppressed] })
    const project = all.filter((file) => file.source === "project")
    const trusted = project.length > 0 && (projectTrustedBySettings() || (await projectTrustedByDaemon()))
    const files = trusted ? all : all.filter((file) => file.source === "user")
    state.extSkipped = trusted ? 0 : project.length
    if (files.length > 0) {
      // The only place the extension runtime is imported: a terminal without extension files never loads it.
      const { createExtensionRuntime } = await import("../../extensions/runtime")
      const previous = state.ext
      // The candidate is built beside the running extensions: what it asks of the profile waits until it is swapped in, and
      // the running ones stay on screen (no blank frame, no lost layout) until the candidate is known to be at least as good.
      let live = false
      const waiting: Array<Record<string, unknown>> = []
      // What an extension asks of the profile is a layer over the user's own: applied for as long as it runs, never written to profile.json.
      const applySettings = (patch: Record<string, unknown>) => actions.profileLayers().runtime(patch)
      {
        const candidate = createExtensionRuntime({
          revision: ++revision,
          disabled: state.tuiProfile.disabledUiExtensions,
          settings: {
            get: (key) => key === undefined ? structuredClone(state.tuiProfile) : structuredClone(state.tuiProfile[key as keyof TuiProfile]),
            set: (patch) => (live ? applySettings(patch) : void waiting.push(patch)),
          },
          redraw: requestFrame,
          stats: ctx.stats,
          usage: ctx.usage,
          navigate: openExtensionPage,
          plugin: { version: input.version ?? "dev", directory: input.directory ?? "", current: () => state.sessionId, request: input.send },
          reservedCommands: new Set(SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases])),
          // Deferred: a renderer can be disabled in the middle of drawing the transcript, which must not be reset under its feet.
          onChange: () =>
            queueMicrotask(() => {
              state.transcript.refresh()
              rebuildBindings()
              requestFrame()
            }),
          onProblem: (problem) => {
            if (!state.extAnnounced || extToldAbout.has(problem.extension)) return
            extToldAbout.add(problem.extension)
            // Raised from inside a frame or a key: the toast waits until the current call is done.
            queueMicrotask(() => say(`${problem.extension}: ${problem.message}`, "warning"))
          },
        })
        await candidate.load(files)
        // A reload that breaks a module the running copy loaded fine keeps the running copy: the candidate is thrown away
        // (its own disposers run, once) and the failure is reported. Modules that already failed before are not a regression.
        const regressed = previous !== undefined && previous.loaded.length > 0 && candidate.failed.some((entry) => !previous.failed.some((old) => old.file === entry.file))
        if (regressed) {
          void candidate.dispose()
          keptNotes = candidate.failed.map((entry) => `${entry.extension}: ${entry.message}; the previous version is still running`.slice(0, 1000))
          say(`${keptNotes[0]!.split(";")[0]} · keeping the previous extensions`, "warning")
        } else {
          keptNotes = []
          state.ext = candidate
          live = true
          actions.profileLayers().resetRuntime()
          for (const patch of waiting.splice(0)) applySettings(patch)
          // The copy it replaces stops first (its processes too); only then does this one start what it asked to start (`api.onStart`).
          await previous?.dispose()
          candidate.start()
        }
      }
    } else {
      keptNotes = []
      void state.ext?.dispose()
      state.ext = undefined
      actions.profileLayers().resetRuntime()
      actions.profileLayers().sync()
    }
    await input.send({ type: "extensions.report", revision: reportedRevision, errors: [...keptNotes, ...(state.ext?.problems ?? []).map((problem) => `${problem.extension}: ${problem.message}`)].map((line) => line.slice(0, 1000)).slice(0, 64) })
    rebuildBindings()
    state.transcript.refresh()
    if (!state.extAnnounced) announceExtensionProblems()
    requestFrame()
  }

  /** Starts (or, when trust or the disabled packages changed, repeats) discovery; modules already loaded are not loaded twice. */
  function syncExtensions() {
    if (input.remote || input.pure || !input.dataDir) return
    const key = JSON.stringify([projectTrustedBySettings(), state.settingsNow.disabledPackages ?? [], state.settingsNow.disabledPackageResources ?? [], state.tuiProfile.disabledUiExtensions])
    if (state.extStarted && key === state.extSettingsKey) return
    state.extStarted = true
    state.extSettingsKey = key
    state.extLoad = state.extLoad.then(() => loadExtensions()).catch((error: unknown) => say(`extensions: ${error instanceof Error ? error.message : String(error)}`, "error"))
  }

  function reloadExtensions(reportedRevision = 0) {
    // The daemon also announces an edited `keybindings.json` this way: the keys are read again before the modules are.
    state.extLoad = state.extLoad.then(() => { reloadKeybindings(); return loadExtensions(reportedRevision) }).catch(async (error: unknown) => {
      const message = `extensions: ${error instanceof Error ? error.message : String(error)}`
      say(message, "error")
      await input.send({ type: "extensions.report", revision: reportedRevision, errors: [message.slice(0, 1000)] })
    })
    return state.extLoad
  }

  /** A message the extension sends as the user: a `/command` runs as typed, anything else is a turn. The prompt's own draft stays. */
  async function submitFromExtension(text: string) {
    const value = text.trim()
    if (!value) return
    if (value.startsWith("/")) {
      const draft = editor.text
      const ran = (await runExtensionCommand(value)) || (await runSlash(value))
      if (draft && state.page === "chat") editor.insert(draft)
      if (ran) return
    }
    report(await input.send({ type: "user.submit", sessionId: state.sessionId, text: value, attachments: [] }))
    requestFrame()
  }

  /** `/name args` of a terminal extension runs here, with no daemon round trip; false when no extension has `name`. */
  async function runExtensionCommand(text: string) {
    if (!state.ext || !extOn()) return false
    const match = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim())
    if (!match || !state.ext.hasCommand(match[1]!)) return false
    actions.recordSlash?.(match[1]!.toLowerCase())
    // The prompt is cleared first: the command may put text into it.
    editor.clear()
    state.ext.runCommand(match[1]!, (match[2] ?? "").trim(), tuiActions)
    requestFrame()
    return true
  }

  function openExtensionPage(id: string) {
    // `page:git` with no extension page of that id names a built-in page: its slash command opens it.
    if (!state.ext?.hasPage(id)) {
      void runSlash(`/${id}`).then((ran) => { if (!ran) fail(`unknown page: ${id}`) })
      return
    }
    state.extPageId = id
    state.page = "extension"
    state.palette = undefined
    state.extModalId = undefined
    requestFrame()
  }

  function openExtensionModal(id: string) {
    if (!state.ext?.hasModal(id)) return fail(`unknown modal: ${id}`)
    state.extModalId = id
    state.palette = undefined
    requestFrame()
  }

  function closeExtensionModal() {
    state.extModalId = undefined
    requestFrame()
  }

  /** The open modal as a card over the screen, drawn with the palette's chrome; a modal that is gone, threw or has no room closes itself. */
  function extensionModalOverlay(width: number, height: number): CardOverlay | undefined {
    const id = state.extModalId
    const info = id ? state.ext?.modalInfo(id, { width, height, breakpoint: breakpointOf(width) }) : undefined
    const layout = info ? modalLayout({ width, height, ...(info.width !== undefined ? { requested: info.width } : {}) }) : undefined
    const body = id && layout ? state.ext?.renderModal(id, slotContext(layout.inner, layout.room)) : undefined
    if (!info || !layout || !body) {
      // Never a modal that takes the keys without being seen (a terminal too small for the card included).
      if (id) queueMicrotask(() => { if (state.extModalId === id) closeExtensionModal() })
      return undefined
    }
    return modalCard({ title: info.title, body, layout, width, height })
  }

  /** Keys while a modal is open: one at a time to its `onKey`, named like keybindings.json; an unhandled esc, or ctrl+c, closes it. */
  function extensionModalKey(key: string) {
    const id = state.extModalId
    if (!id) return
    // Typed-ahead text arrives as one chunk; the modal gets one key at a time, as a page does.
    const keys = /^[\x20-\x7e -￿]{2,}$/u.test(key) ? [...key] : [key]
    for (const each of keys) {
      if (each === "\x03") { closeExtensionModal(); break }
      const handled = state.ext ? state.ext.modalKey(id, keyName(each) ?? each, { ...tuiActions, close: () => { if (state.extModalId === id) closeExtensionModal() }, redraw: requestFrame }) : false
      if (!handled && each === "\x1b") closeExtensionModal()
      if (state.extModalId !== id) break
    }
    if (state.extModalId === id && !state.ext?.hasModal(id)) closeExtensionModal()
    requestFrame()
  }

  /** A named action of an extension (`action:<id>`, the palette); false when none has it. */
  function runExtensionAction(id: string) {
    if (!state.ext || !extOn() || !state.ext.hasAction(id)) {
      fail(`unknown action: ${id}`)
      return false
    }
    state.ext.runAction(id, tuiActions)
    requestFrame()
    return true
  }

  function closeExtensionPage() {
    if (state.page === "extension") state.page = "chat"
    state.extPageId = undefined
    requestFrame()
  }

  /** The open extension page drawn with the page standard; a page that is gone or threw closes itself. */
  function extensionPageRows(width: number, height: number): Line[] {
    const id = state.extPageId
    const hints = "esc back"
    const room = Math.max(1, height - pluginChrome)
    const body = id && state.ext ? state.ext.renderPage(id, slotContext(Math.max(1, width - 2), room)) : undefined
    if (!id || !body) {
      queueMicrotask(closeExtensionPage)
      return []
    }
    return pluginFrame({ title: state.ext?.pageTitle(id) ?? id, body, hints, width, height })
  }

  const extOn = () => state.ext !== undefined && state.ext.active

  /** What an extension's keys, commands and pages can do to the terminal. */
  const tuiActions: TuiActions = {
    submit(text) {
      void submitFromExtension(String(text))
    },
    insert(text) {
      editor.insert(String(text))
      syncMentions()
      requestFrame()
    },
    openPage: (id) => openExtensionPage(String(id)),
    openModal: (id) => openExtensionModal(String(id)),
    closeModal: closeExtensionModal,
    openFile: (file, lines) => {
      const from = lines && Number.isInteger(lines.from) && lines.from > 0 ? lines.from : undefined
      const to = from && lines?.to !== undefined && Number.isInteger(lines.to) && lines.to >= from ? lines.to : undefined
      actions.openFile(String(file).slice(0, 4096), from ? { from, ...(to ? { to } : {}) } : undefined)
    },
    toast: (text, tone = "info") => say(String(text).slice(0, 300), tone),
    comments: {
      list: () => ctx.comments.pending(),
      add: ({ quote, text }) => ctx.comments.add({ quote: String(quote), text: String(text) }),
    },
  }

  const extToldAbout = new Set<string>()

  return { reloadKeybindings, slotContext, footerSlots, promptSlotRows, helpExtensions, syncExtensions, reloadExtensions, runExtensionCommand, openExtensionPage, closeExtensionPage, extensionPageRows, openExtensionModal, closeExtensionModal, extensionModalOverlay, extensionModalKey, runExtensionAction, extOn, tuiActions, extensionProblemLines }
}
