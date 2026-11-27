import type { BotListReport, ExternalBotInfo, SessionId, SessionSummary } from "@mendcode/protocol"
import { botChatsName, botKey, botMoreName, botName, externalActivityOf, externalBotOf, groupDirectory, hostKey, isBotChatsId, isBotId, isBotMoreId, isExternalActivityId, isExternalBotId, isExternalGroupId, isGroupId, externalBotId, isMoreId, isMoreProjectsId, isNewChatId, moreDirectory, multiFoldState, multiSectionStarts, multiStops, renderMultiSidebar, REVEAL_PAGE, type MultiInput, type SidebarHold } from "../../view/sidebar-multi"
import { createProjectProbe, eligibleDirectory, FRESH_MS, type ProjectInspection } from "../../view/sidebar-projects"
import { markAnimates, restingWorkflow, sessionMark, sidebarKind, waitsOnYou } from "../../view/sidebar"
import { botIndex, patchBotReport } from "../../view/bot-live"
import { mergeActivity, type ActivityEvent } from "../../view/session-activity"
import { sessionOrderAt } from "../../view/session-label"
import { sidebarListsAll, sidebarSectionsOf } from "../../view/tui-profile"
import { readFile, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import type { TuiProfile } from "../../view/tui-profile"
import { MAX_HIDDEN_PROJECTS } from "../../view/tui-profile"
import type { PetImage } from "../../pets/decode"
import type { FaceCapability } from "../../view/bot-face"
import type { BotColor, BotShape, IconFaces } from "../../view/bot-icon"
import type { ImagePlacement } from "../image-layer"
import { activeTheme, colorDepth, type Line } from "../theme"
import { askBotList } from "./bot-list-ask"
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
const DURING_MAX = 200
/** The pushed sessions a list keeps (the cap `events.ts` gives this terminal's own list). */
const PUSHED_MAX = 500
/** Sessions known not to belong to a bot, so a busy old session does not ask for the list again at every push. */
const CLASSIFIED_MAX = 2000
/** How many sessions of every folder the all-projects list asks for. */
const ALL_LIMIT = 200
/** The list holds still this long after the pointer or the selection left it. */
const HOLD_AFTER_MS = 2000
/** A pointer resting on the list without a report for this long no longer holds it (a terminal that reports no motion never says it left). */
const HOLD_IDLE_MS = 60_000

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
  /** How many hidden rows each folder's (or bot's) more row has revealed, a page per press; kept in memory only. */
  const revealed = new Map<string, number>()
  /** Each project's rank time, so a streaming turn or an opened chat does not reshuffle the project list (see `rankProjects`). */
  const rankStamps = new Map<string, number>()
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
  /** A chat was deleted while a bot list was being asked for: the answer may still hold it, so the list is asked again. */
  let removedWhileLoading = false
  /** Pushes that came while a bot list was being asked for, in order (at most `DURING_MAX`): the answer may predate them. */
  const during: ActivityEvent[] = []
  let loadingOthers = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let iconsNow = false
  /** How many projects past the cap the `+ N more projects` row has revealed, a page per press; kept in memory only. */
  let projectsRevealed = 0
  const home = env.HOME ?? homedir()
  const tmpRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  /** The folders that are projects, asked of the disk once each and off the render path; a remote terminal has no local disk to ask. */
  const probe = input.remote
    ? { isProject: (directory: string) => eligibleDirectory({ directory, home, tmpRoots }), eligible: (directory: string) => eligibleDirectory({ directory, home, tmpRoots }), canonical: (directory: string) => directory }
    : createProjectProbe({ home, tmpRoots, inspect: input.inspectProject ?? inspectOnDisk, onChange: () => { release(); requestFrame() } })

  /**
   * The list holds still (docs/sidebar.md "A list that holds still"): while the selection is in it, while the pointer is over it, and
   * `HOLD_AFTER_MS` after either left, the rows drawn keep their places and no row joins or leaves. What each row shows still moves
   * (its mark, title, age, counts). The user's own acts on the list (a fold, a more row, a new chat, `r`) take the list as it is now.
   */
  const hold: SidebarHold = {}
  let pointerInside = false
  let pointerAt = Number.NEGATIVE_INFINITY
  let leftAt = Number.NEGATIVE_INFINITY
  let wasFocused = false
  let thawTimer: ReturnType<typeof setTimeout> | undefined
  /** A mouse report: over the list or not. */
  function pointer(inside: boolean) {
    const at = now()
    if (inside) { pointerInside = true; pointerAt = at }
    else if (pointerInside) {
      pointerInside = false
      leftAt = Math.max(leftAt, at)
      // No frame follows a pointer that only moved away: the timer that ends the hold is set from here.
      if (hold.behind) armThaw()
    }
  }
  /** Until when the list holds: forever while the selection is in it, undefined when nothing holds it. */
  function heldUntil(): number | undefined {
    const at = now()
    const focused = state.sidebarFocus === true
    if (wasFocused && !focused) leftAt = Math.max(leftAt, at)
    wasFocused = focused
    if (focused) return Number.POSITIVE_INFINITY
    const until = Math.max(pointerInside ? pointerAt + HOLD_IDLE_MS : Number.NEGATIVE_INFINITY, leftAt + HOLD_AFTER_MS)
    return until > at ? until : undefined
  }
  /** The next build takes the list as it is now (and holds that, if something still holds it). */
  function release() {
    hold.rows = undefined
    hold.behind = false
  }
  /** `r` in the list: the list as it is now, and both lists asked again. */
  function refresh() {
    release()
    stale = true
    pump()
    requestFrame()
  }
  /** One unreferenced timer, only while a held list is behind: it draws the list again when the hold ends. */
  function armThaw() {
    const until = heldUntil()
    if (thawTimer !== undefined) clearTimeout(thawTimer)
    thawTimer = undefined
    if (!hold.behind || until === undefined || until === Number.POSITIVE_INFINITY) return
    thawTimer = setTimeout(() => { thawTimer = undefined; requestFrame() }, Math.max(0, until - now()) + 1)
    thawTimer.unref?.()
  }

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
    during.length = 0
    try {
      const reply = await askBotList(input)
      if (reply.ok) {
        report = reply.result as BotListReport
        // The answer is older than the pushes that came while it was on its way: they move the new report as they moved the old one.
        for (const event of during) report = patchBotReport(report, event, now()) ?? report
        botOfSession = botIndex(report)
        for (const id of unknown) if (!botOfSession.has(id)) classified.add(id)
        unknown.clear()
        while (classified.size > CLASSIFIED_MAX) classified.delete(classified.values().next().value!)
      }
    } finally { loadingBots = false; during.length = 0 }
    if (removedWhileLoading) { removedWhileLoading = false; if (shown()) wantBots(); else stale = true }
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
  /** Both lists whole; the slow safety refresh is pushed back from here. A first or overdue load (`fresh`) is the list itself arriving, so a held list takes it; the slow refresh leaves a held list as it is. */
  function loadAll(fresh = true) {
    stale = false
    safetyAt = now() + SAFETY_MS + ctx.random() * JITTER_MS
    void Promise.all([botsOn() ? loadBots() : undefined, allProjects() ? loadOthers() : undefined]).then(() => { if (fresh) { release(); requestFrame() } }).catch(() => undefined)
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
    else if (safetyAt !== undefined && at >= safetyAt) loadAll(false)
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
    if (botsOn() && loadingBots && during.length < DURING_MAX) during.push(event)
    if (!botsOn() || !report) return
    if (botOfSession.has(event.sessionId)) {
      const next = patchBotReport(report, event, now())
      if (next) report = next
    } else if (!held && !classified.has(event.sessionId)) {
      unknown.add(event.sessionId)
      wantBots()
    }
  }

  /** A session was deleted (anywhere): it leaves the other folders' list at once, and the bot list is asked again when it was a bot's chat. */
  function onRemoved(sessionId: string) {
    if (!live()) return
    others = others.filter((session) => session.sessionId !== sessionId)
    if (!botsOn()) return
    // A list on its way may still hold the chat, and a first one has no mapping yet: it is asked again once it has arrived.
    if (loadingBots) removedWhileLoading = true
    if (botOfSession.delete(sessionId)) { if (shown()) wantBots(); else stale = true }
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

  /**
   * Whether a row this list draws moves on the activity tick: a session of any folder it lists running (sub-agents included) or waiting
   * for you, or a bot's chat doing so. The other folders' sessions live only here, not in the terminal's own list.
   */
  function moving(): boolean {
    if (!live() || !shown()) return false
    const works = (session: SessionSummary) => !restingWorkflow(session) && markAnimates(sessionMark(session as never, false))
    if (allProjects() && others.some(works)) return true
    if (!botsOn() || !report) return false
    const chatWorks = (bot: { projects?: BotListReport["bots"][number]["projects"] | undefined }) => bot.projects?.some((project) => project.sessions.some((chat) => chat.status === "running" || chat.status === "waiting_approval" || chat.status === "waiting_for_input")) === true
    return report.bots.some(chatWorks) || report.external.some(chatWorks)
  }

  /** The folder whose group starts open: the open session's, else the one this terminal was started in. */
  const openedDirectory = () => state.sessions.find((session) => session.sessionId === state.sessionId)?.directory ?? input.directory ?? ""

  /** Whether a working sub-agent holds the plain left/right arrows: a child of this session, or a sibling of it, that works or waits. */
  function holdsArrows(): boolean {
    const all = sessions()
    const parent = all.find((session) => session.sessionId === state.sessionId)?.parentId
    return all.some((session) => (session.parentId === state.sessionId || (parent !== undefined && session.parentId === parent && session.sessionId !== state.sessionId)) && (mark => mark === "running" || waitsOnYou(mark))(sessionMark(session as never, false)))
  }

  /**
   * Chats this terminal started with a bot, by session id: the bot's name, or an external bot's row id. They sit under the bot from the
   * first frame that lists them (never under Projects), before any pushed summary or bot list says so. Starting one never opens a
   * folded `chats` row: the row carries the open chat's bar instead.
   */
  const chatHosts = new Map<string, string>()
  /** The newest blank chat this terminal opened for a bot in a folder (by bot and folder), while it may still hold an unsent message. */
  const unsentBotChats = new Map<string, SessionId>()
  function noteChat(sessionId: string, host: string) {
    chatHosts.set(sessionId, host)
    if (chatHosts.size > CLASSIFIED_MAX) chatHosts.delete(chatHosts.keys().next().value!)
  }

  /** Whose chat a session is, with the look its bot carries (a MendCode bot's identity, or the generated one of an external bot); undefined for any other session. */
  function chatLook(sessionId: string): { name: string; shape?: BotShape | undefined; color?: BotColor | undefined } | undefined {
    if (!botsOn() || !report) return undefined
    const session = sessions().find((candidate) => candidate.sessionId === sessionId)
    const named = chatHosts.get(sessionId) ?? botOfSession.get(sessionId) ?? (session?.agent !== undefined && report.bots.some((bot) => bot.name === session.agent) ? session.agent : undefined)
    const bot = named === undefined ? undefined : report.bots.find((candidate) => candidate.name === named)
    if (bot) return { name: bot.name, shape: bot.identity.shape, color: bot.identity.color }
    const external = report.external.find((candidate) => externalBotId(candidate) === named || (session?.model !== undefined && candidate.chat === session.model.model) || candidate.projects?.some((project) => project.sessions.some((member) => member.sessionId === sessionId)))
    return external ? { name: external.name, shape: external.identity?.shape, color: external.identity?.color } : undefined
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

  /** What the held rows were built for: another profile, flag or shape of the list is another list, taken as it is. */
  let heldFor: unknown[] = []
  function model(over: Partial<MultiInput> & { height: number; icons: boolean }): MultiInput {
    if (heldUntil() === undefined) release()
    return {
      ...(heldUntil() !== undefined ? { hold } : {}),
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
      recentDays: state.tuiProfile.sidebarRecentDays,
      rankStamps,
      revealed,
      // Remembered ownership only places chats under a Bots section; without the flag there is none, so the chats stay under Projects.
      ...(botsOn() ? { chatBots: chatHosts } : {}),
      projects: { isProject: probe.isProject, eligible: probe.eligible, canonical: probe.canonical, count: state.tuiProfile.sidebarProjectCount, from: state.tuiProfile.sidebarProjectsFrom, hidden: hiddenSet() },
      visits: noteVisit(),
      projectsRevealed,
      ...over,
    }
  }

  function draw(options: { height: number; icons: boolean; unread: readonly string[]; spinner?: string; blink?: boolean; ascii: boolean; header: boolean; scroll?: import("../../view/sidebar-window").SidebarScroll }): { lines: Line[]; hits: Array<{ row: number; id: string; fold?: { from: number; to: number }; plus?: { from: number; to: number } }>; images: ImagePlacement[] } {
    iconsNow = options.icons
    lastFrame = { height: options.height, header: options.header }
    const shape = [state.tuiProfile, botsOn(), options.icons, options.height, options.header, options.ascii]
    if (shape.some((part, at) => part !== heldFor[at])) { heldFor = shape; release() }
    // First show, a show after pushes came while hidden, a flag turned on after this was made, the slow safety refresh: whatever is due.
    pump()
    // The bots' pictures: only with the flag on, bots listed and an image layer; the face modules load on that first frame, the glyphs hold until then.
    if (botsOn() && report?.bots.length && layerOn()) void loadFaces()
    const faces = botsOn() && !options.ascii ? iconFaces() : undefined
    const drawn = renderMultiSidebar(model({ ...options, ...(faces ? { faces } : {}) }))
    armThaw()
    return { lines: drawn.rows, hits: drawn.hits, images: drawn.images }
  }

  /** The height and header of the last frame: the automatic project count depends on both, so the keyboard lists what that frame drew. */
  let lastFrame: { height: number; header: boolean } | undefined
  const drawnModel = () => model({ height: lastFrame?.height ?? Number.MAX_SAFE_INTEGER, icons: iconsNow, ...(lastFrame ? { header: lastFrame.header } : {}) })
  /** The ids the keyboard stops on, as the last frame drew them. */
  const stops = () => multiStops(drawnModel())
  /** The first row of every section drawn, for Tab and Shift+Tab. */
  const sectionStarts = () => multiSectionStarts(drawnModel())
  /** The first bot's row, which `b` jumps to; undefined while no bot is listed. */
  const firstBot = () => stops().find(isBotId)

  /**
   * A more row: reveals one more page and puts the cursor on the first row that appeared (the one right after where the list
   * stopped). When the page shows nothing new the list was whole, so the row (`show less`/`show fewer`) folds it back instead.
   */
  function pageMore({ bump, reset }: { bump(): void; reset(): void }) {
    const before = new Set(stops())
    bump()
    release()
    const fresh = stops().find((id) => !before.has(id))
    if (fresh) state.sidebarSelected = fresh
    else { reset(); release() }
    requestFrame()
  }
  const pageOf = (key: string) => pageMore({ bump: () => revealed.set(key, (revealed.get(key) ?? 0) + REVEAL_PAGE), reset: () => revealed.delete(key) })
  const toggleMore = (id: string) => pageOf(moreDirectory(id))

  /** Whether a row folds and how it is drawn now (a group, a bot's chats, a bot of whom the chats are asked); undefined for any other row. */
  const foldState = (id: string) => multiFoldState(drawnModel(), id)
  /** Space, `←`/`→` on a header and a click on its arrow: folds an open header, opens a folded one. */
  function toggleFold(id: string) {
    const current = foldState(id)
    if (!current) return
    if (isGroupId(id)) open.set(groupDirectory(id), current !== "open")
    else open.set(isBotId(id) ? botKey(botName(id)) : isBotChatsId(id) ? hostKey(botChatsName(id)) : id, current !== "open")
    release()
    requestFrame()
  }
  const toggleBotMore = (name: string) => pageOf(hostKey(name))

  /**
   * Enter or a click on a row: a header (a project, a bot, its chats row, another app's bots) folds or opens and starts nothing, a more
   * row reveals a page, the `+ New chat…` row opens the folder picker, a row of what a bot does in its own app opens it to read, a
   * session opens. A chat is started only by `newChat` (the `+` that ends a row, or `n`).
   */
  async function activate(id: string, deps: SidebarDeps) {
    if (isNewChatId(id)) return pickFolder(undefined, deps)
    if (isMoreProjectsId(id)) return pageMore({ bump: () => { projectsRevealed += REVEAL_PAGE }, reset: () => { projectsRevealed = 0 } })
    if (isMoreId(id)) return toggleMore(id)
    if (isBotMoreId(id)) return toggleBotMore(botMoreName(id))
    if (isGroupId(id) || isExternalGroupId(id) || isBotChatsId(id) || isBotId(id) || isExternalBotId(id)) return toggleFold(id)
    if (isExternalActivityId(id)) return openActivity(id)
    state.sidebarFocus = false
    await deps.switchSession(id as SessionId)
  }

  /** The bot a row belongs to: a bot's own row, its chats row, or one of its chats. The name of a MendCode bot or the row id of another app's. */
  function hostOfRow(id: string): string | undefined {
    if (isBotId(id)) return botName(id)
    if (isExternalBotId(id)) return id
    if (isBotChatsId(id)) return botChatsName(id)
    if (isBotMoreId(id)) return botMoreName(id)
    if (isGroupId(id) || isMoreId(id) || isMoreProjectsId(id) || isNewChatId(id) || isExternalGroupId(id) || isExternalActivityId(id)) return undefined
    const session = sessions().find((candidate) => candidate.sessionId === id)
    const named = chatHosts.get(id) ?? botOfSession.get(id) ?? (session?.agent !== undefined && report?.bots.some((bot) => bot.name === session.agent) ? session.agent : undefined)
    if (named !== undefined) return named
    const external = report?.external.find((candidate) => (session?.model !== undefined && candidate.chat === session.model.model) || candidate.projects?.some((project) => project.sessions.some((member) => member.sessionId === id)))
    return external ? externalBotId(external) : undefined
  }

  /**
   * `n` on a row, or a click on the `+` that ends it: a new chat where the row says. A project (or one of its sessions) starts it in
   * that folder at once; a bot (or one of its chats) asks for the folder first, the open one on top, so Enter twice is a chat with
   * the bot right here; any other row asks for the folder of a plain chat.
   */
  async function newChat(id: string, deps: SidebarDeps) {
    if (isGroupId(id)) return startFolderChat(groupDirectory(id), deps)
    if (isMoreId(id)) return startFolderChat(moreDirectory(id), deps)
    const host = hostOfRow(id)
    if (host !== undefined) return pickFolder(host, deps)
    const session = isNewChatId(id) || isMoreProjectsId(id) || isExternalGroupId(id) || isExternalActivityId(id) ? undefined : sessions().find((candidate) => candidate.sessionId === id)
    if (session) return startFolderChat(session.directory, deps)
    return pickFolder(undefined, deps)
  }
  const openedCanonical = () => probe.canonical(openedDirectory())

  /** The folders a new chat can start in without typing: the open one, then every folder with a session, the one a person wrote in last first. */
  function knownFolders(): string[] {
    const latest = new Map<string, number>()
    for (const session of sessions()) {
      if (session.archivedAt !== undefined || !probe.eligible(session.directory)) continue
      const directory = probe.canonical(session.directory)
      if (hiddenSet().has(directory)) continue
      latest.set(directory, Math.max(latest.get(directory) ?? 0, sessionOrderAt(session)))
    }
    const opened = openedDirectory()
    const ranked = [...latest].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([directory]) => directory).filter((directory) => directory !== opened && directory !== openedCanonical())
    return [...(opened ? [opened] : []), ...ranked]
  }

  /** The "New chat in…" picker over the list (ui/app/new-chat-picker.ts), loaded by its first use; `host` makes it "Chat with <bot> in…". */
  async function pickFolder(host: string | undefined, deps: SidebarDeps) {
    const external = host !== undefined && isExternalBotId(host) ? externalOf(host) : undefined
    if (host !== undefined && isExternalBotId(host) && !external) return say("that bot is gone from the list · /bot list shows them", "warning")
    if (external && !external.chat) return say(`${external.name} cannot be chatted with from here`, "warning")
    state.sidebarPicker ??= (await import("./new-chat-picker")).createNewChatPicker(ctx)
    state.sidebarPicker.show({
      title: host === undefined ? "New chat in…" : `Chat with ${external?.name ?? host} in…`,
      folders: knownFolders(),
      base: openedDirectory() || home,
      home,
      remote: Boolean(input.remote),
      // Asked only when a listed folder is not on this machine: the hub whose project it is, for the mark beside it.
      async hubName() {
        const reply = await input.send({ type: "sync.control", input: { action: "status" } })
        const status = reply.ok ? reply.result as { mode?: unknown; remote?: unknown } | undefined : undefined
        return status?.mode === "device" && typeof status.remote === "string" ? status.remote : undefined
      },
      async start(directory) {
        release()
        if (host === undefined) return startFolderChat(directory, deps)
        state.sidebarFocus = false
        const sessionId = external ? await createExternalSession(external, directory) : await createBotSession(host, directory)
        if (!sessionId) return
        await deps.switchSession(sessionId)
        startNewChatPanel(ctx)
      },
    })
    requestFrame()
  }

  /** A row of what a bot does in its own app: that session's messages, to read (ui/app/bot-activity.ts, loaded by the first one opened). */
  async function openActivity(id: string) {
    const named = externalActivityOf(id)
    const bot = named ? report?.external.find((candidate) => candidate.origin === named.origin && candidate.id === named.bot) : undefined
    if (!named || !bot) return say("that bot is gone from the list · /bot list shows them", "warning")
    state.sidebarFocus = false
    await (await import("./bot-activity")).openBotActivity(ctx, { bot, session: named.session, known: bot.activity?.find((running) => running.id === named.session) })
  }

  /** The profile's hidden folders as a set, rebuilt only when the list changes (a frame never builds it). */
  let hiddenFrom: readonly string[] | undefined
  let hiddenNow: ReadonlySet<string> = new Set()
  function hiddenSet(): ReadonlySet<string> {
    if (hiddenFrom !== state.tuiProfile.sidebarHiddenProjects) { hiddenFrom = state.tuiProfile.sidebarHiddenProjects; hiddenNow = new Set(hiddenFrom) }
    return hiddenNow
  }

  /** `x` on a project's row: hides that folder (reversible in /customize › Hidden projects). The opened project always shows, so it is refused. */
  function hideProject(id: string, deps: { changeProfile(patch: Partial<TuiProfile>): void }) {
    if (!isGroupId(id)) return
    const directory = groupDirectory(id)
    const name = basename(directory) || directory
    if (directory === openedDirectory()) return say(`${name} is open: it always shows`, "info")
    const kept = state.tuiProfile.sidebarHiddenProjects.filter((hidden) => hidden !== directory)
    deps.changeProfile({ sidebarHiddenProjects: [...kept, directory].slice(-MAX_HIDDEN_PROJECTS) })
    say(`hid ${name} · /customize to bring it back`, "info")
    requestFrame()
  }

  /** `o` on a bot row: its page (chats by folder, edit, memory, delete). */
  async function openPage(id: string, deps: SidebarDeps) {
    if (isBotId(id)) await openBot(botName(id), deps)
    else if (isExternalBotId(id)) await openExternal(id, deps)
  }

  /** The bot of another app a row names, from the last list. */
  function externalOf(id: string) {
    const named = externalBotOf(id)
    return named ? report?.external.find((bot) => bot.origin === named.origin && bot.id === named.id) : undefined
  }

  /**
   * A blank chat in `directory` on the model that reaches the external bot (an ordinary session; the connector's engine carries the turns).
   * It is made as the blank chat of `/new` is (`reuseEmpty`), so one left without a message is never listed as an untitled session, and
   * the blank one this terminal already made for the bot in that folder is opened again instead of making another.
   */
  async function createExternalSession(bot: ExternalBotInfo, directory: string): Promise<SessionId | undefined> {
    if (!bot.chat) return void fail(`${bot.name} cannot be chatted with from here`)
    const key = `${externalBotId(bot)}\n${directory}`
    const waiting = unsentBotChats.get(key)
    const listed = waiting ? sessions().find((session) => session.sessionId === waiting) : undefined
    if (waiting && (!listed || (!listed.title && listed.state === "idle" && listed.queued === 0))) {
      const alive = await input.send({ type: "draft.get", sessionId: waiting })
      if (alive.ok) { noteChat(waiting, externalBotId(bot)); return waiting }
    }
    const created = await input.send({ type: "session.create", directory, title: "", choice: { model: bot.chat }, reuseEmpty: true })
    const sessionId = created.ok ? created.result?.sessionId : undefined
    if (typeof sessionId !== "string") return void fail(created.ok ? "the session was not created" : created.error.message)
    unsentBotChats.set(key, sessionId as SessionId)
    if (unsentBotChats.size > CLASSIFIED_MAX) unsentBotChats.delete(unsentBotChats.keys().next().value!)
    noteChat(sessionId, externalBotId(bot))
    return sessionId as SessionId
  }

  /** `o` on an external bot: its page (what it runs on, a new chat, and the app it lives in). */
  async function openExternal(id: string, deps: SidebarDeps) {
    state.sidebarFocus = false
    await loadBots()
    const external = externalOf(id)
    if (!external) return say("that bot is gone from the list · /bot list shows them", "warning")
    const { createBotCard, foldersFor } = await import("../../view/bot-card-page")
    const bot = { name: external.name, description: external.description ?? "", identity: external.identity ?? { origin: external.origin }, ...(external.model ? { model: external.model } : {}), file: "", state: external.state, projects: external.projects ?? [] }
    state.botCard?.stop()
    const close = () => { card.stop(); if (state.botCard === card) state.botCard = undefined; state.page = "chat"; requestFrame() }
    const card = createBotCard({
      bot,
      folders: foldersFor(bot, [...new Set(sessions().map((session) => session.directory))]),
      external: { app: external.app },
      actions: {
        redraw: requestFrame,
        close,
        async openSession(sessionId) {
          close()
          await deps.switchSession(sessionId as SessionId)
        },
        async newSession(directory) {
          const sessionId = await createExternalSession(external, directory)
          if (!sessionId) return
          close()
          await deps.switchSession(sessionId)
          startNewChatPanel(ctx)
        },
        async edit() {},
        async delete() {},
        async memory() {},
        ...(external.app ? { async openApp() { await openApp(external.app!) } } : {}),
      },
    })
    state.botCard = card
    state.page = "bot"
    requestFrame()
  }

  /** The daemon opens the app (`open -a` on macOS; elsewhere it says it cannot): the terminal client starts no process. */
  async function openApp(app: string) {
    const reply = await input.send({ type: "app.open", app })
    if (!reply.ok) fail(reply.error.message.replace(/^\[[A-Z]+\]: /, ""))
  }

  /**
   * A blank chat in `directory`, the one `/new` opens, marked to take the bot as its agent when its first message goes (input.ts).
   * Until then the daemon lists nothing for it, and no bot or project shows an untitled row. The id, or undefined after saying why not.
   */
  async function createBotSession(name: string, directory: string): Promise<SessionId | undefined> {
    // A blank chat with this bot that holds an unsent message is not empty to the daemon, so a new chat would be another one: the
    // user comes back to the chat they left, with the message as they left it.
    const key = `${name}\n${directory}`
    const waiting = unsentBotChats.get(key)
    if (waiting && !sessions().some((session) => session.sessionId === waiting && session.title)) {
      const held = await input.send({ type: "draft.get", sessionId: waiting })
      const draft = held.ok ? (held.result?.draft as { text?: unknown; attachments?: unknown } | undefined) : undefined
      if (draft && (typeof draft.text === "string" && draft.text.trim() !== "" || Array.isArray(draft.attachments) && draft.attachments.length > 0)) {
        state.pendingBot = { sessionId: waiting, name }
        noteChat(waiting, name)
        return waiting
      }
    }
    unsentBotChats.delete(key)
    const created = await input.send({ type: "session.create", directory, title: "", reuseEmpty: true })
    const sessionId = created.ok ? created.result?.sessionId : undefined
    if (typeof sessionId !== "string") return void fail(created.ok ? "the session was not created" : created.error.message)
    unsentBotChats.set(key, sessionId as SessionId)
    if (unsentBotChats.size > CLASSIFIED_MAX) unsentBotChats.delete(unsentBotChats.keys().next().value!)
    state.pendingBot = { sessionId: sessionId as SessionId, name }
    noteChat(sessionId, name)
    // The blank chat it reuses may be the one already open (the home screen's), so no session switch reloads the model: the row
    // under the prompt names the bot's model now.
    const model = report?.bots.find((bot) => bot.name === name)?.model
    if (model && state.sessionId === sessionId) { state.effectiveModel = { model }; requestFrame() }
    return sessionId as SessionId
  }

  /**
   * A plain new chat (`/new`, a project row) may be handed the blank chat a bot opened: it is no bot's chat any more, so the first
   * message does not give it the bot, it leaves the bot's rows, and the row under the prompt goes back to the session's own model.
   */
  async function releaseChat(sessionId: SessionId) {
    chatHosts.delete(sessionId)
    if (state.pendingBot?.sessionId !== sessionId) return
    state.pendingBot = undefined
    if (state.sessionId !== sessionId) return
    const [models, agents] = await Promise.all([input.send({ type: "models.list", sessionId }), input.send({ type: "agents.list", sessionId })])
    if (state.sessionId !== sessionId || state.pendingBot) return
    // The bot's name and accent come from the cached agent report, which named the pending bot as the session's agent: the session's own answer replaces it.
    if (agents.ok && agents.result) state.agentReport = agents.result as typeof state.agentReport
    if (models.ok && models.result) state.effectiveModel = (models.result as { effective: typeof state.effectiveModel }).effective
    requestFrame()
  }

  /** A blank chat in that folder (the one `/new` opens, reused while empty); the folder is this terminal's from then on. A folded project stays folded. */
  async function startFolderChat(directory: string, deps: SidebarDeps) {
    state.sidebarFocus = false
    release()
    const created = await input.send({ type: "session.create", directory, title: "", reuseEmpty: true })
    const sessionId = created.ok ? created.result?.sessionId : undefined
    if (typeof sessionId !== "string") return void fail(created.ok ? "the session was not created" : created.error.message)
    await releaseChat(sessionId as SessionId)
    await deps.switchSession(sessionId as SessionId)
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

  /** What the sidebar's search indexes besides this terminal's own list (ui/app/sidebar-search.ts). */
  const searchSources = () => ({ others, bots: botsOn() ? report : undefined })

  // The report is kept current only while the list is on screen (hidden, a push sets a flag and patches nothing), so no one else reads it then.
  return { live, releaseChat, report: () => (shown() ? report : undefined), sessions, searchSources, draw, stops, sectionStarts, firstBot, activate, newChat, newChatAnywhere: (deps: SidebarDeps) => pickFolder(undefined, deps), pointer, refresh, chatLook, foldState, toggleFold, openPage, hideProject, openNamed, isBot: (id: string) => isBotId(id) || isExternalBotId(id), holdsArrows, moving, onActivity, onRemoved, resync, noteActivity: () => wantBots(false) }
}
