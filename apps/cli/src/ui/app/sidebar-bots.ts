import type { BotListReport, SessionId, SessionSummary } from "@mendcode/protocol"
import { botChatsName, botKey, botMoreName, botName, groupDirectory, isBotChatsId, isBotId, isBotMoreId, isGroupId, isMoreId, isMoreProjectsId, moreDirectory, multiSectionStarts, multiStops, renderMultiSidebar, type MultiInput } from "../../view/sidebar-multi"
import { createProjectProbe, eligibleDirectory, FRESH_MS, type ProjectInspection } from "../../view/sidebar-projects"
import { sessionMark, sidebarKind } from "../../view/sidebar"
import { botIndex, patchBotReport } from "../../view/bot-live"
import { mergeActivity, type ActivityEvent } from "../../view/session-activity"
import { sidebarListsAll, sidebarSectionsOf } from "../../view/tui-profile"
import { readFile, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { PetImage } from "../../pets/decode"
import type { FaceCapability } from "../../view/bot-face"
import type { IconFaces } from "../../view/bot-icon"
import type { ImagePlacement } from "../image-layer"
import { activeTheme, colorDepth, type Line } from "../theme"
import type { AppContext } from "./context"
import { startNewChatPanel } from "./session-look"

/**
 * The left list when bots are on (docs/agents.md) or every project is asked for: it asks for the bots and for the other folders'
 * sessions, draws `view/sidebar-multi.ts`, folds the groups, and opens a bot's page. Loaded by the first frame that needs it
 * (chrome.ts), never at start; with the flag off and one folder in the list nothing here ever loads.
 */
export type SidebarBots = ReturnType<typeof createSidebarBots>

/**
 * What follows `session.activity` pushes costs no request. The bot list is asked again only for a session no list holds (a new chat
 * that may be a bot's): at most once per `BOTS_WINDOW_MS`, plus up to `JITTER_MS` chosen at random so many terminals do not ask at the
 * same instant. The full lists are asked on first show, on show after the sidebar was hidden while pushes came, after a reconnect, and
 * every `SAFETY_MS` (jittered) while the sidebar shows.
 */
const BOTS_WINDOW_MS = 1000
const JITTER_MS = 1500
const SAFETY_MS = 60_000
/** The pushed sessions a list keeps (the cap `events.ts` gives this terminal's own list). */
const PUSHED_MAX = 500
/** Sessions known not to belong to a bot, so a busy old session does not ask for the list again at every push. */
const CLASSIFIED_MAX = 2000
/** How many sessions of every folder the all-projects list asks for. */
const ALL_LIMIT = 200

/** The linked worktrees keep a `.git` file that points into the main repo's `.git/worktrees/<name>`. */
const WORKTREE_MARKER = "/.git/worktrees/"

/** One stat per folder (plus one small read for a linked worktree): is it a git work tree root, and whose worktree is it. */
async function inspectOnDisk(directory: string): Promise<ProjectInspection> {
  const marker = join(directory, ".git")
  const found = await stat(marker).catch(() => undefined)
  if (!found) return { git: false }
  if (found.isDirectory()) return { git: true }
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(marker, "utf8"))?.[1]
  if (!pointer) return { git: true }
  const target = isAbsolute(pointer) ? pointer : resolve(directory, pointer)
  const at = target.indexOf(WORKTREE_MARKER)
  return { git: true, ...(at > 0 ? { main: target.slice(0, at) } : {}) }
}

export type SidebarDeps = { switchSession(sessionId: SessionId): Promise<void> }

