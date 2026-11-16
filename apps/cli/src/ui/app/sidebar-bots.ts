import type { BotListReport, SessionId, SessionSummary } from "@mendcode/protocol"
import { botName, groupDirectory, isBotId, isGroupId, isMoreId, isMoreProjectsId, moreDirectory, multiStops, renderMultiSidebar, type MultiInput } from "../../view/sidebar-multi"
import { createProjectProbe, eligibleDirectory, type ProjectInspection } from "../../view/sidebar-projects"
import { sessionMark } from "../../view/sidebar"
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

/**
 * The left list when bots are on (docs/agents.md) or every project is asked for: it asks for the bots and for the other folders'
 * sessions, draws `view/sidebar-multi.ts`, folds the groups, and opens a bot's page. Loaded by the first frame that needs it
 * (chrome.ts), never at start; with the flag off and one folder in the list nothing here ever loads.
 */
export type SidebarBots = ReturnType<typeof createSidebarBots>

/** The most a refresh is asked for: bursts of activity pushes make one request. */
const REFRESH_MS = 2000
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
  let botsAt = Number.NEGATIVE_INFINITY
  let othersAt = Number.NEGATIVE_INFINITY
  let asking = false
  let iconsNow = false
  /** The `+ N more projects` row was opened; kept in memory only. */
  let projectsExpanded = false
  const home = env.HOME ?? homedir()
  const tmpRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  /** The folders that are projects, asked of the disk once each and off the render path; a remote terminal has no local disk to ask. */
  const probe = input.remote
    ? { isProject: (directory: string) => eligibleDirectory({ directory, home, tmpRoots }), canonical: (directory: string) => directory }
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
    botsAt = now()
    if (!botsOn() || input.remote) return
    const reply = await input.send({ type: "bot.list" })
    if (reply.ok) report = reply.result as BotListReport
    requestFrame()
  }
  async function loadOthers() {
    othersAt = now()
    if (!allProjects()) return
    const reply = await input.send({ type: "session.list", limit: ALL_LIMIT, hideEmpty: true })
    if (reply.ok) others = (reply.result?.sessions as SessionSummary[] | undefined) ?? []
    requestFrame()
  }
  /** Asks again for whatever is stale, at most once per `REFRESH_MS`. */
  function refresh() {
    if (asking) return
    const stale = (at: number) => now() - at >= REFRESH_MS
    if (!(botsOn() && stale(botsAt)) && !(allProjects() && stale(othersAt))) return
    asking = true
    void Promise.all([botsOn() && stale(botsAt) ? loadBots() : undefined, allProjects() && stale(othersAt) ? loadOthers() : undefined]).catch(() => undefined).finally(() => { asking = false })
  }
  void loadBots().catch(() => undefined)
  void loadOthers().catch(() => undefined)

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
      projects: { isProject: probe.isProject, canonical: probe.canonical, count: state.tuiProfile.sidebarProjectCount },
      projectsExpanded,
      ...over,
    }
  }

  function draw(options: { height: number; icons: boolean; unread: readonly string[]; spinner?: string; blink?: boolean; ascii: boolean; header: boolean }): { lines: Line[]; hits: Array<{ row: number; id: string }>; images: ImagePlacement[] } {
    iconsNow = options.icons
    // Turned on after this was made, or the first answer never came: ask again (throttled).
    if ((botsOn() && !report) || (allProjects() && !others.length)) refresh()
    // The bots' pictures: only with the flag on, bots listed and an image layer; the face modules load on that first frame, the glyphs hold until then.
    if (botsOn() && report?.bots.length && layerOn()) void loadFaces()
    const faces = botsOn() && !options.ascii ? iconFaces() : undefined
    const drawn = renderMultiSidebar(model({ ...options, ...(faces ? { faces } : {}) }))
    return { lines: drawn.rows, hits: drawn.hits, images: drawn.images }
  }

  /** The ids the keyboard stops on, as the last frame drew them. */
  const stops = () => multiStops(model({ height: 0, icons: iconsNow }))

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

  /** Enter or a click on a row: a group folds or opens, the more row opens or closes a project's whole list, a bot opens its page, a session opens. */
  async function activate(id: string, deps: SidebarDeps) {
    if (isGroupId(id)) return toggleGroup(id)
    if (isMoreProjectsId(id)) { projectsExpanded = !projectsExpanded; return requestFrame() }
    if (isMoreId(id)) return toggleMore(id)
    if (isBotId(id)) return openBot(botName(id), deps)
    state.sidebarFocus = false
    await deps.switchSession(id as SessionId)
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
          const created = await input.send({ type: "session.create", directory, title: "", agent: bot.name })
          const sessionId = created.ok ? created.result?.sessionId : undefined
          if (typeof sessionId !== "string") return fail(created.ok ? "the session was not created" : created.error.message)
          const set = await input.send({ type: "session.agent.set", sessionId: sessionId as SessionId, agent: bot.name })
          if (!set.ok) return fail(set.error.message)
          close()
          await deps.switchSession(sessionId as SessionId)
          botsAt = Number.NEGATIVE_INFINITY
          refresh()
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

  return { live, sessions, draw, stops, activate, holdsArrows, noteActivity: refresh }
}