export function createSidebarBots(ctx: AppContext) {
  const { input, state, env, now, requestFrame, say, fail } = ctx
  let report: BotListReport | undefined
  let others: SessionSummary[] = []
  const open = new Map<string, boolean>()
  /** The folders whose whole list was opened with the more row; kept in memory only. */
  const expanded = new Set<string>()
  /** Which bot each listed session belongs to, from the last `bot.list`. */
  let botOfSession = new Map<string, string>()
  const classified = new Set<string>()
  /** Sessions no list held when their push came: classified once the next `bot.list` answers. */
  const unknown = new Set<string>()
  /** When the next bot list may be asked for (set by a push that needs it), and when the slow safety refresh is due. */
  let botsDueAt: number | undefined
  let lastBotsAskAt = Number.NEGATIVE_INFINITY
  let safetyAt: number | undefined
  /** Pushes came while the sidebar was hidden, or the connection came back: the next show asks for both lists whole. */
  let stale = false
  let botsLoaded = false
  let othersLoaded = false
  let loadingBots = false
  let loadingOthers = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let iconsNow = false
  /** The `+ N more projects` row was opened; kept in memory only. */
  let projectsExpanded = false
  const home = env.HOME ?? homedir()
  const tmpRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  /** The folders that are projects, asked of the disk once each and off the render path; a remote terminal has no local disk to ask. */
  const probe = input.remote
    ? { isProject: (directory: string) => eligibleDirectory({ directory, home, tmpRoots }), eligible: (directory: string) => eligibleDirectory({ directory, home, tmpRoots }), canonical: (directory: string) => directory }
    : createProjectProbe({ home, tmpRoots, inspect: input.inspectProject ?? inspectOnDisk, onChange: requestFrame })

  /** The face modules, loaded by the first frame of a terminal that draws images, or by opening a bot's page; never otherwise. */
  let faceModule: typeof import("../../view/bot-face") | undefined
  let loadingFaces = false
  /** A bot's own picture, asked for once per bot and file; null while it loads or when it was refused. */
  const avatars = new Map<string, PetImage | null>()

  /** The image layer is on (the pets' protocol choice), not only a capable terminal. */
  const layerOn = () => input.screen.imageProtocol !== undefined && input.screen.imageProtocol !== "off"
  function capability(avatar?: PetImage | null): FaceCapability | undefined {
    if (!faceModule) return undefined
    const found = faceModule.faceCapability({ env, depth: colorDepth(env), mode: state.tuiProfile.images, ...(input.imageAnswers ? { answers: input.imageAnswers } : {}), ascii: state.glyphMode === "ascii", ...(avatar ? { avatar } : {}), ...(state.imageCellPixels ? { cellPixels: state.imageCellPixels } : {}), theme: activeTheme() })
    return layerOn() ? found : { ...found, images: false }
  }
  function loadFaces(): Promise<void> {
    if (faceModule || loadingFaces) return Promise.resolve()
    loadingFaces = true
    return import("../../view/bot-face").then((loaded) => { faceModule = loaded; requestFrame() }).catch(() => undefined).finally(() => { loadingFaces = false })
  }
  /** What the sidebar's icons need to become pictures, or nothing when the terminal draws no images (the glyphs stay). */
  function iconFaces(): IconFaces | undefined {
    const found = capability()
    return found?.images && !found.ascii && faceModule ? { capability: found, slot: "bot-icon", make: faceModule.botIconImage, stateOf: faceModule.faceStateOf } : undefined
  }
  /** Reads a bot's `avatar` once: only inside its folder under the data dir, or the data dir itself. */
  function ensureAvatar(bot: { name: string; identity: { avatar?: string | undefined } }): string | undefined {
    const path = bot.identity.avatar
    const dataDir = input.dataDir
    if (!path || !dataDir || !layerOn()) return undefined
    const key = `${bot.name}\0${path}`
    if (!avatars.has(key)) {
      avatars.set(key, null)
      const folder = join(dataDir, "bots", bot.name)
      void import("../../view/bot-avatar").then(({ loadBotAvatar }) => loadBotAvatar({ path, allowed: [folder, dataDir], base: folder })).then((image) => { avatars.set(key, image); requestFrame() }).catch(() => undefined)
    }
    return key
  }

  const botsOn = () => state.settingsNow.experimental?.bots === true
  const allProjects = () => sidebarListsAll(state.tuiProfile.sidebarProjects, botsOn())
  /** Whether this list draws now; a flag turned off or a setting changed back hands the list to the classic one. */
  const live = () => botsOn() || allProjects()

  async function loadBots() {
    lastBotsAskAt = now()
    botsDueAt = undefined
    botsLoaded = true
    if (!botsOn() || input.remote) return
    loadingBots = true
    try {
      const reply = await input.send({ type: "bot.list" })
      if (reply.ok) {
        report = reply.result as BotListReport
        botOfSession = botIndex(report)
        for (const id of unknown) if (!botOfSession.has(id)) classified.add(id)
        unknown.clear()
        while (classified.size > CLASSIFIED_MAX) classified.delete(classified.values().next().value!)
      }
    } finally { loadingBots = false }
    requestFrame()
  }
  async function loadOthers() {
    if (!allProjects()) return
    loadingOthers = true
    othersLoaded = true
    try {
      const reply = await input.send({ type: "session.list", limit: ALL_LIMIT, hideEmpty: true })
      if (reply.ok) others = (reply.result?.sessions as SessionSummary[] | undefined) ?? []
    } finally { loadingOthers = false }
    requestFrame()
  }
  /** Both lists whole; the slow safety refresh is pushed back from here. */
  function loadAll() {
    stale = false
    safetyAt = now() + SAFETY_MS + ctx.random() * JITTER_MS
    void Promise.all([botsOn() ? loadBots() : undefined, allProjects() ? loadOthers() : undefined]).catch(() => undefined)
  }

  /** Whether the list is on screen now: in the chat, in a size that draws it. Hidden, nothing below does any work. */
  const shown = () => state.page === "chat" && sidebarKind({ mode: state.tuiProfile.sidebar, width: input.screen.size.width, minimal: state.mode === "minimal", bots: botsOn(), iconsOnly: botsOn() && state.tuiProfile.sidebarLayout === "icons-only" }) !== "none"

  /** Asks for the bot list soon: once per window however many pushes want it, a random while after so terminals spread out. */
  function wantBots(jitter = true) {
    if (botsDueAt !== undefined || loadingBots) return
    botsDueAt = Math.max(now(), lastBotsAskAt + BOTS_WINDOW_MS) + (jitter ? ctx.random() * JITTER_MS : 0)
    arm()
  }

  /** Does whatever is due. Runs from the frame that draws the list, from a push and from the one timer, and only while the list shows. */
  function pump() {
    if (!live() || !shown()) return stopTimer()
    const at = now()
    if (stale || (botsOn() && !botsLoaded && !loadingBots) || (allProjects() && !othersLoaded && !loadingOthers)) loadAll()
    else if (safetyAt !== undefined && at >= safetyAt) loadAll()
    else if (botsDueAt !== undefined && at >= botsDueAt && !loadingBots) void loadBots().catch(() => undefined)
    arm()
  }
  let armedFor: number | undefined
  function stopTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    armedFor = undefined
  }
  /** One unreferenced timer for the next due time; none while the list is hidden or off, and a frame that changes nothing leaves it alone. */
  function arm() {
    if (!live() || !shown()) return stopTimer()
    const due = [safetyAt, botsDueAt].filter((value): value is number => value !== undefined)
    if (!due.length) return stopTimer()
    const next = Math.min(...due)
    if (timer !== undefined && armedFor === next) return
    stopTimer()
    armedFor = next
    timer = setTimeout(() => { timer = undefined; armedFor = undefined; pump() }, Math.max(0, next - now()))
    timer.unref?.()
  }

  /**
   * A `session.activity` push (events.ts, before this terminal's own list takes it). Hidden: a flag and nothing else. Shown: the list of
   * the other folders and the bots' states take it in place; only a session no list held may be a bot's new chat and asks for the bot list.
   */
  function onActivity(event: ActivityEvent) {
    if (!live()) return
    if (!shown()) { stale = true; stopTimer(); return }
    const held = state.sessions.find((session) => session.sessionId === event.sessionId) ?? others.find((session) => session.sessionId === event.sessionId)
    if (allProjects()) others = mergeActivity(others, event, { cap: PUSHED_MAX, keep: state.sessionId })
    if (!botsOn() || !report) return
    if (botOfSession.has(event.sessionId)) {
      const next = patchBotReport(report, event)
      if (next) report = next
    } else if (!held && !classified.has(event.sessionId)) {
      unknown.add(event.sessionId)
      wantBots()
    }
  }

  /** The connection came back: events may have been missed, so the next pass asks for both lists whole. */
  function resync() {
    if (!live()) return
    stale = true
    if (shown()) pump()
  }

  /** The sessions the list knows: this terminal's own list, then the other folders' that the all-projects request brought. */
  function sessions(): SessionSummary[] {
    if (!allProjects()) return state.sessions
    const known = new Set(state.sessions.map((session) => session.sessionId))
    return [...state.sessions, ...others.filter((session) => !known.has(session.sessionId))]
  }

  /** The folder whose group starts open: the open session's, else the one this terminal was started in. */
  const openedDirectory = () => state.sessions.find((session) => session.sessionId === state.sessionId)?.directory ?? input.directory ?? ""

  /** Whether a working sub-agent holds the plain left/right arrows: a child of this session, or a sibling of it, that works or waits. */
  function holdsArrows(): boolean {
    const all = sessions()
    const parent = all.find((session) => session.sessionId === state.sessionId)?.parentId
    return all.some((session) => (session.parentId === state.sessionId || (parent !== undefined && session.parentId === parent && session.sessionId !== state.sessionId)) && ["running", "approval"].includes(sessionMark(session as never, false)))
  }

  /** The sessions this terminal has had open in the last day, with the activity each had when first opened (view/sidebar-multi.ts keeps those that took part since from the empty-session rule). */
  const visits = new Map<string, { at: number; updatedAt: number }>()
  function noteVisit(): ReadonlyMap<string, { at: number; updatedAt: number }> {
    const at = now()
    const id = state.sessionId
    if (id) {
      const seen = visits.get(id)
      const summary = sessions().find((session) => session.sessionId === id)
      visits.set(id, { at, updatedAt: seen?.updatedAt ?? summary?.updatedAt ?? 0 })
    }
    if (visits.size > 200) for (const [key, visit] of visits) if (at - visit.at > FRESH_MS) visits.delete(key)
    return visits
  }

  function model(over: Partial<MultiInput> & { height: number; icons: boolean }): MultiInput {
    return {
      sessions: sessions() as never,
      current: state.sessionId,
      directory: openedDirectory(),
      ...(state.sidebarFocus && state.sidebarSelected ? { selected: state.sidebarSelected } : {}),
      focused: state.sidebarFocus === true,
      now: now(),
      ...(botsOn() && report ? { bots: report } : {}),
      // Without the flag the bots-only sections and layouts have nothing to show: the list is the projects alone.
      sections: botsOn() ? sidebarSectionsOf(state.tuiProfile) : ["projects"],
      scope: allProjects() ? "all" : "folder",
      open,
      previewCount: state.tuiProfile.sidebarPreviewCount,
      expanded,
      projects: { isProject: probe.isProject, eligible: probe.eligible, canonical: probe.canonical, count: state.tuiProfile.sidebarProjectCount },
      visits: noteVisit(),
      projectsExpanded,
      ...over,
    }
  }

  function draw(options: { height: number; icons: boolean; unread: readonly string[]; spinner?: string; blink?: boolean; ascii: boolean; header: boolean }): { lines: Line[]; hits: Array<{ row: number; id: string }>; images: ImagePlacement[] } {
    iconsNow = options.icons
    // First show, a show after pushes came while hidden, a flag turned on after this was made, the slow safety refresh: whatever is due.
    pump()
    // The bots' pictures: only with the flag on, bots listed and an image layer; the face modules load on that first frame, the glyphs hold until then.
    if (botsOn() && report?.bots.length && layerOn()) void loadFaces()
    const faces = botsOn() && !options.ascii ? iconFaces() : undefined
    const drawn = renderMultiSidebar(model({ ...options, ...(faces ? { faces } : {}) }))
    return { lines: drawn.rows, hits: drawn.hits, images: drawn.images }
  }

  /** The ids the keyboard stops on, as the last frame drew them. */
  const stops = () => multiStops(model({ height: 0, icons: iconsNow }))
  /** The first row of every section drawn, for Tab and Shift+Tab. */
  const sectionStarts = () => multiSectionStarts(model({ height: 0, icons: iconsNow }))
  /** The first bot's row, which `b` jumps to; undefined while no bot is listed. */
  const firstBot = () => stops().find(isBotId)

  function toggleGroup(id: string) {
    const directory = groupDirectory(id)
    open.set(directory, !(open.get(directory) ?? true))
    requestFrame()
  }

  function toggleMore(id: string) {
    const directory = moreDirectory(id)
    if (!expanded.delete(directory)) expanded.add(directory)
    requestFrame()
  }

  /** Whether the bot's chats show now: the user's fold or open, else open only while the open session is one of them. */
  function botChatsOpen(name: string): boolean {
    const chosen = open.get(botKey(name))
    if (chosen !== undefined) return chosen
    const bot = report?.bots.find((candidate) => candidate.name === name)
    return bot?.projects.some((project) => project.sessions.some((session) => session.sessionId === state.sessionId)) === true || sessions().some((session) => session.sessionId === state.sessionId && session.agent === name)
  }
  function toggleBotChats(name: string) {
    open.set(botKey(name), !botChatsOpen(name))
    requestFrame()
  }
  function toggleBotMore(name: string) {
    const key = botKey(name)
    if (!expanded.delete(key)) expanded.add(key)
    requestFrame()
  }

  /** Enter or a click on a row: a group folds or opens, the more row opens or closes a project's whole list, a bot starts a new chat with it, a session opens. */
  async function activate(id: string, deps: SidebarDeps) {
    if (isGroupId(id)) return toggleGroup(id)
    if (isMoreProjectsId(id)) { projectsExpanded = !projectsExpanded; return requestFrame() }
    if (isMoreId(id)) return toggleMore(id)
    if (isBotChatsId(id)) return toggleBotChats(botChatsName(id))
    if (isBotMoreId(id)) return toggleBotMore(botMoreName(id))
    if (isBotId(id)) return startChat(botName(id), deps)
    state.sidebarFocus = false
    await deps.switchSession(id as SessionId)
  }

  /** `o` on a bot row: its page (chats by folder, edit, memory, delete). */
  async function openPage(id: string, deps: SidebarDeps) {
    if (isBotId(id)) await openBot(botName(id), deps)
  }

  /**
   * A blank chat in `directory`, the one `/new` opens, marked to take the bot as its agent when its first message goes (input.ts).
   * Until then the daemon lists nothing for it, and no bot or project shows an untitled row. The id, or undefined after saying why not.
   */
  async function createBotSession(name: string, directory: string): Promise<SessionId | undefined> {
    const created = await input.send({ type: "session.create", directory, title: "", reuseEmpty: true })
    const sessionId = created.ok ? created.result?.sessionId : undefined
    if (typeof sessionId !== "string") return void fail(created.ok ? "the session was not created" : created.error.message)
    state.pendingBot = { sessionId: sessionId as SessionId, name }
    return sessionId as SessionId
  }

  /** Enter or a click on a bot: a new chat with it in the folder MendCode is opened in, shown right away. */
  async function startChat(name: string, deps: SidebarDeps) {
    state.sidebarFocus = false
    const directory = openedDirectory()
    if (!directory) return say("no folder is open to start the chat in", "warning")
    const sessionId = await createBotSession(name, directory)
    if (!sessionId) return
    await deps.switchSession(sessionId)
    startNewChatPanel(ctx)
  }

  async function openBot(name: string, deps: SidebarDeps) {
    state.sidebarFocus = false
    await loadBots()
    const bot = report?.bots.find((candidate) => candidate.name === name)
    if (!bot) return say(`no bot named ${name} · /bot list shows them`, "warning")
    const { createBotCard, foldersFor } = await import("../../view/bot-card-page")
    await loadFaces()
    const avatarKey = ensureAvatar(bot)
    state.botCard?.stop()
    const close = () => { card.stop(); if (state.botCard === card) state.botCard = undefined; state.page = "chat"; requestFrame() }
    const card = createBotCard({
      face: {
        capability: () => capability(avatarKey ? avatars.get(avatarKey) : undefined) ?? {},
        onFrame: requestFrame,
        reducedMotion: () => state.reducedMotion,
      },
      bot,
      folders: foldersFor(bot, [...new Set(sessions().map((session) => session.directory))]),
      actions: {
        redraw: requestFrame,
        close,
        async openSession(sessionId) {
          close()
          await deps.switchSession(sessionId as SessionId)
        },
        async newSession(directory) {
          const sessionId = await createBotSession(bot.name, directory)
          if (!sessionId) return
          close()
          await deps.switchSession(sessionId)
          startNewChatPanel(ctx)
        },
        async edit() {
          await (await import("./bots")).runBotCommand(ctx, `edit ${bot.name}`, { from: "bot" })
          requestFrame()
        },
        async delete() {
          await (await import("./bots")).runBotCommand(ctx, `delete ${bot.name}`, { from: "bot" })
          requestFrame()
        },
        async memory() {
          state.textReturn = "bot"
          await (await import("./bots")).runBotCommand(ctx, `memory ${bot.name}`)
        },
      },
    })
    state.botCard = card
    state.page = "bot"
    requestFrame()
  }

  /** `/bot open <name>`: the bot's page, from anywhere. */
  const openNamed = (name: string, deps: SidebarDeps) => openBot(name, deps)

  return { live, sessions, draw, stops, sectionStarts, firstBot, activate, openPage, openNamed, isBot: isBotId, holdsArrows, onActivity, resync, noteActivity: () => wantBots(false) }
}
